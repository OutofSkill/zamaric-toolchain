"""GET /api/latency: Antwortzeit von Supabase, gemessen vom Pi aus.

Ein Hintergrund-Task fragt jede Minute /auth/v1/health ab, ohne Anmeldung und
nur mit dem Publishable Key, so wie die App prüft, ob der Server erreichbar
ist. Die Messwerte der letzten 24 Stunden liegen nur im Speicher: Ein Neustart
von Container 2 leert den Verlauf.

main.py startet den Task im lifespan mit start() und beendet ihn mit stop().
"""

import asyncio
import contextlib
import logging
import time
from collections import deque
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends

from config import settings
from sessions import existing_session

logger = logging.getLogger("zamaric")

router = APIRouter()

INTERVAL_SECONDS = 60
TIMEOUT_SECONDS = 10
# 24 Stunden bei einer Messung pro Minute
MAX_SAMPLES = 24 * 60

samples: deque[dict] = deque(maxlen=MAX_SAMPLES)
task: asyncio.Task | None = None
# Für das Log: nur Wechsel zwischen erreichbar und nicht erreichbar melden,
# nicht jede einzelne Messung
last_ok: bool | None = None


async def measure(client: httpx.AsyncClient) -> dict:
    """Eine Messung. Erreichbar heißt wie in der App: Antwort mit Status unter 500."""
    measured_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    try:
        response = await client.get(
            f"{settings.supabase_url}/auth/v1/health",
            headers={"apikey": settings.supabase_publishable_key},
        )
    except httpx.HTTPError as error:
        return {"at": measured_at, "ms": None, "ok": False, "reason": type(error).__name__}
    milliseconds = round((time.perf_counter() - started) * 1000)
    ok = response.status_code < 500
    return {"at": measured_at, "ms": milliseconds, "ok": ok, "reason": None if ok else f"Status {response.status_code}"}


def record(sample: dict) -> None:
    global last_ok
    reason = sample.pop("reason")
    samples.append(sample)
    if sample["ok"] == last_ok:
        return
    if not sample["ok"]:
        logger.warning("Supabase nicht erreichbar (%s)", reason)
    elif last_ok is not None:
        logger.info("Supabase wieder erreichbar (%d ms)", sample["ms"])
    last_ok = sample["ok"]


async def run() -> None:
    """Misst im Takt von INTERVAL_SECONDS, bis der Task abgebrochen wird.

    Ein unerwarteter Fehler beendet die Schleife nicht, er landet nur im Log.
    """
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        while True:
            started = time.monotonic()
            try:
                record(await measure(client))
            except Exception as error:
                logger.error("Antwortzeit nicht gemessen (%s)", type(error).__name__, exc_info=error)
            await asyncio.sleep(max(0.0, INTERVAL_SECONDS - (time.monotonic() - started)))


def start() -> None:
    global task
    if task is not None and not task.done():
        return
    task = asyncio.create_task(run(), name="latency-monitor")


async def stop() -> None:
    global task
    if task is None:
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    task = None


# Verlängert die Session nicht, die Website fragt das regelmäßig ab.
@router.get("/api/latency", dependencies=[Depends(existing_session)])
async def get_latency() -> dict:
    return {"interval_seconds": INTERVAL_SECONDS, "samples": list(samples)}
