"""GET /api/overview: alles für die Startseite der Entwicklerseite in einer Antwort.

Die Teile werden gleichzeitig geholt und sind voneinander unabhängig: Jeder
kommt als {"data": …} oder {"error": "<code>"}. Fällt z. B. GitHub aus, zeigt
nur diese Kachel einen Fehler. Die Website fragt jede Minute ab, deshalb
verlängert der Endpunkt die Session nicht.
"""

import asyncio
import logging
import statistics
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends
from postgrest.types import CountMethod
from supabase import AsyncClient, PostgrestAPIError

import monitor
import repo
from config import settings
from database import CRON_RUNS, database_error, now_iso, rpc_all, rpc_rows
from errors import ApiError
from sessions import Session, existing_session, fresh_client

logger = logging.getLogger("zamaric")

router = APIRouter()

# So viele Wochen zeigt die Repo-Kachel, so viele Nachrichten die Nachrichten-Kachel
REPO_WEEKS = 12
NOTIFICATIONS = 3

# Länger wartet die Übersicht auf keinen Teil. Ein hängender Teil hält so die
# anderen nicht auf und nginx (120 s) bricht nie die ganze Antwort ab.
PART_TIMEOUT_SECONDS = 15

# Integrität und Speicher ändern sich selten und sind die teuersten Abfragen.
# Sie laufen deshalb höchstens alle 5 Minuten, nicht bei jeder Abfrage.
SLOW_PART_CACHE_SECONDS = 5 * 60
slow_part_cache: dict[str, tuple[float, dict]] = {}


async def part(name: str, load) -> dict:
    """Führt einen Teil aus und packt Ergebnis oder festen Fehlercode ein.

    Details landen nur im Log, nie in der Antwort.
    """
    try:
        return {"data": await asyncio.wait_for(load(), PART_TIMEOUT_SECONDS)}
    except TimeoutError:
        logger.warning("Übersicht: %s → timeout (%d s)", name, PART_TIMEOUT_SECONDS)
        return {"error": "timeout"}
    except ApiError as error:
        logger.warning("Übersicht: %s → %s%s", name, error.code, f" ({error.detail})" if error.detail else "")
        return {"error": error.code}
    except (PostgrestAPIError, httpx.HTTPError) as error:
        mapped = database_error(error)
        logger.warning("Übersicht: %s → %s (%s)", name, mapped.code, type(error).__name__)
        return {"error": mapped.code}
    except Exception as error:
        logger.error("Übersicht: %s → internal_error (%s)", name, type(error).__name__, exc_info=error)
        return {"error": "internal_error"}


async def cached_part(name: str, load) -> dict:
    """Wie load(), aber das Ergebnis gilt SLOW_PART_CACHE_SECONDS. Fehler werden nicht gemerkt."""
    cached = slow_part_cache.get(name)
    if cached is not None and time.monotonic() - cached[0] < SLOW_PART_CACHE_SECONDS:
        return cached[1]
    result = await load()
    slow_part_cache[name] = (time.monotonic(), result)
    return result


def down_since(samples: list[dict]) -> str | None:
    """Erste fehlgeschlagene Messung der laufenden Ausfallserie, None wenn die letzte ok war."""
    start = None
    for sample in reversed(samples):
        if sample["ok"]:
            break
        start = sample["at"]
    return start


async def latency_summary() -> dict:
    samples = list(monitor.samples)
    reachable = [sample["ms"] for sample in samples if sample["ok"] and sample["ms"] is not None]
    return {
        "last": samples[-1] if samples else None,
        "down_since": down_since(samples),
        "median_ms": round(statistics.median(reachable)) if reachable else None,
        "failures": sum(1 for sample in samples if not sample["ok"]),
        "samples": len(samples),
    }


async def ci_summary() -> dict:
    ci = await repo.load_ci()
    return {
        "configured": ci["configured"],
        "workflow": settings.github_workflow,
        "latest": ci["runs"][0] if ci["runs"] else None,
    }


async def integrity_summary(client: AsyncClient) -> dict:
    findings = await rpc_all(client, "integrity_report", ["check_name", "table_name", "row_id", "song_id", "detail"])
    return {
        "errors": sum(1 for finding in findings if finding["severity"] == "error"),
        "warnings": sum(1 for finding in findings if finding["severity"] == "warning"),
    }


async def cron_summary(client: AsyncClient) -> dict:
    """Letzter Lauf und Fehlschläge der letzten 24 Stunden. cron_runs liefert neueste zuerst."""
    runs = await rpc_rows(client, "cron_runs", {"max_rows": CRON_RUNS})
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    failed = sum(
        1
        for run in runs
        if run["status"] == "failed" and run["started_at"] and datetime.fromisoformat(run["started_at"]) >= since
    )
    return {"latest": runs[0] if runs else None, "failed_24h": failed}


async def count_rows(client: AsyncClient, table: str, where=None) -> int:
    """Zählt Zeilen, ohne sie zu laden (HEAD-Anfrage mit count=exact)."""
    query = client.table(table).select("id", count=CountMethod.exact, head=True)
    if where is not None:
        query = where(query)
    return (await query.execute()).count or 0


async def content_summary(client: AsyncClient) -> dict:
    """Zahlen für die Inhalt-Kachel. Admins sehen über RLS auch wartende Zeilen.

    Playbacks, Noten und Einzähler zählen nur sichtbare Zeilen: Wartende
    Änderungen (release_at gesetzt) wären sonst doppelt gezählt.
    """
    visible = lambda query: query.is_("release_at", "null")
    songs, pending_songs, playbacks, sheet_music, count_ins, categories = await asyncio.gather(
        count_rows(client, "song"),
        count_rows(client, "song", lambda query: query.gt("release_at", now_iso())),
        count_rows(client, "playback", visible),
        count_rows(client, "sheet_music", visible),
        count_rows(client, "count_in", visible),
        count_rows(client, "category"),
    )
    return {
        "songs": songs,
        "pending_songs": pending_songs,
        "playbacks": playbacks,
        "sheet_music": sheet_music,
        "count_ins": count_ins,
        "categories": categories,
    }


async def repo_summary() -> dict:
    head = await repo.current_head()
    commits = await repo.load_commits(head, 0, 1)
    weeks = await repo.commit_weeks(head, REPO_WEEKS)
    return {
        "head": head,
        "fetched_at": repo.fetched_at(),
        "latest": commits["commits"][0] if commits["commits"] else None,
        "this_week": weeks[-1]["commits"] if weeks else 0,
        "last_week": weeks[-2]["commits"] if len(weeks) > 1 else 0,
        "weeks": weeks,
    }


async def releases_summary(client: AsyncClient) -> dict:
    pending = await rpc_all(client, "pending_releases", ["release_at", "song_id"])
    return {"next": pending[0] if pending else None, "more": max(0, len(pending) - 1)}


async def storage_summary(client: AsyncClient) -> dict:
    buckets = await rpc_rows(client, "storage_usage")
    return {"buckets": buckets, "total_bytes": sum(bucket["total_bytes"] or 0 for bucket in buckets)}


async def notifications_summary(client: AsyncClient) -> dict:
    return {"latest": await rpc_rows(client, "notification_feed", {"max_rows": NOTIFICATIONS})}


# Verlängert die Session nicht, die Website fragt das jede Minute ab.
@router.get("/api/overview")
async def get_overview(session: Session = Depends(existing_session)) -> dict:
    # Ist Supabase gerade nicht erreichbar (Token nicht erneuerbar, aber nicht
    # abgelehnt), bekommen nur die Supabase-Teile den Fehler. Antwortzeit,
    # GitHub und Repo kommen trotzdem. Eine abgelehnte Session bleibt 401.
    try:
        client = await fresh_client(session)
    except ApiError as error:
        if error.code != "database_failed":
            raise
        logger.warning("Übersicht: Supabase-Teile → database_failed (%s)", error.detail)
        client = None

    def supabase_part(name: str, load):
        if client is None:
            return asyncio.sleep(0, {"error": "database_failed"})
        return part(name, lambda: load(client))

    names = ("latency", "ci", "integrity", "cron", "content", "repo", "releases", "storage", "notifications")
    results = await asyncio.gather(
        part("latency", latency_summary),
        part("ci", ci_summary),
        supabase_part("integrity", lambda client: cached_part("integrity", lambda: integrity_summary(client))),
        supabase_part("cron", cron_summary),
        supabase_part("content", content_summary),
        part("repo", repo_summary),
        supabase_part("releases", releases_summary),
        supabase_part("storage", lambda client: cached_part("storage", lambda: storage_summary(client))),
        supabase_part("notifications", notifications_summary),
    )
    return {"generated_at": now_iso(), **dict(zip(names, results))}
