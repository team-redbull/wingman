"""The add-server-to-mce workflow's JSON, read into ``wingman_day1.domain.add_server`` (ADR-0057).

A start answers per run (``started``); a run is read with its phase, its
server and the health checks it waived (``add_server_run``); the run list is
every workflow's (``parse.listed_runs``). Malformed required fields raise
``TypeError``/``KeyError``/``ValueError``, which the adapter turns into
``WorkflowsUnavailableError`` for a run and ``AmbiguousStartError`` for a start.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Final

from wingman_day1.domain.add_server import AddServerRun, AddServerStart, StartedRun
from wingman_day1.domain.servers import run_status
from wingman_day1.infrastructure.http import JSON
from wingman_day1.infrastructure.workflows.parse import integer, mapping, text

MAX_ERROR: Final = 500


def started(raw: JSON) -> AddServerStart:
    """A 202's body: the per-run answer, or a lone run's ``{workflow_id, run_id}``."""
    if not isinstance(raw, dict):
        raise TypeError("the answer is not an object")
    if "results" not in raw:
        workflow_id = text(raw, "workflow_id")
        if workflow_id is None:
            raise ValueError("the answer has neither results nor a workflow_id")
        return AddServerStart(1, 0, 0, (StartedRun(workflow_id, "started"),))
    results = raw["results"]
    if not isinstance(results, list):
        raise TypeError("results is not a list")
    runs = tuple(_started_run(item) for item in results)
    begun, running, failed = (integer(raw, key) for key in ("started", "already_running", "failed"))
    if begun is None or running is None or failed is None:
        raise ValueError("the answer has no counts")
    return AddServerStart(begun, running, failed, runs=runs)


def _started_run(item: JSON) -> StartedRun:
    if not isinstance(item, dict):
        raise TypeError("a result is not an object")
    workflow_id, status = text(item, "workflow_id"), text(item, "status")
    if workflow_id is None or status is None:
        raise ValueError("a result has no workflow_id or status")
    return StartedRun(
        workflow_id,
        status,
        server_name=text(item, "server_name"),
        slot=integer(item, "slot"),
        error=text(item, "error"),
    )


def add_server_run(raw: JSON) -> AddServerRun:
    """``GET /workflows/runs/{id}`` for an add-server run; malformed raises Type/Key/ValueError."""
    if not isinstance(raw, dict):
        raise TypeError("the run is not an object")
    workflow_id, status = text(raw, "workflow_id"), text(raw, "status")
    if workflow_id is None or status is None:
        raise ValueError("the run has no workflow_id or status")
    progress, result = mapping(raw.get("progress")), mapping(raw.get("result"))
    return AddServerRun(
        workflow_id=workflow_id,
        status=run_status(status),
        phase=text(progress, "phase"),
        server_name=text(progress, "server_name") or text(result, "server_name"),
        error=_error(raw),
        waived=_waived(progress, result),
    )


def _error(raw: Mapping[str, JSON]) -> str | None:
    """The run's error: its text, or its structure (candidates by reason) as compact JSON."""
    error = raw.get("error")
    if error is None or error == "":
        return None
    found = error if isinstance(error, str) else json.dumps(error, separators=(",", ":"))
    return found[:MAX_ERROR]


def _waived(*sources: Mapping[str, JSON]) -> tuple[str, ...]:
    """The run's ``allowed_unhealthy`` as ``check: observed``: its progress's, else its result's."""
    for source in sources:
        items = source.get("allowed_unhealthy")
        if isinstance(items, list) and items:
            found = (item for item in items if isinstance(item, dict))
            return tuple(
                f"{text(item, 'check') or 'health'}: {text(item, 'observed') or '?'}"[:MAX_ERROR]
                for item in found
            )
    return ()
