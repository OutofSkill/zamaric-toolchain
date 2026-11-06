"""POST /api/upload und POST /api/update: Song prüfen, Dateien in die Buckets laden, Zeilen eintragen.

Das Aufräumen im Bucket danach liegt in shared/files.py.

Neue Songs trägt import_song ein, Änderungen an bestehenden update_song. Die
Schritte entsprechen dem Ablauf in der README (Upload-Tool → POST /api/upload).
"""

import hashlib
import logging
import uuid

import httpx
from fastapi import Request
from mutagen import MutagenError
from mutagen.mp3 import MP3
from pydantic import BaseModel, TypeAdapter, ValidationError

# request.form() liefert Starlettes UploadFile, nicht die Unterklasse von FastAPI
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from supabase import PostgrestAPIError, StorageException

from errors import ApiError
from manifest import Manifest, UpdateManifest
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

# Fehler von import_song und update_song (raise exception '<code>') → Antwort an den Browser
DATABASE_ERRORS = {
    "song_exists": 409,
    "invalid_manifest": 422,
    "forbidden": 403,
}

path_list = TypeAdapter(list[str])


async def upload_song(request: Request, session: Session) -> None:
    """Neuer Song. Schritt 1 (Session prüfen) hat FastAPI schon über current_session erledigt."""
    await receive(request, Manifest, lambda manifest, files: import_files(session, manifest, files))


async def update_song(request: Request, session: Session) -> str:
    """Änderung an einem bestehenden Song. Gibt den Zeitpunkt zurück, ab dem sie sichtbar ist."""
    return await receive(request, UpdateManifest, lambda manifest, files: update_files(session, manifest, files))


async def receive(request: Request, model: type[BaseModel], handle):
    try:
        form_context = request.form(max_files=MAX_FILES, max_fields=10, max_part_size=MAX_FIELD_BYTES)
        async with form_context as form:
            manifest, files_by_path = read_form(form, model)
            try:
                return await handle(manifest, files_by_path)
            except ApiError as error:
                error.song = getattr(manifest, "song_name", None) or f"ID {manifest.song_id}"
                raise
    except HTTPException as error:
        # Starlette meldet Verstöße gegen die Grenzen von request.form() als
        # HTTPException 400. Zu viele oder zu große Teile sind "too_large",
        # alles andere ist ein kaputtes Formular.
        if "Too many files" in str(error.detail) or "exceeded maximum size" in str(error.detail):
            raise ApiError(413, "too_large", str(error.detail)) from None
        raise ApiError(422, "invalid_manifest", str(error.detail)) from None


def read_form(form, model: type[BaseModel]) -> tuple[BaseModel, dict[str, UploadFile]]:
    """Schritte 2 und 3: Manifest prüfen und jeder Datei ihren Pfad zuordnen."""
    manifest_text = form.get("manifest")
    paths_text = form.get("paths")
    files = form.getlist("files")
    if not isinstance(manifest_text, str) or not isinstance(paths_text, str):
        raise ApiError(422, "invalid_manifest", "Feld manifest oder paths fehlt")
    if not all(isinstance(file, UploadFile) for file in files):
        raise ApiError(422, "invalid_manifest", "Feld files enthält Text statt einer Datei")

    try:
        manifest = model.model_validate_json(manifest_text)
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
    durations = measure_files(manifest, files_by_path)
    hashes = {path: file_sha256(file) for path, file in files_by_path.items()}
    stored_names = await store_files(session, manifest, files_by_path)

    # Schritt 7: alle Zeilen in einer Transaktion eintragen
    payload = {
        "category_id": manifest.category_id,
        "song_name": manifest.song_name,
        "release_at": manifest.release_at.isoformat() if manifest.release_at else None,
        "publisher_name": manifest.publisher_name,
        "publisher_url": manifest.publisher_url,
        **file_entries(manifest, stored_names, durations, hashes),
    }
    song_id = await call_database(session, "import_song", payload)
    logger.info("Song %r hochgeladen (ID %s, %d Dateien)", manifest.song_name, song_id, len(stored_names))


async def update_files(session: Session, manifest: UpdateManifest, files_by_path: dict[str, UploadFile]) -> str:
    durations = measure_files(manifest, files_by_path)
    hashes = {path: file_sha256(file) for path, file in files_by_path.items()}
    stored_names = await store_files(session, manifest, files_by_path)

    payload = {
        "song_id": manifest.song_id,
        "release_at": manifest.release_at.isoformat() if manifest.release_at else None,
        "publisher_name": manifest.publisher_name,
        "publisher_url": manifest.publisher_url,
        **file_entries(manifest, stored_names, durations, hashes),
    }
    release_at = await call_database(session, "update_song", payload)
    logger.info("Song ID %s geändert (%d Dateien, sichtbar ab %s)", manifest.song_id, len(stored_names), release_at)
    return release_at


def measure_files(manifest: Manifest | UpdateManifest, files_by_path: dict[str, UploadFile]) -> dict[str, int]:
    """Schritte 4 und 5: erst alles prüfen und messen, dann hochladen. So
    hinterlässt eine kaputte Datei keine schon hochgeladenen Dateien im Bucket."""
    durations = {}
    for count_in in manifest.count_ins:
        durations[count_in.path] = measure_mp3(count_in.path, files_by_path[count_in.path])
    for playback in manifest.playbacks:
        # Ohne path bleibt die MP3, die Buchstaben prüft dann update_song gegen ihre Länge
        if playback.path is None:
            continue
        durations[playback.path] = measure_mp3(playback.path, files_by_path[playback.path])
        for letter in playback.letters:
            if letter.position_ms > durations[playback.path]:
                raise ApiError(422, "invalid_manifest", f"Buchstabe {letter.name!r} hinter dem Ende von {playback.path!r}")
    for sheet in manifest.sheet_music:
        check_pdf(sheet.path, files_by_path[sheet.path])
    return durations


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


def file_sha256(file: UploadFile) -> str:
    """Prüfsumme der Datei. Container 2 rechnet sie selbst, statt der Website zu glauben."""
    digest = hashlib.sha256()
    for chunk in iter(lambda: file.file.read(1024 * 1024), b""):
        digest.update(chunk)
    file.file.seek(0)
    return digest.hexdigest()


async def store_files(session: Session, manifest: Manifest | UpdateManifest, files_by_path: dict[str, UploadFile]) -> dict[str, str]:
    """Schritt 6: Dateien hochladen. Im Bucket heißen sie nur <uuid>.mp3 bzw.
    <uuid>.pdf, der Pfad aus dem Ordner des Partners taucht dort nicht auf."""
    stored_names = {}
    for count_in in manifest.count_ins:
        stored_names[count_in.path] = await store_file(session, AUDIO_BUCKET, files_by_path[count_in.path])
    for playback in manifest.playbacks:
        if playback.path is not None:
            stored_names[playback.path] = await store_file(session, AUDIO_BUCKET, files_by_path[playback.path])
    for sheet in manifest.sheet_music:
        stored_names[sheet.path] = await store_file(session, SHEET_MUSIC_BUCKET, files_by_path[sheet.path])
    return stored_names


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


def file_entries(
    manifest: Manifest | UpdateManifest,
    stored_names: dict[str, str],
    durations: dict[str, int],
    hashes: dict[str, str],
) -> dict:
    """Einzähler, Playbacks und Noten für die DB: Pfade durch die Namen im Bucket
    ersetzt, Längen gemessen, Prüfsummen gerechnet. Ein Playback ohne path
    behält seine MP3, update_song übernimmt dann Länge und Prüfsumme."""
    return {
        "count_ins": [
            {
                "path": stored_names[count_in.path],
                "name": count_in.name,
                "duration_ms": durations[count_in.path],
                "sha256": hashes[count_in.path],
            }
            for count_in in manifest.count_ins
        ],
        "playbacks": [
            {
                "path": stored_names[playback.path] if playback.path else None,
                "type": playback.type,
                "duration_ms": durations[playback.path] if playback.path else None,
                "sha256": hashes[playback.path] if playback.path else None,
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
                "sha256": hashes[sheet.path],
            }
            for sheet in manifest.sheet_music
        ],
    }


async def call_database(session: Session, function: str, payload: dict):
    client = await fresh_client(session)
    try:
        response = await client.rpc(function, {"payload": payload}).execute()
    except PostgrestAPIError as error:
        status = DATABASE_ERRORS.get(error.message)
        detail = f"{error.message}: {error.details}"
        if status is None:
            raise ApiError(502, "database_failed", detail) from None
        raise ApiError(status, error.message, detail) from None
    except httpx.HTTPError as error:
        raise ApiError(502, "database_failed", str(error)) from None
    return response.data
