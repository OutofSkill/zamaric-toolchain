"""Container 2 der Entwicklerseite: Board, Datenbank-Prüfungen, Repo und Server-Status.

Endpunkte und Fehlercodes stehen in der README unter Entwicklerseite.
Container 1 (nginx) leitet alle Anfragen an /api/* unverändert hierher weiter.
Fehlerbehandlung, Origin-Prüfung und Login kommen aus shared/web.py.
"""

import logging
import sys
from contextlib import asynccontextmanager

import board
import database
import monitor
import overview
import repo
from web import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
# Sonst schreibt httpx jede Messung der Antwortzeit ins Log, eine Zeile pro Minute
logging.getLogger("httpx").setLevel(logging.WARNING)


# Die Messung der Antwortzeit und die tägliche Sicherung des Boards laufen,
# solange der Container läuft, auch ohne Login.
@asynccontextmanager
async def lifespan(app):
    monitor.start()
    board.start()
    try:
        yield
    finally:
        await board.stop()
        await monitor.stop()


app = create_app(lifespan=lifespan)
app.include_router(board.router)
app.include_router(database.router)
app.include_router(repo.router)
app.include_router(monitor.router)
app.include_router(overview.router)
