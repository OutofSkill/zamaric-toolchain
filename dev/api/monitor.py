"""GET /api/latency: Antwortzeit von Supabase und vom Speicher, gemessen vom Pi aus.

Ein Hintergrund-Task fragt jede Minute /auth/v1/health ab, ohne Anmeldung und
nur mit dem Publishable Key, so wie die App prüft, ob der Server erreichbar
ist. Gleichzeitig fragt er /health/storage des Storage-Workers ab, der dafür
R2 anfragt. Die Messwerte der letzten 24 Stunden liegen nur im Speicher: Ein Neustart
von Container 2 leert den Verlauf.

main.py startet den Task im lifespan mit start() und beendet ihn mit stop().
"""

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends

from config import settings
from sessions import existing_session
from storage import USER_AGENT

logger = logging.getLogger("zamaric")

router = APIRouter()

INTERVAL_SECONDS = 60
TIMEOUT_SECONDS = 10
# 24 Stunden bei einer Messung pro Minute
MAX_SAMPLES = 24 * 60


@dataclass
class Target:
    label: str
    url: str
    headers: dict[str, str]
    is_ok: Callable[[int], bool]
    samples: deque[dict] = field(default_factory=lambda: deque(maxlen=MAX_SAMPLES))
    # Für das Log: nur Wechsel zwischen erreichbar und nicht erreichbar melden,
    # nicht jede einzelne Messung
    last_ok: bool | None = None


supabase_target = Target(
    label="Supabase",
    url=f"{settings.supabase_url}/auth/v1/health",
    headers={"apikey": settings.supabase_publishable_key},
    is_ok=lambda status: status < 500,
)
storage_target = Target(
    label="Speicher",
    url=f"{settings.storage_url.rstrip('/')}/health/storage",
    headers={"User-Agent": USER_AGENT},
    is_ok=lambda status: status == 200,
)
targets = (supabase_target, storage_target)
samples = supabase_target.samples
storage_samples = storage_target.samples
task: asyncio.Task | None = None


async def measure(client: httpx.AsyncClient, target: Target) -> dict:
    """Eine Messung. Erreichbar heißt: is_ok des Ziels nimmt den Status an."""
    measured_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    try:
        response = await client.get(target.url, headers=target.headers)
    except httpx.HTTPError as error:
        return {"at": measured_at, "ms": None, "ok": False, "reason": type(error).__name__}
    milliseconds = round((time.perf_counter() - started) * 1000)
    ok = target.is_ok(response.status_code)
    return {"at": measured_at, "ms": milliseconds, "ok": ok, "reason": None if ok else f"Status {response.status_code}"}


def record(target: Target, sample: dict) -> None:
    reason = sample.pop("reason")
    target.samples.append(sample)
    if sample["ok"] == target.last_ok:
        return
    if not sample["ok"]:
        logger.warning("%s nicht erreichbar (%s)", target.label, reason)
    elif target.last_ok is not None:
        logger.info("%s wieder erreichbar (%d ms)", target.label, sample["ms"])
    target.last_ok = sample["ok"]


async def measure_and_record(client: httpx.AsyncClient, target: Target) -> None:
    try:
        record(target, await measure(client, target))
    except Exception as error:
        logger.error("Antwortzeit nicht gemessen: %s (%s)", target.label, type(error).__name__, exc_info=error)


async def run() -> None:
    """Misst im Takt von INTERVAL_SECONDS, bis der Task abgebrochen wird.

    Ein unerwarteter Fehler beendet die Schleife nicht, er landet nur im Log.
    """
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        while True:
            started = time.monotonic()
            await asyncio.gather(*(measure_and_record(client, target) for target in targets))
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
    return {"interval_seconds": INTERVAL_SECONDS, "samples": list(samples), "storage_samples": list(storage_samples)}
