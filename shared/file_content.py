import struct
from typing import BinaryIO

from mutagen import MutagenError
from mutagen.mp3 import MP3

PDF_START = b"%PDF"
PDF_END = b"%%EOF"
PDF_END_WINDOW_BYTES = 1024


class InvalidFileContent(ValueError):
    pass


def mp3_duration_ms(file: BinaryIO) -> int:
    try:
        audio = MP3(file)
    except (MutagenError, struct.error, ValueError, IndexError, OverflowError, EOFError) as error:
        raise InvalidFileContent(f"nicht lesbar: {error}") from None
    duration_ms = round(audio.info.length * 1000)
    if duration_ms <= 0:
        raise InvalidFileContent("hat keine Länge")
    return duration_ms


def is_pdf_start(start: bytes) -> bool:
    return start.startswith(PDF_START)


def has_pdf_end(tail: bytes) -> bool:
    return PDF_END in tail[-PDF_END_WINDOW_BYTES:]
