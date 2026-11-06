"""Aufräumen im Bucket: Dateien löschen, auf die keine Zeile mehr zeigt (unused_files).

Gelöscht wird nur über die Storage-API, nie per SQL aus storage.objects.
Die Policy "Admins loeschen unbenutzte Dateien" lässt ohnehin nur Dateien zu,
die unused_files() auch meldet.
"""

import logging

import httpx
from supabase import PostgrestAPIError, StorageException

from errors import ApiError
from sessions import Session, fresh_client

logger = logging.getLogger("zamaric")

# So viele Dateien löscht ein Aufruf von storage.remove() auf einmal
REMOVE_BATCH_SIZE = 100


async def remove_unused_files(session: Session) -> int:
    """Löscht alle unbenutzten Dateien und gibt ihre Zahl zurück.

    Ein Fehler kommt als ApiError mit festem Code zurück.
    """
    client = await fresh_client(session)
    try:
        rows = (await client.rpc("unused_files").execute()).data or []
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise ApiError(502, "database_failed", str(error)) from None
    names_by_bucket: dict[str, list[str]] = {}
    for row in rows:
        names_by_bucket.setdefault(row["bucket"], []).append(row["name"])
    try:
        for bucket, names in names_by_bucket.items():
            for start in range(0, len(names), REMOVE_BATCH_SIZE):
                await client.storage.from_(bucket).remove(names[start : start + REMOVE_BATCH_SIZE])
    except (StorageException, httpx.HTTPError) as error:
        raise ApiError(502, "storage_failed", str(error)) from None
    if rows:
        logger.info("%d unbenutzte Dateien im Bucket gelöscht", len(rows))
    return len(rows)


async def remove_unused_files_in_background(session: Session) -> None:
    """Wie remove_unused_files, aber als Hintergrund-Task nach einer Antwort.

    Ein Fehler landet nur im Log, beim nächsten Upload wird es erneut versucht.
    """
    try:
        await remove_unused_files(session)
    except Exception as error:
        reason = error.code if isinstance(error, ApiError) else type(error).__name__
        logger.warning("Aufräumen im Bucket fehlgeschlagen (%s)", reason)
