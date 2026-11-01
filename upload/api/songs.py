"""GET /api/songs/{song_id}: der sichtbare Stand eines Songs, gegen den die Website beim Ändern vergleicht.

Dateien, die vor der Migration song_update hochgeladen wurden, haben noch
keine Prüfsumme. Die wird hier einmal nachgetragen: Datei aus dem Bucket
laden, hashen, über set_file_sha256 eintragen.
"""

import hashlib
import logging

import httpx
from supabase import AsyncClient, PostgrestAPIError, StorageException

from errors import ApiError
from reference import select_all

logger = logging.getLogger("upload")

AUDIO_BUCKET = "audio"
SHEET_MUSIC_BUCKET = "sheet_music"


def visible_rows_of(song_id: int):
    """Filter für sichtbare Zeilen eines Songs. Wartende Änderungen haben release_at."""
    return lambda query: query.eq("song_id", song_id).is_("release_at", "null")


async def load_song(client: AsyncClient, song_id: int) -> dict:
    try:
        songs = await select_all(
            client, "song", "id, release_at, publisher_name, publisher_url", ["id"], lambda query: query.eq("id", song_id)
        )
        if not songs:
            raise ApiError(404, "not_found", f"Song {song_id} gibt es nicht")
        count_ins = await select_all(client, "count_in", "id, name, path, duration_ms, sha256", ["id"], visible_rows_of(song_id))
        playbacks = await select_all(
            client, "playback", "id, type, path, duration_ms, sha256, instrument_mode", ["id"], visible_rows_of(song_id)
        )
        sheets = await select_all(client, "sheet_music", "id, part_id, level_id, path, sha256", ["id"], visible_rows_of(song_id))
        playback_ids = [playback["id"] for playback in playbacks]
        in_playbacks = lambda query: query.in_("playback_id", playback_ids)
        letters = await select_all(client, "letter", "playback_id, name, position_ms, count_in_id", ["playback_id", "position_ms"], in_playbacks) if playback_ids else []
        displays = await select_all(client, "display_playback", "playback_id, instrument_id", ["playback_id", "instrument_id"], in_playbacks) if playback_ids else []
        pending_release = await pending_release_at(client, song_id)

        for row in count_ins:
            await backfill_sha256(client, "count_in", AUDIO_BUCKET, row)
        for row in playbacks:
            await backfill_sha256(client, "playback", AUDIO_BUCKET, row)
        for row in sheets:
            await backfill_sha256(client, "sheet_music", SHEET_MUSIC_BUCKET, row)
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise ApiError(502, "database_failed", str(error)) from None

    count_in_names = {row["id"]: row["name"] for row in count_ins}
    return {
        "song_id": song_id,
        "release_at": songs[0]["release_at"],
        "pending_release_at": pending_release,
        "publisher_name": songs[0]["publisher_name"],
        "publisher_url": songs[0]["publisher_url"],
        "count_ins": [{"name": row["name"], "duration_ms": row["duration_ms"], "sha256": row["sha256"]} for row in count_ins],
        "playbacks": [
            {
                "type": row["type"],
                "duration_ms": row["duration_ms"],
                "sha256": row["sha256"],
                "instrument_mode": row["instrument_mode"],
                "instrument_ids": [display["instrument_id"] for display in displays if display["playback_id"] == row["id"]],
                "letters": [
                    {"name": letter["name"], "position_ms": letter["position_ms"], "count_in": count_in_names.get(letter["count_in_id"])}
                    for letter in letters
                    if letter["playback_id"] == row["id"]
                ],
            }
            for row in playbacks
        ],
        "sheet_music": [{"part_id": row["part_id"], "level_id": row["level_id"], "sha256": row["sha256"]} for row in sheets],
    }


async def pending_release_at(client: AsyncClient, song_id: int) -> str | None:
    """Zeitpunkt einer schon wartenden Änderung, sonst None."""
    for table in ("count_in", "playback", "sheet_music"):
        rows = (
            await client.table(table)
            .select("release_at")
            .eq("song_id", song_id)
            .not_.is_("release_at", "null")
            .limit(1)
            .execute()
        ).data
        if rows:
            return rows[0]["release_at"]
    return None


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
