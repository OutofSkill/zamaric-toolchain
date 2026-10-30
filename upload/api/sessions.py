"""Login, Sessions und Login-Sperre.

Der Browser bekommt nur eine zufällige Session-ID als Cookie. Access- und
Refresh-Token bleiben hier im Speicher, je Session in einem eigenen
Supabase-Client.
"""

import logging
import secrets
import time
from dataclasses import dataclass

from fastapi import Request
from supabase import AsyncClient, AsyncClientOptions, AuthApiError, acreate_client

from config import settings
from errors import ApiError

logger = logging.getLogger("upload")

COOKIE_NAME = "session"

# Wie lange ein einzelner Datei-Upload zu Supabase dauern darf, in Sekunden.
# Der Standard des Pakets (20 s) reicht für große MP3s nicht.
STORAGE_TIMEOUT_SECONDS = 300

# Nach so vielen falschen Passwörtern ist der Login für LOCK_SECONDS gesperrt.
MAX_FAILED_LOGINS = 5
LOCK_SECONDS = 5 * 60


@dataclass
class Session:
    session_id: str
    client: AsyncClient
    last_used: float

    def is_idle(self) -> bool:
        return time.monotonic() - self.last_used > settings.session_idle_minutes * 60


# Alle offenen Sessions, Schlüssel ist die Session-ID aus dem Cookie.
# Liegt nur im Speicher: Ein Neustart des Containers meldet alle ab.
# Deshalb darf uvicorn nur mit einem Worker laufen (siehe Dockerfile).
sessions: dict[str, Session] = {}


class LoginGuard:
    """Zählt falsche Passwörter und sperrt den Login danach eine Weile.

    Es gibt nur einen Account, deshalb zählt die Sperre für alle Anfragen
    gemeinsam und nicht pro Gerät.
    """

    def __init__(self) -> None:
        self.failed_attempts = 0
        self.locked_until = 0.0

    def check(self) -> None:
        if time.monotonic() < self.locked_until:
            raise ApiError(429, "too_many_attempts", "Login gesperrt")

    def record_failure(self) -> None:
        self.failed_attempts += 1
        if self.failed_attempts >= MAX_FAILED_LOGINS:
            self.locked_until = time.monotonic() + LOCK_SECONDS
            self.failed_attempts = 0

    def record_success(self) -> None:
        self.failed_attempts = 0


login_guard = LoginGuard()


async def login(password: str) -> str:
    """Meldet ADMIN_EMAIL mit dem Passwort bei Supabase an und gibt die neue Session-ID zurück."""
    login_guard.check()
    remove_idle_sessions()

    client = await acreate_client(
        settings.supabase_url,
        settings.supabase_publishable_key,
        options=AsyncClientOptions(
            # Kein Timer im Hintergrund: fresh_client() erneuert den Token
            # vor jedem Aufruf, wenn er bald abläuft.
            auto_refresh_token=False,
            # Tokens nur im Speicher dieses Clients, nie auf der Platte.
            persist_session=False,
            storage_client_timeout=STORAGE_TIMEOUT_SECONDS,
        ),
    )
    try:
        await client.auth.sign_in_with_password({"email": settings.admin_email, "password": password})
    except AuthApiError as error:
        if error.status == 429:
            raise ApiError(429, "too_many_attempts", "Supabase hat den Login gesperrt") from None
        if error.code == "invalid_credentials":
            login_guard.record_failure()
            raise ApiError(401, "invalid_credentials") from None
        raise

    login_guard.record_success()
    session_id = secrets.token_urlsafe(32)
    sessions[session_id] = Session(session_id, client, time.monotonic())
    logger.info("Login erfolgreich")
    return session_id


async def logout(session: Session) -> None:
    """Beendet die Session hier und bei Supabase."""
    sessions.pop(session.session_id, None)
    try:
        # "local" meldet nur diese Sitzung ab. Der Standard "global" würde den
        # Account auch auf allen anderen Geräten abmelden.
        await session.client.auth.sign_out({"scope": "local"})
    except Exception as error:
        logger.warning("Abmelden bei Supabase fehlgeschlagen (%s)", type(error).__name__)


def current_session(request: Request) -> Session:
    """FastAPI-Abhängigkeit: die Session zum Cookie, sonst 401.

    Zählt als Aktivität und verlängert die Session.
    """
    session = existing_session(request)
    session.last_used = time.monotonic()
    return session


def existing_session(request: Request) -> Session:
    """FastAPI-Abhängigkeit: die Session zum Cookie, sonst 401.

    Verlängert die Session nicht. Für die regelmäßige Prüfung der Website,
    damit ein offener Tab die Session nicht ewig am Leben hält.
    """
    session_id = request.cookies.get(COOKIE_NAME)
    session = sessions.get(session_id) if session_id else None
    if session is None:
        raise ApiError(401, "unauthorized")
    if session.is_idle():
        sessions.pop(session.session_id, None)
        raise ApiError(401, "unauthorized", "Session abgelaufen")
    return session


async def fresh_client(session: Session) -> AsyncClient:
    """Gibt den Supabase-Client der Session mit gültigem Access-Token zurück.

    get_session() erneuert den Token, wenn er in den nächsten Sekunden abläuft.
    Lehnt Supabase das ab (z. B. weil der Refresh-Token widerrufen wurde),
    ist die Session vorbei.
    """
    try:
        current = await session.client.auth.get_session()
    except AuthApiError as error:
        current = None
        logger.warning("Token-Erneuerung abgelehnt (%s)", error.code)
    if current is None:
        sessions.pop(session.session_id, None)
        raise ApiError(401, "unauthorized", "Token nicht erneuerbar")
    return session.client


def remove_idle_sessions() -> None:
    for session_id in [key for key, session in sessions.items() if session.is_idle()]:
        del sessions[session_id]
