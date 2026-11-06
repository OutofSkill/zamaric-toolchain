"""Seitenweises Lesen aus Supabase, gemeinsam für Upload-Tool und Entwicklerseite."""

from supabase import AsyncClient

# Supabase liefert pro Abfrage höchstens 1000 Zeilen (Einstellung "Max rows"
# im Dashboard). Deshalb wird seitenweise gelesen.
PAGE_SIZE = 1000


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
