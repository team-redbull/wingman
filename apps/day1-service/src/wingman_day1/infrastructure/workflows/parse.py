"""The orchestrator's JSON that more than one workflow reads, and the lenient field readers.

A run's id and status must be there; its other fields are read leniently:
one of the wrong type is left out rather than failing the read, since the
workflows add and move fields. Strings are kept as the workflow wrote them.
A malformed required field raises ``TypeError``/``KeyError``/``ValueError``,
which the adapter turns into ``WorkflowsUnavailableError``.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime

from wingman_day1.domain.add_server import ListedRun
from wingman_day1.domain.servers import run_status
from wingman_day1.infrastructure.http import JSON


def text(raw: Mapping[str, JSON], key: str) -> str | None:
    """``raw[key]`` when it is a non-empty string, else ``None``."""
    value = raw.get(key)
    return value if isinstance(value, str) and value else None


def integer(raw: Mapping[str, JSON], key: str) -> int | None:
    """``raw[key]`` when it is an integer (not a bool), else ``None``."""
    value = raw.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def mapping(value: JSON) -> dict[str, JSON]:
    """``value`` when it is an object, else ``{}``."""
    return value if isinstance(value, dict) else {}


def timestamp(raw: Mapping[str, JSON], key: str) -> datetime | None:
    """``raw[key]`` read as an ISO time, else ``None``."""
    value = text(raw, key)
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def listed_runs(raw: JSON) -> list[ListedRun]:
    """``GET /workflows/runs``: workflow id, status, start and close, newest first."""
    if not isinstance(raw, list):
        raise TypeError("the run list is not a list")
    runs: list[ListedRun] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TypeError("a run is not an object")
        workflow_id, status = text(item, "workflow_id"), text(item, "status")
        if workflow_id is None or status is None:
            raise ValueError("a run has no workflow_id or status")
        runs.append(
            ListedRun(
                workflow_id,
                run_status(status),
                started_at=timestamp(item, "start_time"),
                closed_at=timestamp(item, "close_time"),
            )
        )
    return runs
