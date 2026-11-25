import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, Path as PathParameter, Response
from pydantic import BaseModel, ConfigDict, Field

from board import SessionRequired, now_iso, run
from errors import ApiError
from web import require_own_origin

router = APIRouter()

KEY_PATTERN = r"^[0-9a-f]{64}$"
CHECK_NAME_PATTERN = r"^[a-z0-9_]{1,64}$"

FindingKeyPath = Annotated[str, PathParameter(pattern=KEY_PATTERN)]


class HiddenFindingRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    key: str = Field(pattern=KEY_PATTERN)
    check_name: str = Field(pattern=CHECK_NAME_PATTERN)


@router.get("/api/hidden-findings")
async def get_hidden_findings(session: SessionRequired) -> dict:
    def work(connection: sqlite3.Connection) -> dict:
        rows = connection.execute("select key, check_name, hidden_at from hidden_finding order by hidden_at, key").fetchall()
        return {"hidden": [{"key": row["key"], "check_name": row["check_name"], "hidden_at": row["hidden_at"]} for row in rows]}

    return await run(work)


@router.post("/api/hidden-findings", status_code=204, dependencies=[Depends(require_own_origin)])
async def post_hidden_finding(body: HiddenFindingRequest, session: SessionRequired) -> Response:
    def work(connection: sqlite3.Connection) -> None:
        connection.execute(
            "insert into hidden_finding (key, check_name, hidden_at) values (?, ?, ?) on conflict (key) do nothing",
            (body.key, body.check_name, now_iso()),
        )

    await run(work)
    return Response(status_code=204)


@router.delete("/api/hidden-findings/{key}", status_code=204, dependencies=[Depends(require_own_origin)])
async def delete_hidden_finding(key: FindingKeyPath, session: SessionRequired) -> Response:
    def work(connection: sqlite3.Connection) -> None:
        if connection.execute("delete from hidden_finding where key = ?", (key,)).rowcount == 0:
            raise ApiError(404, "not_found", f"Fund {key} ist nicht ausgeblendet")

    await run(work)
    return Response(status_code=204)
