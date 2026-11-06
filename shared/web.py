"""Gemeinsamer Rahmen beider Tools: FastAPI-App, Fehlerbehandlung, Origin-Prüfung, Login.

Fehlercodes und Endpunkte stehen in der README unter Upload-Tool → Endpunkte
bzw. Entwicklerseite.
"""

import logging

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException

import sessions
from config import settings
from errors import ApiError
from sessions import COOKIE_NAME, Session, current_session, existing_session

logger = logging.getLogger("zamaric")


# ---------------------------------------------------------------------------
# Origin-Prüfung: Jeder POST muss von der eigenen Website kommen. So kann eine
# fremde Seite, die der Partner gerade offen hat, nicht in seinem Namen
# hochladen. Ergänzt SameSite=Strict am Cookie.
# ---------------------------------------------------------------------------

def require_own_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin != settings.public_origin:
        raise ApiError(403, "forbidden", f"fremder Origin {origin!r}")


class LoginRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    password: str = Field(min_length=1, max_length=1000)


def create_app(lifespan=None) -> FastAPI:
    # Ohne /docs und /openapi.json: Der Browser soll nichts über den Aufbau erfahren.
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    # -----------------------------------------------------------------------
    # Fehlerbehandlung: Jede Antwort hat einen festen Code, Details nur im Log.
    # Nie Token, Passwort, Cookie oder Header loggen.
    # -----------------------------------------------------------------------

    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, error: ApiError) -> JSONResponse:
        song = f" song={error.song!r}" if error.song else ""
        detail = f" ({error.detail})" if error.detail else ""
        logger.warning("%s %s → %s %s%s%s", request.method, request.url.path, error.status, error.code, song, detail)
        return JSONResponse({"error": error.code}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def handle_invalid_request(request: Request, error: RequestValidationError) -> JSONResponse:
        # Nur die betroffenen Felder loggen, nie die Werte: darin steht beim Login das Passwort.
        fields = ", ".join(".".join(str(part) for part in item["loc"]) for item in error.errors())
        logger.warning("%s %s → 422 invalid_request (%s)", request.method, request.url.path, fields)
        return JSONResponse({"error": "invalid_request"}, status_code=422)

    @app.exception_handler(HTTPException)
    async def handle_http_error(request: Request, error: HTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(error.status_code, "invalid_request")
        return JSONResponse({"error": code}, status_code=error.status_code)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, error: Exception) -> JSONResponse:
        logger.error("%s %s → 500 internal_error (%s)", request.method, request.url.path, type(error).__name__, exc_info=error)
        return JSONResponse({"error": "internal_error"}, status_code=500)

    # -----------------------------------------------------------------------
    # Login
    # -----------------------------------------------------------------------

    @app.post("/api/login", status_code=204, dependencies=[Depends(require_own_origin)])
    async def post_login(body: LoginRequest, response: Response) -> None:
        session_id = await sessions.login(body.password)
        response.set_cookie(
            COOKIE_NAME,
            session_id,
            httponly=True,
            samesite="strict",
            secure=settings.secure_cookie,
            path="/",
        )

    @app.post("/api/logout", status_code=204, dependencies=[Depends(require_own_origin)])
    async def post_logout(response: Response, session: Session = Depends(current_session)) -> None:
        await sessions.logout(session)
        response.delete_cookie(COOKIE_NAME, path="/", secure=settings.secure_cookie, httponly=True, samesite="strict")

    # Nur "noch angemeldet?" für die Website: 204 oder 401. Verlängert die Session
    # nicht und fragt Supabase nicht.
    @app.get("/api/session", status_code=204, dependencies=[Depends(existing_session)])
    async def get_session_status() -> None:
        return None

    return app
