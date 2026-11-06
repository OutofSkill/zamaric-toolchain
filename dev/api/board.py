"""Bereich Board der Entwicklerseite: Spalten mit Karten, ähnlich wie bei Padlet.

Das Board liegt nicht in Supabase, sondern in einer SQLite-Datei auf dem Pi
(BOARD_DATA_DIR, im Docker-Volume board-data). Es gehört zur Entwicklerseite,
nicht zur App, und funktioniert auch, wenn Supabase nicht erreichbar ist.
Einmal am Tag entsteht daneben eine Sicherung in backups/.

Jeder Zugriff öffnet eine eigene Verbindung in einem Thread (asyncio.to_thread)
und läuft hinter einem Lock in einer Transaktion. Es gibt nur einen Worker
(siehe Dockerfile), der Lock reicht also gegen gleichzeitige Verschiebungen.
"""

import asyncio
import contextlib
import logging
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Path as PathParameter, Response
from pydantic import BaseModel, ConfigDict, Field

from config import settings
from errors import ApiError
from sessions import Session, current_session
from web import require_own_origin

logger = logging.getLogger("zamaric")

router = APIRouter()

# Session als Parameter jedes Endpunkts, nicht am Router: So prüft FastAPI
# zuerst den Origin (dependencies der Route) und erst dann die Session, wie
# im Rest der API.
SessionRequired = Annotated[Session, Depends(current_session)]

DATABASE_FILE = "board.sqlite3"
BACKUP_FOLDER = "backups"
# So viele Tagessicherungen bleiben liegen, ältere werden gelöscht
BACKUP_KEEP = 14
# So oft wird geprüft, ob es für heute schon eine Sicherung gibt. Stündlich
# statt alle 24 Stunden, damit Zeitumstellung, Laufzeit der Sicherung oder
# eine beim Booten noch falsche Uhr keinen Tag auslassen.
BACKUP_CHECK_SECONDS = 60 * 60
# Wie lange eine Verbindung auf eine gesperrte Datei wartet, in Millisekunden
BUSY_TIMEOUT_MS = 5000
# Größte ID, die SQLite speichern kann. Größere Werte lehnt die API mit 422 ab.
MAX_ID = 2**63 - 1

# Farben der Zettel. Die Website kennt genau diese Werte.
CARD_COLORS = ("default", "red", "orange", "yellow", "green", "blue", "purple")
CardColor = Literal["default", "red", "orange", "yellow", "green", "blue", "purple"]

# Schema-Stände, gespeichert in "pragma user_version". Eine spätere Änderung
# kommt als neuer Eintrag ans Ende (Version 2, 3, …) und läuft genau einmal.
# autoincrement: Eine gelöschte ID wird nie neu vergeben. Sonst träfe ein Tab
# mit altem Stand nach dem Löschen der höchsten ID eine neue, fremde Karte.
SCHEMA_STEPS = [
    f"""
    create table board_column (
        id integer primary key autoincrement,
        title text not null check (length(title) between 1 and 200),
        position integer not null,
        created_at text not null,
        updated_at text not null
    );
    create table board_card (
        id integer primary key autoincrement,
        column_id integer not null references board_column (id) on delete cascade,
        title text not null default '' check (length(title) <= 200),
        body text not null default '' check (length(body) <= 20000),
        color text not null default 'default' check (color in ({", ".join(f"'{color}'" for color in CARD_COLORS)})),
        position integer not null,
        created_at text not null,
        updated_at text not null
    );
    create index board_card_column_id_position_index on board_card (column_id, position);
    """,
]
SCHEMA_VERSION = len(SCHEMA_STEPS)

# Keine Steuerzeichen außer Tab, Zeilenumbruch und Wagenrücklauf. NUL würde
# SQLite außerdem beim Zählen der Länge abschneiden.
TEXT_PATTERN = r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$"

RowId = Annotated[int, Field(ge=1, le=MAX_ID)]
ColumnIdPath = Annotated[int, PathParameter(ge=1, le=MAX_ID)]
CardIdPath = Annotated[int, PathParameter(ge=1, le=MAX_ID)]

lock = threading.Lock()
schema_ready = False
backup_task: asyncio.Task | None = None


class ColumnRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    title: str = Field(min_length=1, max_length=200, pattern=TEXT_PATTERN)


class CardCreateRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    column_id: RowId
    title: str = Field(default="", max_length=200, pattern=TEXT_PATTERN)
    body: str = Field(default="", max_length=20000, pattern=TEXT_PATTERN)
    color: CardColor = "default"


class CardUpdateRequest(BaseModel):
    """Titel und Text sind Pflicht, die Farbe nicht: Ohne color bleibt sie, wie sie ist."""

    model_config = ConfigDict(strict=True, extra="forbid")
    title: str = Field(max_length=200, pattern=TEXT_PATTERN)
    body: str = Field(max_length=20000, pattern=TEXT_PATTERN)
    color: CardColor | None = None


class ColumnMoveRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    index: int = Field(ge=0)


class CardMoveRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    column_id: RowId
    index: int = Field(ge=0)


# ---------------------------------------------------------------------------
# Datei und Verbindungen
# ---------------------------------------------------------------------------

def data_dir() -> Path:
    return Path(settings.board_data_dir)


def database_path() -> Path:
    return data_dir() / DATABASE_FILE


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def connect() -> sqlite3.Connection:
    """Neue Verbindung ohne automatische Transaktionen, Zeilen als dict-artige Rows."""
    connection = sqlite3.connect(database_path(), isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute(f"pragma busy_timeout = {BUSY_TIMEOUT_MS}")
    connection.execute("pragma foreign_keys = on")
    return connection


class SchemaTooNew(RuntimeError):
    """Die Datei hat einen neueren Schema-Stand, als dieser Code kennt."""


def ensure_schema() -> None:
    """Legt Ordner und Datei an und bringt das Schema auf SCHEMA_VERSION. Nur unter dem Lock aufrufen.

    Jeder fehlende Schritt aus SCHEMA_STEPS läuft in einer eigenen Transaktion
    und setzt danach user_version. Ist die Datei neuer als dieser Code (z. B.
    nach dem Zurückspielen eines älteren Images), wird nichts geschrieben.
    """
    global schema_ready
    if schema_ready:
        return
    data_dir().mkdir(parents=True, exist_ok=True)
    connection = connect()
    try:
        # WAL bleibt in der Datei gespeichert und gilt danach für jede Verbindung
        connection.execute("pragma journal_mode = wal")
        version = connection.execute("pragma user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            logger.error("Board-Datei hat Schema %d, dieser Code kennt nur %d. Nichts geschrieben.", version, SCHEMA_VERSION)
            raise SchemaTooNew(f"Schema {version} > {SCHEMA_VERSION}")
        for step_version, step in enumerate(SCHEMA_STEPS[version:], start=version + 1):
            connection.execute("begin immediate")
            try:
                for statement in step.split(";"):
                    if statement.strip():
                        connection.execute(statement)
                connection.execute(f"pragma user_version = {step_version}")
            except BaseException:
                if connection.in_transaction:
                    connection.execute("rollback")
                raise
            connection.execute("commit")
            logger.info("Board-Schema auf Stand %d gebracht", step_version)
    finally:
        connection.close()
    schema_ready = True


def run_locked(work):
    """Führt work(connection) in einer Transaktion aus. Bei einem Fehler wird alles zurückgerollt."""
    with lock:
        ensure_schema()
        connection = connect()
        try:
            connection.execute("begin immediate")
            try:
                result = work(connection)
            except BaseException:
                # Manche Fehler (z. B. volle Platte) rollen in SQLite schon selbst
                # zurück. Ein zweites rollback würde den eigentlichen Fehler überdecken.
                if connection.in_transaction:
                    connection.execute("rollback")
                raise
            connection.execute("commit")
            return result
        finally:
            connection.close()


async def run(work):
    return await asyncio.to_thread(run_locked, work)


def card_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "color": row["color"],
        "updated_at": row["updated_at"],
    }


def column_json(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "title": row["title"]}


def require_row(row: sqlite3.Row | None, what: str) -> sqlite3.Row:
    if row is None:
        raise ApiError(404, "not_found", f"{what} gibt es nicht")
    return row


def renumber(connection: sqlite3.Connection, table: str, ids: list[int]) -> None:
    """Setzt position = Index in ids, nur dort, wo sie abweicht. updated_at bleibt."""
    for index, row_id in enumerate(ids):
        connection.execute(f"update {table} set position = ? where id = ? and position <> ?", (index, row_id, index))


# ---------------------------------------------------------------------------
# Board lesen
# ---------------------------------------------------------------------------

@router.get("/api/board")
async def get_board(session: SessionRequired) -> dict:
    def work(connection: sqlite3.Connection) -> dict:
        columns = connection.execute("select id, title from board_column order by position, id").fetchall()
        cards = connection.execute(
            "select id, column_id, title, body, color, updated_at from board_card order by column_id, position, id"
        ).fetchall()
        cards_by_column: dict[int, list[dict]] = {}
        for card in cards:
            cards_by_column.setdefault(card["column_id"], []).append(card_json(card))
        return {"columns": [{**column_json(column), "cards": cards_by_column.get(column["id"], [])} for column in columns]}

    return await run(work)


# ---------------------------------------------------------------------------
# Spalten
# ---------------------------------------------------------------------------

@router.post("/api/board/columns", status_code=201, dependencies=[Depends(require_own_origin)])
async def post_column(body: ColumnRequest, session: SessionRequired) -> dict:
    def work(connection: sqlite3.Connection) -> dict:
        stamp = now_iso()
        cursor = connection.execute(
            "insert into board_column (title, position, created_at, updated_at) "
            "values (?, (select coalesce(max(position) + 1, 0) from board_column), ?, ?)",
            (body.title, stamp, stamp),
        )
        row = connection.execute("select id, title from board_column where id = ?", (cursor.lastrowid,)).fetchone()
        return {**column_json(row), "cards": []}

    return await run(work)


@router.patch("/api/board/columns/{column_id}", dependencies=[Depends(require_own_origin)])
async def patch_column(column_id: ColumnIdPath, body: ColumnRequest, session: SessionRequired) -> dict:
    def work(connection: sqlite3.Connection) -> dict:
        # updated_at nur, wenn sich der Titel wirklich ändert
        connection.execute(
            "update board_column set title = ?, updated_at = case when title is not ? then ? else updated_at end "
            "where id = ?",
            (body.title, body.title, now_iso(), column_id),
        )
        row = connection.execute("select id, title from board_column where id = ?", (column_id,)).fetchone()
        return column_json(require_row(row, f"Spalte {column_id}"))

    return await run(work)


# Die Karten der Spalte fallen per "on delete cascade" mit weg.
@router.delete("/api/board/columns/{column_id}", status_code=204, dependencies=[Depends(require_own_origin)])
async def delete_column(column_id: ColumnIdPath, session: SessionRequired) -> Response:
    def work(connection: sqlite3.Connection) -> None:
        if connection.execute("delete from board_column where id = ?", (column_id,)).rowcount == 0:
            raise ApiError(404, "not_found", f"Spalte {column_id} gibt es nicht")
        ids = [row["id"] for row in connection.execute("select id from board_column order by position, id")]
        renumber(connection, "board_column", ids)

    await run(work)
    return Response(status_code=204)


# Verschiebt eine Spalte an index (ab 0, zu groß heißt ans Ende) und nummeriert
# alle Spalten lückenlos neu.
@router.post("/api/board/columns/{column_id}/move", status_code=204, dependencies=[Depends(require_own_origin)])
async def move_column(column_id: ColumnIdPath, body: ColumnMoveRequest, session: SessionRequired) -> Response:
    def work(connection: sqlite3.Connection) -> None:
        require_row(connection.execute("select id from board_column where id = ?", (column_id,)).fetchone(), f"Spalte {column_id}")
        others = [
            row["id"]
            for row in connection.execute("select id from board_column where id <> ? order by position, id", (column_id,))
        ]
        others.insert(min(body.index, len(others)), column_id)
        renumber(connection, "board_column", others)

    await run(work)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Karten
# ---------------------------------------------------------------------------

@router.post("/api/board/cards", status_code=201, dependencies=[Depends(require_own_origin)])
async def post_card(body: CardCreateRequest, session: SessionRequired) -> dict:
    def work(connection: sqlite3.Connection) -> dict:
        require_row(
            connection.execute("select id from board_column where id = ?", (body.column_id,)).fetchone(),
            f"Spalte {body.column_id}",
        )
        stamp = now_iso()
        cursor = connection.execute(
            "insert into board_card (column_id, title, body, color, position, created_at, updated_at) "
            "values (?, ?, ?, ?, (select coalesce(max(position) + 1, 0) from board_card where column_id = ?), ?, ?)",
            (body.column_id, body.title, body.body, body.color, body.column_id, stamp, stamp),
        )
        row = connection.execute(
            "select id, title, body, color, updated_at from board_card where id = ?", (cursor.lastrowid,)
        ).fetchone()
        return card_json(row)

    return await run(work)


@router.patch("/api/board/cards/{card_id}", dependencies=[Depends(require_own_origin)])
async def patch_card(card_id: CardIdPath, body: CardUpdateRequest, session: SessionRequired) -> dict:
    def work(connection: sqlite3.Connection) -> dict:
        # In SQLite sehen alle Ausdrücke in SET die alten Werte der Zeile.
        # updated_at ändert sich deshalb nur, wenn Titel, Text oder Farbe neu sind.
        connection.execute(
            "update board_card set "
            "updated_at = case when title is not ? or body is not ? or color is not coalesce(?, color) "
            "then ? else updated_at end, "
            "title = ?, body = ?, color = coalesce(?, color) "
            "where id = ?",
            (body.title, body.body, body.color, now_iso(), body.title, body.body, body.color, card_id),
        )
        row = connection.execute(
            "select id, title, body, color, updated_at from board_card where id = ?", (card_id,)
        ).fetchone()
        return card_json(require_row(row, f"Karte {card_id}"))

    return await run(work)


@router.delete("/api/board/cards/{card_id}", status_code=204, dependencies=[Depends(require_own_origin)])
async def delete_card(card_id: CardIdPath, session: SessionRequired) -> Response:
    def work(connection: sqlite3.Connection) -> None:
        row = require_row(
            connection.execute("select column_id from board_card where id = ?", (card_id,)).fetchone(), f"Karte {card_id}"
        )
        connection.execute("delete from board_card where id = ?", (card_id,))
        ids = [
            entry["id"]
            for entry in connection.execute(
                "select id from board_card where column_id = ? order by position, id", (row["column_id"],)
            )
        ]
        renumber(connection, "board_card", ids)

    await run(work)
    return Response(status_code=204)


# Verschiebt eine Karte an index (ab 0, zu groß heißt ans Ende) in column_id,
# auch in eine andere Spalte. Ziel- und alte Spalte werden lückenlos neu nummeriert.
@router.post("/api/board/cards/{card_id}/move", status_code=204, dependencies=[Depends(require_own_origin)])
async def move_card(card_id: CardIdPath, body: CardMoveRequest, session: SessionRequired) -> Response:
    def work(connection: sqlite3.Connection) -> None:
        card = require_row(
            connection.execute("select column_id from board_card where id = ?", (card_id,)).fetchone(), f"Karte {card_id}"
        )
        require_row(
            connection.execute("select id from board_column where id = ?", (body.column_id,)).fetchone(),
            f"Spalte {body.column_id}",
        )
        source_column_id = card["column_id"]
        connection.execute("update board_card set column_id = ? where id = ?", (body.column_id, card_id))
        others = [
            row["id"]
            for row in connection.execute(
                "select id from board_card where column_id = ? and id <> ? order by position, id", (body.column_id, card_id)
            )
        ]
        others.insert(min(body.index, len(others)), card_id)
        renumber(connection, "board_card", others)
        if source_column_id != body.column_id:
            remaining = [
                row["id"]
                for row in connection.execute(
                    "select id from board_card where column_id = ? order by position, id", (source_column_id,)
                )
            ]
            renumber(connection, "board_card", remaining)

    await run(work)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Sicherung
# ---------------------------------------------------------------------------

def backup_once() -> Path | None:
    """Sichert die Datei nach backups/board-JJJJ-MM-TT.sqlite3, falls es für heute noch keine gibt.

    Das Datum ist das in Berlin. Die Sicherung entsteht über die Backup-API von
    SQLite, ist also auch bei laufenden Zugriffen in sich stimmig. Danach
    bleiben nur die neuesten BACKUP_KEEP Sicherungen liegen.
    """
    folder = data_dir() / BACKUP_FOLDER
    today = datetime.now(ZoneInfo("Europe/Berlin")).date().isoformat()
    target = folder / f"board-{today}.sqlite3"
    created = None
    with lock:
        ensure_schema()
        folder.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            partial = folder / f"{target.name}.part"
            # Ein Rest eines abgebrochenen Versuchs würde backup() blockieren
            partial.unlink(missing_ok=True)
            source = connect()
            try:
                destination = sqlite3.connect(partial)
                try:
                    source.backup(destination)
                    # Die Sicherung als einzelne Datei ohne -wal/-shm, auch wenn sie später geöffnet wird
                    destination.execute("pragma journal_mode = delete")
                finally:
                    destination.close()
            finally:
                source.close()
            partial.replace(target)
            created = target
    # Die Namen enthalten das Datum, alphabetisch ist also auch zeitlich sortiert
        # .part-Reste früherer Tage, z. B. nach einem Absturz zwischen Sichern und Umbenennen
        for leftover in folder.glob("board-*.sqlite3.part"):
            if leftover.name != f"{target.name}.part":
                leftover.unlink(missing_ok=True)
    for old in sorted(folder.glob("board-*.sqlite3"))[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    return created


async def run_backups() -> None:
    """Prüft beim Start und danach stündlich, ob es für heute eine Sicherung gibt. Fehler landen nur im Log."""
    while True:
        try:
            created = await asyncio.to_thread(backup_once)
            if created is not None:
                logger.info("Board gesichert: %s", created.name)
        except Exception as error:
            logger.error("Board nicht gesichert (%s)", type(error).__name__, exc_info=error)
        await asyncio.sleep(BACKUP_CHECK_SECONDS)


def start() -> None:
    global backup_task
    if backup_task is not None and not backup_task.done():
        return
    backup_task = asyncio.create_task(run_backups(), name="board-backup")


async def stop() -> None:
    global backup_task
    if backup_task is None:
        return
    backup_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await backup_task
    backup_task = None
