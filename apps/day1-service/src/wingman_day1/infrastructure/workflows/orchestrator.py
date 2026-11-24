"""What every workflow adapter shares: a start's answers, the runs route, the orchestrator's words.

Each workflow starts on a route of its own and answers ``202
{"workflow_id", "run_id"}``; every run, whatever its workflow, is read on
``GET /workflows/runs/{id}`` (404: no run) and listed on ``GET
/workflows/runs?workflow_type=<Temporal class>&limit=``. A refusal says why
in FastAPI's ``detail``: a text, or on a 422 a list of findings.

A start is a write and is never retried (ADR-0006). Refused before it was
sent (no connection), it is ``WorkflowsUnavailableError``: nothing was
started; sent and unanswered (a read timeout, a dropped connection, a
gateway's 504), it is ``AmbiguousStartError``: the run may exist. A read
that got no answer, or not a 200, is ``WorkflowsUnavailableError``.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final
from urllib.parse import quote

import httpx

from wingman_day1.domain.errors import (
    AmbiguousStartError,
    WorkflowRefusedError,
    WorkflowsError,
    WorkflowsUnavailableError,
)
from wingman_day1.infrastructure.http import JSON, NOT_SENT, required_text

RUNS_PATH: Final = "/workflows/runs"
RUNS_LIMIT: Final = 200
"""The most the run list returns; it has no cursor."""
MAX_DETAIL: Final = 300
MAX_PROBLEMS: Final = 10
MAX_WORDS: Final = 2000
"""A refusal shown in the orchestrator's own words is kept whole, up to this."""


@dataclass(frozen=True, slots=True)
class Start:
    """One start's words: "could not be reached to <verb> <name>", "the <verb> of <name>"."""

    verb: str
    name: str
    look_first: str
    """What to look at before trying again, when the run may exist."""

    @property
    def subject(self) -> str:
        """``the <verb> of <name>``."""
        return f"the {self.verb} of {self.name}"


async def post_start(
    client: httpx.AsyncClient,
    path: str,
    start: Start,
    *,
    json: JSON = None,
    params: Mapping[str, str] | None = None,
    content: bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> httpx.Response:
    """POST ``start`` once; no answer is unavailable when nothing left, else ambiguous."""
    try:
        return await client.post(path, json=json, params=params, content=content, headers=headers)
    except NOT_SENT as exc:
        raise WorkflowsUnavailableError(
            f"the orchestrator could not be reached to {start.verb} {start.name} "
            f"({type(exc).__name__}); nothing was started"
        ) from exc
    except httpx.TransportError as exc:
        raise AmbiguousStartError(
            f"{start.subject} was sent but no answer came back "
            f"({type(exc).__name__}): it may have started. {start.look_first}"
        ) from exc


def started_id(response: httpx.Response, start: Start) -> str:
    """A 202's ``workflow_id``; an answer that cannot be read is ambiguous: a run began."""
    try:
        return required_text(response.json(), "workflow_id")
    except (ValueError, KeyError, TypeError) as exc:
        raise AmbiguousStartError(
            f"the orchestrator accepted {start.subject} (202) but its answer could not be "
            f"read. {start.look_first}"
        ) from exc


def start_refused(response: httpx.Response, start: Start) -> WorkflowsError:
    """The error for a start's answer that its workflow does not read its own way."""
    status, why = response.status_code, detail(response)
    if status == 504:
        return AmbiguousStartError(
            f"a gateway timed out waiting for the orchestrator to start {start.subject}: it "
            f"may have started. {start.look_first}"
        )
    if 400 <= status < 500:
        return WorkflowRefusedError(f"the orchestrator refused {start.subject} ({status}){why}")
    return WorkflowsUnavailableError(f"the orchestrator answered {status} to {start.subject}{why}")


async def get(
    client: httpx.AsyncClient,
    path: str,
    *,
    what: str,
    params: Mapping[str, str | int] | None = None,
) -> httpx.Response:
    """GET ``path``; a request that got no answer is unavailable, naming ``what``."""
    try:
        return await client.get(path, params=params)
    except httpx.TransportError as exc:
        raise WorkflowsUnavailableError(
            f"the orchestrator is unreachable {what}: {type(exc).__name__}"
        ) from exc


async def get_run(client: httpx.AsyncClient, workflow_id: str) -> httpx.Response | None:
    """``GET /workflows/runs/{id}``: its 200, ``None`` for a 404, unavailable otherwise."""
    what = f"reading run {workflow_id}"
    response = await get(client, f"{RUNS_PATH}/{quote(workflow_id, safe='')}", what=what)
    if response.status_code == 404:
        return None
    _must_be_200(response, what)
    return response


async def list_runs(client: httpx.AsyncClient, workflow_type: str, *, what: str) -> httpx.Response:
    """``GET /workflows/runs`` of one workflow, newest first: its 200, unavailable otherwise."""
    params = {"workflow_type": workflow_type, "limit": RUNS_LIMIT}
    response = await get(client, RUNS_PATH, what=what, params=params)
    _must_be_200(response, what)
    return response


def _must_be_200(response: httpx.Response, what: str) -> None:
    if response.status_code != 200:
        raise WorkflowsUnavailableError(f"the orchestrator answered {response.status_code} {what}")


def parsed[T](response: httpx.Response, parse: Callable[[JSON], T], *, malformed: str) -> T:
    """``parse`` of the answer's JSON; one it cannot read is unavailable, as ``malformed``."""
    try:
        return parse(response.json())
    except (ValueError, KeyError, TypeError) as exc:
        raise WorkflowsUnavailableError(malformed) from exc


def detail(response: httpx.Response) -> str:
    """The orchestrator's own ``detail``, when it is text, as ``": <detail>"``."""
    try:
        found = response.json().get("detail")
    except (ValueError, AttributeError):
        return ""
    if not isinstance(found, str) or not found.strip():
        return ""
    return f": {found.strip()[:MAX_DETAIL]}"


def words(response: httpx.Response) -> str:
    """The orchestrator's ``detail``, whole: why it refused, in its own words."""
    try:
        found = response.json().get("detail")
    except (ValueError, AttributeError):
        return ""
    return found.strip()[:MAX_WORDS] if isinstance(found, str) else ""


def problems(response: httpx.Response) -> list[str]:
    """The orchestrator's 422 detail, one line per finding (FastAPI's list, or its text)."""
    try:
        found = response.json().get("detail")
    except (ValueError, AttributeError):
        return []
    if isinstance(found, str) and found.strip():
        return [found.strip()]
    if not isinstance(found, list):
        return []
    lines: list[str] = []
    for item in found[:MAX_PROBLEMS]:
        if not isinstance(item, dict):
            continue
        where = ".".join(str(part) for part in item.get("loc", []) if part not in ("query", "body"))
        message = item.get("msg")
        if isinstance(message, str) and message:
            lines.append(f"{where}: {message}" if where else message)
    return lines
