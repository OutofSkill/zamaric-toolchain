"""Einstellungen von Container 2, gelesen aus den Umgebungsvariablen (siehe .env.example)."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Adresse und Publishable Key des Supabase-Projekts. Beides ist kein Secret,
    # der Key steckt auch in der App.
    supabase_url: str
    supabase_publishable_key: str

    # Der einzige Account, mit dem sich das Upload-Tool anmeldet.
    # Im Browser wird nur das Passwort eingegeben.
    admin_email: str

    # Eigene Adresse der Website, z. B. http://zamaric-upload.netbird.cloud.
    # Gebraucht für die Origin-Prüfung und für das Secure-Flag am Cookie.
    public_origin: str

    # Eine Session endet nach so vielen Minuten ohne Anfrage.
    session_idle_minutes: int = 120

    @property
    def secure_cookie(self) -> bool:
        return self.public_origin.startswith("https://")


# Fehlt eine Variable, bricht der Container hier beim Start mit einer Meldung ab.
settings = Settings()
