"""Prüfsummen für Dateien, die vor der Migration song_update hochgeladen wurden.

Datei aus dem Bucket laden, hashen, über set_file_sha256 eintragen. Das
Upload-Tool macht das beim Laden eines Songs (GET /api/songs/{id}), die
Entwicklerseite auf Knopfdruck für alle Zeilen ohne Prüfsumme.
"""

import hashlib
import logging

import httpx
from supabase import AsyncClient, StorageException

from errors import ApiError

logger = logging.getLogger("zamaric")

AUDIO_BUCKET = "audio"
SHEET_MUSIC_BUCKET = "sheet_music"

FILE_TABLES = (("count_in", AUDIO_BUCKET), ("playback", AUDIO_BUCKET), ("sheet_music", SHEET_MUSIC_BUCKET))


def missing_sha256(query):
    """Filter für Zeilen mit Datei, aber ohne Prüfsumme."""
    return query.is_("sha256", "null").not_.is_("path", "null")


async def backfill_sha256(client: AsyncClient, table: str, bucket: str, row: dict) -> None:
    if row["sha256"] or not row["path"]:
        return
    try:
        content = await client.storage.from_(bucket).download(row["path"])
    except (StorageException, httpx.HTTPError) as error:
        raise ApiError(502, "storage_failed", f"{bucket}/{row['path']}: {error}") from None
    row["sha256"] = hashlib.sha256(content).hexdigest()
    await client.rpc("set_file_sha256", {"kind": table, "row_id": row["id"], "hash": row["sha256"]}).execute()
    logger.info("Prüfsumme nachgetragen: %s %s", table, row["id"])
