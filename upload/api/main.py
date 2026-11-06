"""Container 2 des Upload-Tools: Login, Nachschlagedaten und Upload.

Endpunkte und Fehlercodes stehen in der README unter Upload-Tool → Endpunkte.
Container 1 (nginx) leitet alle Anfragen an /api/* unverändert hierher weiter.
Fehlerbehandlung, Origin-Prüfung und Login kommen aus shared/web.py.
"""

import logging
import sys

from fastapi import BackgroundTasks, Depends, Request, Response

from files import remove_unused_files_in_background
from reference import load_reference
from sessions import Session, current_session, fresh_client
from songs import load_song
from upload import update_song, upload_song
from web import create_app, require_own_origin

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

app = create_app()


# ---------------------------------------------------------------------------
# Endpunkte
# ---------------------------------------------------------------------------

@app.get("/api/reference")
async def get_reference(session: Session = Depends(current_session)) -> dict:
    return await load_reference(await fresh_client(session))


@app.get("/api/songs/{song_id}")
async def get_song(song_id: int, session: Session = Depends(current_session)) -> dict:
    return await load_song(await fresh_client(session), song_id)


# Nach einem Upload oder einer Änderung räumt Container 2 im Hintergrund
# Dateien weg, auf die keine Zeile mehr zeigt.
@app.post("/api/upload", status_code=201, dependencies=[Depends(require_own_origin)])
async def post_upload(
    request: Request, background_tasks: BackgroundTasks, session: Session = Depends(current_session)
) -> Response:
    await upload_song(request, session)
    background_tasks.add_task(remove_unused_files_in_background, session)
    return Response(status_code=201)


@app.post("/api/update", status_code=201, dependencies=[Depends(require_own_origin)])
async def post_update(
    request: Request, background_tasks: BackgroundTasks, session: Session = Depends(current_session)
) -> dict:
    release_at = await update_song(request, session)
    background_tasks.add_task(remove_unused_files_in_background, session)
    return {"release_at": release_at}
