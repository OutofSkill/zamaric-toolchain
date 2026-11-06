"""Einstellungen der Entwicklerseite, gelesen aus den Umgebungsvariablen (siehe .env.example)."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Adresse und Publishable Key des Supabase-Projekts. Beides ist kein Secret,
    # der Key steckt auch in der App.
    supabase_url: str
    supabase_publishable_key: str

    # Der Admin-Account, mit dem sich die Entwicklerseite anmeldet.
    # Im Browser wird nur das Passwort eingegeben.
    admin_email: str

    # Eigene Adresse der Website, z. B. http://zamaric-dev.netbird.cloud.
    # Gebraucht für die Origin-Prüfung und für das Secure-Flag am Cookie.
    public_origin: str

    # Eine Session endet nach so vielen Minuten ohne Anfrage.
    session_idle_minutes: int = 120

    # Das .git des Repos auf dem Pi, schreibgeschützt eingehängt. Nur .git,
    # kein Arbeitsbaum: So sieht der Container weder .env-Dateien noch Song-Ordner.
    git_dir: str = "/repo.git"

    # GitHub-Repo für den Status der Actions
    github_repository: str = "OutofSkill/zamaric"

    # Fine-grained Token, nur Lesen: Actions und Metadata, nur dieses Repo.
    # Leer: Der CI-Bereich zeigt "nicht eingerichtet".
    github_token: str = ""

    # Workflow, dessen Läufe angezeigt werden
    github_workflow: str = "analyze.yml"

    # Ordner für das Board (SQLite-Datei) und seine täglichen Sicherungen.
    # Im Container das Docker-Volume board-data.
    board_data_dir: str = "/data"

    @property
    def secure_cookie(self) -> bool:
        return self.public_origin.startswith("https://")


# Fehlt eine Variable, bricht der Container hier beim Start mit einer Meldung ab.
settings = Settings()
