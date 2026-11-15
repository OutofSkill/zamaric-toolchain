"""Aufräumen im Bucket: Dateien löschen, auf die keine Zeile mehr zeigt (unused_files).

Die Dateiliste kommt aus R2 über den Storage-Worker. Gelöscht wird nur über
den Worker, der vor dem Löschen selbst noch einmal unused_files() fragt.
"""

import logging

import httpx
from supabase import PostgrestAPIError

from errors import ApiError
from sessions import Session, fresh_client
from storage import all_files, delete_files

logger = logging.getLogger("zamaric")


async def remove_unused_files(session: Session) -> int:
    """Löscht alle unbenutzten Dateien und gibt ihre Zahl zurück.

    Ein Fehler kommt als ApiError mit festem Code zurück.
    """
    client = await fresh_client(session)
    files = await all_files(client)
    try:
        rows = (await client.rpc("unused_files", {"files": files}).execute()).data or []
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise ApiError(502, "database_failed", str(error)) from None
    names_by_bucket: dict[str, list[str]] = {}
    for row in rows:
        names_by_bucket.setdefault(row["bucket"], []).append(row["name"])
    removed = 0
    for bucket, names in names_by_bucket.items():
        removed += len(await delete_files(client, bucket, names))
    if removed:
        logger.info("%d unbenutzte Dateien im Bucket gelöscht", removed)
    return removed


async def remove_unused_files_in_background(session: Session) -> None:
    """Wie remove_unused_files, aber als Hintergrund-Task nach einer Antwort.

    Ein Fehler landet nur im Log, beim nächsten Upload wird es erneut versucht.
    """
    try:
        await remove_unused_files(session)
    except Exception as error:
        reason = error.code if isinstance(error, ApiError) else type(error).__name__
        logger.warning("Aufräumen im Bucket fehlgeschlagen (%s)", reason)
