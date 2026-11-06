"""GET /api/reference: Nachschlagedaten, gegen die die Website den Song-Ordner prüft."""

import httpx
from supabase import AsyncClient, PostgrestAPIError

from errors import ApiError
from queries import select_all


async def load_reference(client: AsyncClient) -> dict:
    try:
        return {
            "categories": await select_all(client, "category", "id, name", ["position", "id"]),
            "levels": await select_all(client, "level", "id, name", ["id"]),
            "instruments": await select_all(client, "instrument", "id, name, transposition", ["id"]),
            "parts": await select_all(client, "part", "id, name, transposition", ["id"]),
            "instrument_parts": await select_all(client, "instrument_part", "part_id, instrument_id", ["part_id", "instrument_id"]),
            # Admins sehen hier alle Songs, wartende und freigegebene. Die
            # Zeitpunkte braucht die Website für "Zuletzt hochgeladen", die ID
            # zum Ändern eines Songs.
            "songs": await select_all(client, "song", "id, category_id, name, created_at, release_at", ["id"]),
        }
    except (PostgrestAPIError, httpx.HTTPError) as error:
        raise ApiError(502, "database_failed", str(error)) from None
