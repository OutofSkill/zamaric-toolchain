"""Das Manifest, das die Website mit dem Upload schickt, und seine Regeln.

Die Website prüft dasselbe schon, aber wer eine Session hat, kann sie umgehen.
Deshalb prüft Container 2 hier noch einmal alles, was die Daten in der DB
kaputt machen könnte. import_song sichert die Regeln ein drittes Mal ab.
"""

import re
import unicodedata
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_NAME_LENGTH = 100

# Gleiche Regel wie letter_name_check in der DB
LETTER_PATTERN = re.compile(r"[A-Z]|[0-9]+|D\.S\.|D\.C\.|Coda")

# Gleiche Regel wie song_publisher_url_check in der DB: nur https, eine
# Domain (keine IP, kein Port, kein "name@" davor) und danach nur sichtbare
# ASCII-Zeichen. So kommt kein javascript:, kein unsichtbares Zeichen und
# keine Domain mit ähnlich aussehenden fremden Buchstaben in die App.
MAX_URL_LENGTH = 2000
PUBLISHER_URL_PATTERN = re.compile(
    r"https://([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]([/?#][!-~]*)?"
)


def check_clean_name(value: str) -> str:
    """Gleiche Regel wie private.is_clean_name() in der DB."""
    if value == "":
        raise ValueError("ist leer")
    if len(value) > MAX_NAME_LENGTH:
        raise ValueError(f"ist länger als {MAX_NAME_LENGTH} Zeichen")
    if value != value.strip():
        raise ValueError("hat Leerzeichen am Anfang oder Ende")
    # Cc = Steuerzeichen, Cf = Formatzeichen (z. B. Leerzeichen ohne Breite)
    if any(unicodedata.category(character) in ("Cc", "Cf") for character in value):
        raise ValueError("enthält ein unsichtbares Zeichen")
    return value


CleanName = Annotated[str, AfterValidator(check_clean_name)]


def check_publisher_url(url: str) -> str:
    if len(url) > MAX_URL_LENGTH:
        raise ValueError(f"ist länger als {MAX_URL_LENGTH} Zeichen")
    if not PUBLISHER_URL_PATTERN.fullmatch(url):
        raise ValueError("ist kein erlaubter https-Link")
    return url


PublisherUrl = Annotated[str, AfterValidator(check_publisher_url)]


def check_path(path: str, folder: str, extension: str) -> str:
    """Der Pfad dient nur der Zuordnung zur Datei, muss aber zur Art der Datei passen."""
    if not path.startswith(folder) or not path.lower().endswith(extension):
        raise ValueError(f"muss mit {folder!r} beginnen und auf {extension!r} enden")
    return path


AudioPath = Annotated[str, AfterValidator(lambda path: check_path(path, "Playbacks/", ".mp3"))]
PdfPath = Annotated[str, AfterValidator(lambda path: check_path(path, "Noten/", ".pdf"))]


class StrictModel(BaseModel):
    # strict: keine Umwandlung, "3" ist z. B. keine Zahl.
    # forbid: unbekannte Felder sind ein Fehler.
    model_config = ConfigDict(strict=True, extra="forbid")


class Letter(StrictModel):
    name: str
    position_ms: int = Field(ge=0)
    count_in: CleanName

    @field_validator("name")
    @classmethod
    def check_name(cls, name: str) -> str:
        if not LETTER_PATTERN.fullmatch(name):
            raise ValueError(f"Buchstabe {name!r} ist ungültig")
        return name


class CountIn(StrictModel):
    path: AudioPath
    name: CleanName
    # Wird beim Upload durch die mit mutagen gemessene Länge ersetzt.
    duration_ms: int


class PlaybackFields(StrictModel):
    """Was ein neues und ein geändertes Playback gemeinsam haben."""

    type: CleanName
    # Wird beim Upload durch die mit mutagen gemessene Länge ersetzt.
    duration_ms: int
    instrument_mode: Literal["all", "only", "except"]
    instrument_ids: list[int]
    letters: list[Letter]

    @model_validator(mode="after")
    def check_instruments_and_letters(self) -> "PlaybackFields":
        if (self.instrument_mode == "all") != (len(self.instrument_ids) == 0):
            raise ValueError(f"instrument_ids passen nicht zu instrument_mode bei {self.type!r}")
        if len(set(self.instrument_ids)) != len(self.instrument_ids):
            raise ValueError(f"Instrument doppelt bei {self.type!r}")
        positions = [letter.position_ms for letter in self.letters]
        if any(later <= earlier for earlier, later in zip(positions, positions[1:])):
            raise ValueError(f"Buchstaben nicht streng aufsteigend bei {self.type!r}")
        return self


class Playback(PlaybackFields):
    path: AudioPath


class ChangedPlayback(PlaybackFields):
    # null = die MP3 bleibt, nur Buchstaben oder Sichtbarkeit ändern sich
    path: AudioPath | None


class SheetMusic(StrictModel):
    path: PdfPath
    part_id: int
    level_id: int


class Manifest(StrictModel):
    category_id: int
    song_name: CleanName
    # null = frühestmögliche Freigabe, sonst Zeitpunkt mit Zeitzone
    release_at: AwareDatetime | None
    # Verlag und Link zu den Verlagsnoten, beide freiwillig (null = keine Angabe)
    publisher_name: CleanName | None
    publisher_url: PublisherUrl | None
    count_ins: list[CountIn]
    playbacks: list[Playback]
    sheet_music: list[SheetMusic]

    @model_validator(mode="after")
    def check_song(self) -> "Manifest":
        if not self.playbacks and not self.sheet_music:
            raise ValueError("weder Playbacks noch Noten")

        # Einmalig im Song, ohne Rücksicht auf Groß-/Kleinschreibung wie die
        # unique-Indizes auf lower(...) in der DB
        if has_duplicates([playback.type.lower() for playback in self.playbacks]):
            raise ValueError("type doppelt")
        if has_duplicates([count_in.name.lower() for count_in in self.count_ins]):
            raise ValueError("Einzähler doppelt")
        if has_duplicates([(sheet.part_id, sheet.level_id) for sheet in self.sheet_music]):
            raise ValueError("Noten mit gleicher Stimme und gleichem Level doppelt")
        if has_duplicates(self.all_paths()):
            raise ValueError("Pfad doppelt")

        count_in_names = {count_in.name.lower() for count_in in self.count_ins}
        for playback in self.playbacks:
            for letter in playback.letters:
                if letter.count_in.lower() not in count_in_names:
                    raise ValueError(f"Einzähler {letter.count_in!r} fehlt bei {playback.type!r}")
        return self

    def all_paths(self) -> list[str]:
        return [
            *(count_in.path for count_in in self.count_ins),
            *(playback.path for playback in self.playbacks),
            *(sheet.path for sheet in self.sheet_music),
        ]


class UpdateManifest(StrictModel):
    """Änderung an einem bestehenden Song. Die Listen enthalten nur neue und
    geänderte Einträge, alles andere bleibt, wie es ist. update_song in der DB
    ordnet sie den bestehenden Zeilen zu und prüft die Einzähler der Buchstaben,
    denn die können auch zu unveränderten Einzählern gehören."""

    song_id: int
    release_at: AwareDatetime | None
    publisher_name: CleanName | None
    publisher_url: PublisherUrl | None
    count_ins: list[CountIn]
    playbacks: list[ChangedPlayback]
    sheet_music: list[SheetMusic]

    @model_validator(mode="after")
    def check_changes(self) -> "UpdateManifest":
        if has_duplicates([playback.type.lower() for playback in self.playbacks]):
            raise ValueError("type doppelt")
        if has_duplicates([count_in.name.lower() for count_in in self.count_ins]):
            raise ValueError("Einzähler doppelt")
        if has_duplicates([(sheet.part_id, sheet.level_id) for sheet in self.sheet_music]):
            raise ValueError("Noten mit gleicher Stimme und gleichem Level doppelt")
        if has_duplicates(self.all_paths()):
            raise ValueError("Pfad doppelt")
        return self

    def all_paths(self) -> list[str]:
        return [
            *(count_in.path for count_in in self.count_ins),
            *(playback.path for playback in self.playbacks if playback.path is not None),
            *(sheet.path for sheet in self.sheet_music),
        ]


def has_duplicates(values: list) -> bool:
    return len(set(values)) != len(values)
