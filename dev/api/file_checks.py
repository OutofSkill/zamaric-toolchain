import asyncio
import hashlib
import json
import logging
import sqlite3
import tempfile
from contextlib import aclosing
from dataclasses import dataclass
from typing import Literal

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel, ConfigDict, Field
from supabase import AsyncClient, PostgrestAPIError

import sessions
from board import run
from checksums import FILE_TABLES
from database import now_iso
from errors import ApiError
from file_content import PDF_END_WINDOW_BYTES, PDF_START, InvalidFileContent, has_pdf_end, is_pdf_start, mp3_duration_ms
from queries import select_all
from sessions import Session, current_session, existing_session, fresh_client
from storage import StoredFileMissing, stream_file
from web import require_own_origin

logger = logging.getLogger("zamaric")

router = APIRouter()

SHA256_CHECK = "sha256_mismatch"
MP3_CHECK = "mp3_invalid"
PDF_CHECK = "pdf_invalid"
FILE_CHECKS = {
    SHA256_CHECK: ("count_in", "playback", "sheet_music"),
    MP3_CHECK: ("count_in", "playback"),
    PDF_CHECK: ("sheet_music",),
}
FileCheckName = Literal["sha256_mismatch", "mp3_invalid", "pdf_invalid"]

TABLE_COLUMNS = {
    "count_in": "id, song_id, path, sha256, duration_ms, release_at",
    "playback": "id, song_id, path, sha256, duration_ms, release_at",
    "sheet_music": "id, song_id, path, sha256, release_at",
}

STOPPING_ERRORS = {"unauthorized", "forbidden", "database_failed"}
STORAGE_FAILURES_BEFORE_ABORT = 5
DURATION_TOLERANCE_MS = 50
SPOOL_MAX_BYTES = 16 * 1024 * 1024

file_check_progress = {
    "running": False,
    "checks": [],
    "total": 0,
    "done": 0,
    "failed": 0,
    "finished_at": None,
    "aborted": None,
    "last_run_results": {},
}

file_check_results: dict[str, dict] = {}
results_loaded = False
results_lock = asyncio.Lock()


class FileCheckRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    checks: list[FileCheckName] = Field(min_length=1, max_length=len(FILE_CHECKS))


@dataclass
class FileInspection:
    sha256: str
    start: bytes
    tail: bytes
    duration_ms: int | None
    mp3_error: str | None


async def load_results() -> None:
    global results_loaded
    if results_loaded:
        return

    def work(connection: sqlite3.Connection) -> list[tuple[str, str]]:
        rows = connection.execute("select check_name, result from file_check_result").fetchall()
        return [(row["check_name"], row["result"]) for row in rows]

    async with results_lock:
        if results_loaded:
            return
        try:
            rows = await run(work)
            stored = {check_name: json.loads(result) for check_name, result in rows if check_name in FILE_CHECKS}
        except Exception as error:
            logger.warning("Ergebnisse der Dateiprüfungen nicht geladen (%s)", type(error).__name__)
            return
        for check_name, result in stored.items():
            file_check_results.setdefault(check_name, result)
        results_loaded = True


async def save_results(finished: dict[str, dict]) -> None:
    def work(connection: sqlite3.Connection) -> None:
        for check_name, result in finished.items():
            connection.execute(
                "insert into file_check_result (check_name, result, finished_at) values (?, ?, ?) "
                "on conflict (check_name) do update set result = excluded.result, finished_at = excluded.finished_at",
                (check_name, json.dumps(result, ensure_ascii=False), result["finished_at"]),
            )

    await run(work)


def claim_file_checks(checks: list[str]) -> bool:
    if file_check_progress["running"]:
        return False
    file_check_progress.update(
        running=True, checks=checks, total=0, done=0, failed=0, finished_at=None, aborted=None, last_run_results={}
    )
    return True


async def file_check_state() -> dict:
    await load_results()
    return {
        **file_check_progress,
        "checks": list(file_check_progress["checks"]),
        "last_run_results": dict(file_check_progress["last_run_results"]),
        "results": dict(file_check_results),
    }


async def inspect_file(client: AsyncClient, bucket: str, name: str, measures_mp3: bool) -> FileInspection:
    digest = hashlib.sha256()
    start = b""
    tail = b""
    with tempfile.SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as spool:
        async with aclosing(stream_file(client, bucket, name)) as chunks:
            async for chunk in chunks:
                digest.update(chunk)
                if len(start) < len(PDF_START):
                    start = (start + chunk)[: len(PDF_START)]
                tail = (tail + chunk)[-PDF_END_WINDOW_BYTES:]
                if measures_mp3:
                    spool.write(chunk)
        duration_ms = None
        mp3_error = None
        if measures_mp3:
            spool.seek(0)
            try:
                duration_ms = await asyncio.to_thread(mp3_duration_ms, spool)
            except InvalidFileContent as error:
                mp3_error = str(error)
    return FileInspection(digest.hexdigest(), start, tail, duration_ms, mp3_error)


def file_finding(check: str, row: dict, inspection: FileInspection) -> tuple[str, str] | None:
    if check == SHA256_CHECK:
        if inspection.sha256 != row["sha256"]:
            return "error", f"R2 {inspection.sha256[:12]}, DB {row['sha256'][:12]}"
        return None
    if check == MP3_CHECK:
        if inspection.mp3_error is not None:
            return "error", f"MP3 {inspection.mp3_error}"
        if abs(inspection.duration_ms - row["duration_ms"]) > DURATION_TOLERANCE_MS:
            return "warning", f"gemessen {inspection.duration_ms} ms, DB {row['duration_ms']} ms"
        return None
    if not is_pdf_start(inspection.start):
        return "error", "beginnt nicht mit %PDF"
    if not has_pdf_end(inspection.tail):
        return "error", "endet nicht mit %%EOF"
    return None


async def run_file_checks(session: Session) -> None:
    progress = file_check_progress
    checks = list(progress["checks"])
    counts = {check: {"total": 0, "checked": 0, "skipped": 0, "failed": 0, "missing": 0} for check in checks}
    findings: dict[str, list[dict]] = {check: [] for check in checks}
    try:
        client = await fresh_client(session)
        songs = {row["id"]: row for row in await select_all(client, "song", "id, name, release_at", ["id"])}
        work = []
        for table, bucket in FILE_TABLES:
            table_checks = [check for check in checks if table in FILE_CHECKS[check]]
            if not table_checks:
                continue
            rows = await select_all(
                await fresh_client(session),
                table,
                TABLE_COLUMNS[table],
                ["id"],
                lambda query: query.not_.is_("path", "null"),
            )
            for row in rows:
                if SHA256_CHECK in table_checks and not row["sha256"]:
                    counts[SHA256_CHECK]["skipped"] += 1
                row_checks = [check for check in table_checks if check != SHA256_CHECK or row["sha256"]]
                for check in row_checks:
                    counts[check]["total"] += 1
                if row_checks:
                    work.append((table, bucket, row, row_checks))
        progress["total"] = len(work)
        consecutive_failures = 0
        for table, bucket, row, row_checks in work:
            if session.session_id not in sessions.sessions:
                progress["aborted"] = "session_ended"
                logger.info("Dateiprüfungen abgebrochen, Session vorbei")
                return
            try:
                inspection = await inspect_file(await fresh_client(session), bucket, row["path"], MP3_CHECK in row_checks)
            except ApiError as error:
                if error.code in STOPPING_ERRORS:
                    raise
                progress["failed"] += 1
                missing = isinstance(error, StoredFileMissing)
                for check in row_checks:
                    counts[check]["failed"] += 1
                    if missing:
                        counts[check]["missing"] += 1
                if not missing:
                    consecutive_failures += 1
                    logger.warning("Datei für %s %s nicht geprüft (%s)", table, row["id"], error.code)
            else:
                consecutive_failures = 0
                song = songs.get(row["song_id"], {})
                for check in row_checks:
                    counts[check]["checked"] += 1
                    finding = file_finding(check, row, inspection)
                    if finding is None:
                        continue
                    severity, detail = finding
                    findings[check].append(
                        {
                            "check_name": check,
                            "severity": severity,
                            "table_name": table,
                            "row_id": row["id"],
                            "song_id": row["song_id"],
                            "song_name": song.get("name"),
                            "song_release_at": song.get("release_at"),
                            "release_at": row["release_at"],
                            "bucket": bucket,
                            "path": row["path"],
                            "detail": detail,
                        }
                    )
            progress["done"] += 1
            if consecutive_failures >= STORAGE_FAILURES_BEFORE_ABORT:
                progress["aborted"] = "storage_failed"
                logger.warning("Dateiprüfungen abgebrochen, %d Dateien in Folge nicht abrufbar", consecutive_failures)
                return
    except asyncio.CancelledError:
        progress["aborted"] = "cancelled"
        raise
    except Exception as error:
        if isinstance(error, ApiError):
            progress["aborted"] = error.code
        elif isinstance(error, (PostgrestAPIError, httpx.HTTPError)):
            progress["aborted"] = "database_failed"
        else:
            progress["aborted"] = "unexpected"
        reason = error.code if isinstance(error, ApiError) else type(error).__name__
        logger.warning("Dateiprüfungen fehlgeschlagen (%s)", reason)
    finally:
        progress["running"] = False
        finished_at = now_iso()
        progress["finished_at"] = finished_at
        finished = {
            check: {
                "finished_at": finished_at,
                "complete": progress["aborted"] is None
                and counts[check]["checked"] + counts[check]["missing"] == counts[check]["total"],
                "aborted": progress["aborted"],
                **counts[check],
                "findings": findings[check],
            }
            for check in checks
        }
        progress["last_run_results"] = finished
        for check, result in finished.items():
            logger.info(
                "Dateiprüfung %s: geprüft %d von %d, nicht abrufbar %d (davon fehlen in R2 %d), übersprungen %d, Funde %d%s",
                check,
                result["checked"],
                result["total"],
                result["failed"],
                result["missing"],
                result["skipped"],
                len(result["findings"]),
                "" if result["complete"] else ", unvollständig",
            )
        complete_results = {check: result for check, result in finished.items() if result["complete"]}
        if complete_results:
            file_check_results.update(complete_results)
            try:
                await save_results(complete_results)
            except Exception as error:
                logger.warning("Ergebnisse der Dateiprüfungen nicht gespeichert (%s)", type(error).__name__)


@router.get("/api/file-checks", dependencies=[Depends(existing_session)])
async def get_file_checks() -> dict:
    return await file_check_state()


@router.post("/api/file-checks", status_code=202, dependencies=[Depends(require_own_origin)])
async def post_file_checks(
    body: FileCheckRequest, background_tasks: BackgroundTasks, session: Session = Depends(current_session)
) -> dict:
    if claim_file_checks(list(dict.fromkeys(body.checks))):
        background_tasks.add_task(run_file_checks, session)
    return await file_check_state()
