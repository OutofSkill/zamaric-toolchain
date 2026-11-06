"""Fehler, die mit einem festen Code an den Browser gehen."""


class ApiError(Exception):
    """Antwortet mit `status` und `{"error": code}`.

    `detail` und `song` landen nur im Log, nie in der Antwort. So sieht der
    Browser keine Fehlermeldungen von Supabase oder Python.
    """

    def __init__(self, status: int, code: str, detail: str | None = None) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.detail = detail
        self.song: str | None = None
