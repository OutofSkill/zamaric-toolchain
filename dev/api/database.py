"""Bereich Datenbank der Entwicklerseite: Integrität, Dateien, Prüfsummen, Speicher, Freigaben, Cron, Nachrichten.

Alle Abfragen laufen über RPC-Funktionen der Migration dev_site. Sie prüfen
selbst, dass ein Admin aufruft, und lesen nur. Gelöscht wird nur über
POST /api/files/cleanup, und dort über die Storage-API, nie per SQL.
"""

import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends
from supabase import AsyncClient, PostgrestAPIError

import sessions
from checksums import FILE_TABLES, backfill_sha256, missing_sha256
from errors import ApiError
from files import remove_unused_files
from queries import PAGE_SIZE, select_all
from sessions import Session, current_session, existing_session, fresh_client
from web import require_own_origin

logger = logging.getLogger("zamaric")

router = APIRouter()

# So viele Zeilen holen die Übersichten mit fester Obergrenze
LARGEST_FILES = 20
CRON_RUNS = 50
NOTIFICATIONS = 200

# Stand des Nachtragens für GET /api/checksums. Es läuft immer nur ein
# Durchgang gleichzeitig, auch bei mehreren Logins kurz hintereinander.
backfill_progress = {"running": False, "total": 0, "done": 0, "failed": 0}


def database_error(error: Exception) -> ApiError:
    """Übersetzt einen Fehler von Supabase in einen festen Code für den Browser.

    Die Funktionen der Migration werfen 'forbidden' bzw. 'not_found'. 42501 ist
    eine von RLS abgelehnte Zeile, 23503 ein Verweis auf eine Zeile, die es
    nicht gibt (z. B. eine gelöschte Spalte).
    """
    if isinstance(error, PostgrestAPIError):
        if error.message == "forbidden" or error.code == "42501":
            return ApiError(403, "forbidden", str(error))
        if error.message == "not_found" or error.code == "23503":
            return ApiError(404, "not_found", str(error))
    return ApiError(502, "database_failed", str(error))


async def rpc_all(client: AsyncClient, function: str, order_by: list[str], params: dict | None = None) -> list[dict]:
    """Ruft eine RPC-Funktion auf und liest ihr Ergebnis Seite für Seite.

    Supabase liefert auch hier höchstens 1000 Zeilen pro Abfrage. Die feste
    Sortierung sorgt dafür, dass beim Blättern keine Zeile doppelt kommt oder fehlt.
    """
    rows = []
    while True:
        query = client.rpc(function, params or {})
        for column in order_by:
            query = query.order(column)
        page = (await query.range(len(rows), len(rows) + PAGE_SIZE - 1).execute()).data or []
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows


async def rpc_rows(client: AsyncClient, function: str, params: dict | None = None) -> list[dict]:
    """Ruft eine RPC-Funktion mit eigener Obergrenze (max_rows) auf, ohne Blättern."""
    return (await client.rpc(function, params or {}).execute()).data or []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Integrität und Dateien
# ---------------------------------------------------------------------------

@router.get("/api/integrity")
async def get_integrity(session: Session = Depends(current_session)) -> dict:
    client = await fresh_client(session)
    try:
        findings = await rpc_all(
            client, "integrity_report", ["check_name", "table_name", "row_id", "song_id", "detail"]
        )
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise database_error(error) from None
    return {"checked_at": now_iso(), "findings": findings}


@router.get("/api/files")
async def get_files(session: Session = Depends(current_session)) -> dict:
    client = await fresh_client(session)
    try:
        unused = await rpc_all(client, "unused_files", ["bucket", "name"])
        missing = await rpc_all(client, "missing_files", ["table_name", "row_id"])
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise database_error(error) from None
    return {"unused": unused, "missing": missing}


# Löscht über die Storage-API. Die Policy auf storage.objects lässt nur
# Dateien zu, die unused_files() auch meldet.
@router.post("/api/files/cleanup", dependencies=[Depends(require_own_origin)])
async def post_files_cleanup(session: Session = Depends(current_session)) -> dict:
    removed = await remove_unused_files(session)
    return {"removed": removed}


# ---------------------------------------------------------------------------
# Prüfsummen nachtragen (aus dem Upload-Tool hierher umgezogen)
# ---------------------------------------------------------------------------

def claim_backfill() -> bool:
    """Reserviert den nächsten Durchgang. False, wenn schon einer läuft.

    Läuft vor der Antwort auf POST /api/checksums, damit die Website beim
    ersten Abfragen schon sieht, dass etwas läuft.
    """
    if backfill_progress["running"]:
        return False
    backfill_progress.update(running=True, total=0, done=0, failed=0)
    return True


async def backfill_missing_sha256(session: Session) -> None:
    """Trägt alle fehlenden Prüfsummen nach.

    Vorher muss claim_backfill() True geliefert haben. Läuft nach der Antwort
    an den Browser, Datei für Datei, damit nie mehr als eine im Speicher liegt.
    Fehlt eine Datei im Bucket, wird sie übersprungen und beim nächsten Durchgang
    wieder versucht. Endet, wenn die Session vorbei ist. Fehler landen nur im Log.
    """
    progress = backfill_progress
    try:
        work = []
        for table, bucket in FILE_TABLES:
            rows = await select_all(await fresh_client(session), table, "id, path, sha256", ["id"], missing_sha256)
            work.extend((table, bucket, row) for row in rows)
        progress["total"] = len(work)
        for table, bucket, row in work:
            if session.session_id not in sessions.sessions:
                logger.info("Prüfsummen nachtragen abgebrochen, Session vorbei")
                return
            try:
                await backfill_sha256(await fresh_client(session), table, bucket, row)
            except (ApiError, PostgrestAPIError, httpx.HTTPError) as error:
                if isinstance(error, ApiError) and error.code == "unauthorized":
                    raise
                progress["failed"] += 1
                reason = error.code if isinstance(error, ApiError) else type(error).__name__
                logger.warning("Prüfsumme für %s %s nicht nachgetragen (%s)", table, row["id"], reason)
            progress["done"] += 1
    except Exception as error:
        logger.warning("Prüfsummen nachtragen fehlgeschlagen (%s)", type(error).__name__)
    finally:
        progress["running"] = False
        if progress["done"]:
            logger.info(
                "Prüfsummen nachgetragen: %d, fehlgeschlagen: %d",
                progress["done"] - progress["failed"],
                progress["failed"],
            )


# Verlängert die Session nicht, die Website fragt das alle paar Sekunden ab.
@router.get("/api/checksums", dependencies=[Depends(existing_session)])
async def get_checksum_progress() -> dict:
    return dict(backfill_progress)


# Startet das Nachtragen fehlender Prüfsummen im Hintergrund. Läuft schon
# eins, kommt einfach dessen Stand zurück.
@router.post("/api/checksums", status_code=202, dependencies=[Depends(require_own_origin)])
async def post_checksums(background_tasks: BackgroundTasks, session: Session = Depends(current_session)) -> dict:
    if claim_backfill():
        background_tasks.add_task(backfill_missing_sha256, session)
    return dict(backfill_progress)


# ---------------------------------------------------------------------------
# Speicher, Freigaben, Cron, Nachrichten
# ---------------------------------------------------------------------------

@router.get("/api/storage")
async def get_storage(session: Session = Depends(current_session)) -> dict:
    client = await fresh_client(session)
    try:
        buckets = await rpc_rows(client, "storage_usage")
        largest = await rpc_rows(client, "largest_files", {"max_rows": LARGEST_FILES})
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise database_error(error) from None
    return {"buckets": buckets, "largest": largest}


@router.get("/api/releases")
async def get_releases(session: Session = Depends(current_session)) -> dict:
    client = await fresh_client(session)
    try:
        pending = await rpc_all(client, "pending_releases", ["release_at", "song_id"])
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise database_error(error) from None
    return {"pending": pending}


@router.get("/api/cron")
async def get_cron(session: Session = Depends(current_session)) -> dict:
    client = await fresh_client(session)
    try:
        runs = await rpc_rows(client, "cron_runs", {"max_rows": CRON_RUNS})
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise database_error(error) from None
    return {"runs": runs}


@router.get("/api/notifications")
async def get_notifications(session: Session = Depends(current_session)) -> dict:
    client = await fresh_client(session)
    try:
        notifications = await rpc_rows(client, "notification_feed", {"max_rows": NOTIFICATIONS})
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise database_error(error) from None
    return {"notifications": notifications}
