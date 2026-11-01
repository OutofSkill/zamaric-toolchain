"""GET /api/reference: Nachschlagedaten, gegen die die Website den Song-Ordner prüft."""

import httpx
from supabase import AsyncClient, PostgrestAPIError

from errors import ApiError

# Supabase liefert pro Abfrage höchstens 1000 Zeilen (Einstellung "Max rows"
# im Dashboard). Deshalb wird seitenweise gelesen.
PAGE_SIZE = 1000


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


async def select_all(client: AsyncClient, table: str, columns: str, order_by: list[str], where=None) -> list[dict]:
    """Liest alle Zeilen einer Tabelle, Seite für Seite.

    Die feste Sortierung sorgt dafür, dass beim Blättern keine Zeile doppelt
    kommt oder fehlt. where bekommt die Abfrage und hängt Filter an.
    """
    rows = []
    while True:
        query = client.table(table).select(columns)
        if where is not None:
            query = where(query)
        for column in order_by:
            query = query.order(column)
        page = (await query.range(len(rows), len(rows) + PAGE_SIZE - 1).execute()).data
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
