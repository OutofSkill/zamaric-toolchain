"""POST /api/upload: Song prüfen, Dateien in die Buckets laden, Zeilen über import_song eintragen.

Die Schritte entsprechen dem Ablauf in der README (Upload-Tool → POST /api/upload).
"""

import logging
import uuid

import httpx
from fastapi import Request
from mutagen import MutagenError
from mutagen.mp3 import MP3
from pydantic import TypeAdapter, ValidationError

# request.form() liefert Starlettes UploadFile, nicht die Unterklasse von FastAPI
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from supabase import PostgrestAPIError, StorageException

from errors import ApiError
from manifest import Manifest
from sessions import Session, fresh_client

logger = logging.getLogger("upload")

# Obergrenzen, siehe README → Sicherheit. Die Grenze für die ganze Anfrage
# (500 MB) setzt nginx in Container 1, bevor die Anfrage hier ankommt.
MAX_FILES = 300
MAX_FILE_BYTES = 50 * 1024 * 1024
# Für die Textfelder manifest und paths
MAX_FIELD_BYTES = 1024 * 1024

AUDIO_BUCKET = "audio"
SHEET_MUSIC_BUCKET = "sheet_music"

# Fehler von import_song (raise exception '<code>') → Antwort an den Browser
IMPORT_ERRORS = {
    "song_exists": 409,
    "invalid_manifest": 422,
    "forbidden": 403,
}

path_list = TypeAdapter(list[str])


async def upload_song(request: Request, session: Session) -> None:
    # Schritt 1 (Session prüfen) hat FastAPI schon über current_session erledigt.
    try:
        form_context = request.form(max_files=MAX_FILES, max_fields=10, max_part_size=MAX_FIELD_BYTES)
        async with form_context as form:
            manifest, files_by_path = read_form(form)
            try:
                await import_files(session, manifest, files_by_path)
            except ApiError as error:
                error.song = manifest.song_name
                raise
    except HTTPException as error:
        # Starlette meldet Verstöße gegen die Grenzen von request.form() als
        # HTTPException 400. Zu viele oder zu große Teile sind "too_large",
        # alles andere ist ein kaputtes Formular.
        if "Too many files" in str(error.detail) or "exceeded maximum size" in str(error.detail):
            raise ApiError(413, "too_large", str(error.detail)) from None
        raise ApiError(422, "invalid_manifest", str(error.detail)) from None


def read_form(form) -> tuple[Manifest, dict[str, UploadFile]]:
    """Schritte 2 und 3: Manifest prüfen und jeder Datei ihren Pfad zuordnen."""
    manifest_text = form.get("manifest")
    paths_text = form.get("paths")
    files = form.getlist("files")
    if not isinstance(manifest_text, str) or not isinstance(paths_text, str):
        raise ApiError(422, "invalid_manifest", "Feld manifest oder paths fehlt")
    if not all(isinstance(file, UploadFile) for file in files):
        raise ApiError(422, "invalid_manifest", "Feld files enthält Text statt einer Datei")

    try:
        manifest = Manifest.model_validate_json(manifest_text)
        paths = path_list.validate_json(paths_text)
    except ValidationError as error:
        raise ApiError(422, "invalid_manifest", str(error)) from None

    # Der Dateiname der Felder files wird nicht ausgewertet. Die Zuordnung
    # läuft nur über die Reihenfolge in paths.
    if len(paths) != len(files):
        raise ApiError(422, "invalid_manifest", f"{len(paths)} Pfade, aber {len(files)} Dateien")
    if len(set(paths)) != len(paths):
        raise ApiError(422, "unexpected_file", "Pfad in paths doppelt")
    expected = set(manifest.all_paths())
    missing = expected - set(paths)
    unexpected = set(paths) - expected
    if missing:
        raise ApiError(422, "missing_file", f"fehlt: {sorted(missing)[0]!r}")
    if unexpected:
        raise ApiError(422, "unexpected_file", f"nicht im Manifest: {sorted(unexpected)[0]!r}")

    files_by_path = dict(zip(paths, files))
    for path, file in files_by_path.items():
        if (file.size or 0) > MAX_FILE_BYTES:
            raise ApiError(413, "too_large", f"{path!r} ist größer als 50 MB")
    return manifest, files_by_path


async def import_files(session: Session, manifest: Manifest, files_by_path: dict[str, UploadFile]) -> None:
    # Schritte 4 und 5: erst alles prüfen und messen, dann hochladen. So
    # hinterlässt eine kaputte Datei keine schon hochgeladenen Dateien im Bucket.
    durations = {}
    for count_in in manifest.count_ins:
        durations[count_in.path] = measure_mp3(count_in.path, files_by_path[count_in.path])
    for playback in manifest.playbacks:
        durations[playback.path] = measure_mp3(playback.path, files_by_path[playback.path])
        for letter in playback.letters:
            if letter.position_ms > durations[playback.path]:
                raise ApiError(422, "invalid_manifest", f"Buchstabe {letter.name!r} hinter dem Ende von {playback.path!r}")
    for sheet in manifest.sheet_music:
        check_pdf(sheet.path, files_by_path[sheet.path])

    # Schritt 6: Dateien hochladen. Im Bucket heißen sie nur <uuid>.mp3 bzw.
    # <uuid>.pdf, der Pfad aus dem Ordner des Partners taucht dort nicht auf.
    stored_names = {}
    for count_in in manifest.count_ins:
        stored_names[count_in.path] = await store_file(session, AUDIO_BUCKET, files_by_path[count_in.path])
    for playback in manifest.playbacks:
        stored_names[playback.path] = await store_file(session, AUDIO_BUCKET, files_by_path[playback.path])
    for sheet in manifest.sheet_music:
        stored_names[sheet.path] = await store_file(session, SHEET_MUSIC_BUCKET, files_by_path[sheet.path])

    # Schritt 7: alle Zeilen in einer Transaktion eintragen
    song_id = await call_import_song(session, build_payload(manifest, stored_names, durations))
    logger.info("Song %r hochgeladen (ID %s, %d Dateien)", manifest.song_name, song_id, len(stored_names))


def measure_mp3(path: str, file: UploadFile) -> int:
    """Liest die MP3 mit mutagen und gibt ihre Länge in Millisekunden zurück."""
    try:
        audio = MP3(file.file)
    except MutagenError as error:
        raise ApiError(422, "invalid_file_content", f"{path!r}: {error}") from None
    finally:
        file.file.seek(0)
    duration_ms = round(audio.info.length * 1000)
    if duration_ms <= 0:
        raise ApiError(422, "invalid_file_content", f"{path!r} hat keine Länge")
    return duration_ms


def check_pdf(path: str, file: UploadFile) -> None:
    start = file.file.read(4)
    file.file.seek(0)
    if start != b"%PDF":
        raise ApiError(422, "invalid_file_content", f"{path!r} beginnt nicht mit %PDF")


async def store_file(session: Session, bucket: str, file: UploadFile) -> str:
    """Lädt eine Datei unter einem zufälligen Namen hoch und gibt den Namen zurück."""
    if bucket == AUDIO_BUCKET:
        name, content_type = f"{uuid.uuid4()}.mp3", "audio/mpeg"
    else:
        name, content_type = f"{uuid.uuid4()}.pdf", "application/pdf"

    # Den Content-Type immer selbst setzen, nie den aus der Anfrage übernehmen
    file_options = {"content-type": content_type, "upsert": "false"}
    client = await fresh_client(session)
    try:
        await client.storage.from_(bucket).upload(name, await file.read(), file_options)
    except (StorageException, httpx.HTTPError) as error:
        raise ApiError(502, "storage_failed", f"{bucket}/{name}: {error}") from None
    return name


def build_payload(manifest: Manifest, stored_names: dict[str, str], durations: dict[str, int]) -> dict:
    """Das Manifest für import_song: Pfade durch die Namen im Bucket ersetzt, Längen gemessen."""
    return {
        "category_id": manifest.category_id,
        "song_name": manifest.song_name,
        "release_at": manifest.release_at.isoformat() if manifest.release_at else None,
        "count_ins": [
            {
                "path": stored_names[count_in.path],
                "name": count_in.name,
                "duration_ms": durations[count_in.path],
            }
            for count_in in manifest.count_ins
        ],
        "playbacks": [
            {
                "path": stored_names[playback.path],
                "type": playback.type,
                "duration_ms": durations[playback.path],
                "instrument_mode": playback.instrument_mode,
                "instrument_ids": playback.instrument_ids,
                "letters": [letter.model_dump() for letter in playback.letters],
            }
            for playback in manifest.playbacks
        ],
        "sheet_music": [
            {
                "path": stored_names[sheet.path],
                "part_id": sheet.part_id,
                "level_id": sheet.level_id,
            }
            for sheet in manifest.sheet_music
        ],
    }


async def call_import_song(session: Session, payload: dict) -> int:
    client = await fresh_client(session)
    try:
        response = await client.rpc("import_song", {"payload": payload}).execute()
    except PostgrestAPIError as error:
        status = IMPORT_ERRORS.get(error.message)
        detail = f"{error.message}: {error.details}"
        if status is None:
            raise ApiError(502, "database_failed", detail) from None
        raise ApiError(status, error.message, detail) from None
    except httpx.HTTPError as error:
        raise ApiError(502, "database_failed", str(error)) from None
    return response.data
