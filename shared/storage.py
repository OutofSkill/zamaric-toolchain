from urllib.parse import quote

import httpx
from supabase import AsyncClient

from config import settings
from errors import ApiError
from sessions import renewed_auth_session

AUDIO_BUCKET = "audio"
SHEET_MUSIC_BUCKET = "sheet_music"

STORAGE_TIMEOUT_SECONDS = 300
DELETE_BATCH_SIZE = 100
USER_AGENT = "zamaric-toolchain/1.0"


async def access_token(client: AsyncClient) -> str:
    current = await renewed_auth_session(client)
    if current is None:
        raise ApiError(401, "unauthorized", "Kein Token für den Storage-Worker")
    return current.access_token


async def worker_request(
    client: AsyncClient, method: str, path: str, description: str, headers: dict[str, str] | None = None, **options
) -> httpx.Response:
    request_headers = {"Authorization": f"Bearer {await access_token(client)}", "User-Agent": USER_AGENT, **(headers or {})}
    try:
        async with httpx.AsyncClient(base_url=settings.storage_url.rstrip("/"), timeout=STORAGE_TIMEOUT_SECONDS) as http:
            response = await http.request(method, path, headers=request_headers, **options)
    except httpx.HTTPError as error:
        raise ApiError(502, "storage_failed", f"{description}: {type(error).__name__}") from None
    if response.status_code == 401:
        raise ApiError(401, "unauthorized", f"{description}: Storage-Worker lehnt Token ab")
    if response.status_code == 403:
        raise ApiError(403, "forbidden", f"{description}: kein Admin")
    if not response.is_success:
        raise ApiError(502, "storage_failed", f"{description}: Status {response.status_code}")
    return response


def response_field(response: httpx.Response, field: str, description: str):
    try:
        return response.json()[field]
    except (ValueError, KeyError, TypeError):
        raise ApiError(502, "storage_failed", f"{description}: Antwort ohne {field}") from None


def file_path(bucket: str, name: str) -> str:
    return f"/{bucket}/{quote(name, safe='')}"


async def upload_file(client: AsyncClient, bucket: str, name: str, content: bytes, sha256: str) -> None:
    await worker_request(
        client, "PUT", file_path(bucket, name), f"{bucket}/{name}", headers={"X-Content-SHA256": sha256}, content=content
    )


async def download_file(client: AsyncClient, bucket: str, name: str) -> bytes:
    return (await worker_request(client, "GET", file_path(bucket, name), f"{bucket}/{name}")).content


async def list_files(client: AsyncClient, bucket: str) -> list[dict]:
    response = await worker_request(client, "GET", f"/list/{bucket}", f"Liste {bucket}")
    return response_field(response, "files", f"Liste {bucket}")


async def delete_files(client: AsyncClient, bucket: str, names: list[str]) -> list[str]:
    deleted: list[str] = []
    for start in range(0, len(names), DELETE_BATCH_SIZE):
        batch = names[start : start + DELETE_BATCH_SIZE]
        response = await worker_request(client, "POST", "/delete", f"Löschen in {bucket}", json={"bucket": bucket, "names": batch})
        deleted += response_field(response, "deleted", f"Löschen in {bucket}")
    return deleted
