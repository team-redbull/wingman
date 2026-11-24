"""HttpUninstallWorkflow: the orchestrator's uninstall-server-from-hc workflow, over httpx.

The workflow owns the procedure (drain, lock, removal, and the checks before
them). Day1 starts a run and reads how it is going (ADR-0038):

- ``POST /workflows/server-lifecycle/uninstall-server-from-hc`` with
  ``{"server_names": "<one name>", "mce_cluster": ..., "namespace"?: ...}``
  answers ``202 {"workflow_id", "run_id"}``, 409 while that server is
  uninstalling, 422 for a body it refuses and 502 when Temporal refuses.
  Every refusal after the start is a FAILED run, never a 4xx here.
- ``GET /workflows/runs?workflow_type=UninstallServerFromHcWorkflow&limit=200``
  lists the newest runs of the fleet; ``GET /workflows/runs/{id}`` is one run,
  with ``progress.phase`` while it runs and after a failure (404: no run).

The orchestrator has no auth and no ``requested_by`` field: day1 logs who
started a run. A start is never retried (ADR-0006); ``orchestrator.py`` has
what each answer means.
"""

from __future__ import annotations

import time
from typing import Final

import httpx

from wingman_core.observability.metrics import Dependency, WingmanMetrics
from wingman_day1.domain.errors import UninstallAlreadyRunningError
from wingman_day1.domain.servers import RunSummary, run_status
from wingman_day1.domain.workflows import WorkflowRun
from wingman_day1.infrastructure.http import JSON, json_client
from wingman_day1.infrastructure.observed import Observer, Timer, WorkflowsOperation
from wingman_day1.infrastructure.workflows.orchestrator import (
    Start,
    get_run,
    list_runs,
    parsed,
    post_start,
    start_refused,
    started_id,
)
from wingman_day1.infrastructure.workflows.parse import mapping, text

START_PATH: Final = "/workflows/server-lifecycle/uninstall-server-from-hc"
WORKFLOW_TYPE: Final = "UninstallServerFromHcWorkflow"
"""The Temporal class name the run list filters on (it answers ``[]`` for any other name)."""
CHECK_FIRST: Final = "Look at the node's uninstall run before trying again."


class HttpUninstallWorkflow:
    """An ``UninstallWorkflow`` over the orchestrator's REST API."""

    def __init__(
        self,
        *,
        base_url: str,
        verify: bool | str = True,
        timeout_seconds: float = 10.0,
        metrics: WingmanMetrics | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timer: Timer = time.perf_counter,
    ) -> None:
        """Call the orchestrator at ``base_url``; ``verify`` is ``True``/``False`` or a CA path."""
        self._observer = Observer(Dependency.WORKFLOWS, metrics, timer=timer)
        self._client = json_client(
            base_url=base_url, verify=verify, timeout_seconds=timeout_seconds, transport=transport
        )

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def runs(self) -> list[RunSummary]:
        """See UninstallWorkflow.runs."""
        return await self._observer.call(WorkflowsOperation.LIST_RUNS, self._runs())

    async def run(self, workflow_id: str) -> WorkflowRun | None:
        """See UninstallWorkflow.run."""
        return await self._observer.call(WorkflowsOperation.GET_RUN, self._run(workflow_id))

    async def start(self, *, server_name: str, mce: str, namespace: str | None) -> WorkflowRun:
        """See UninstallWorkflow.start."""
        return await self._observer.call(
            WorkflowsOperation.START_UNINSTALL,
            self._start(server_name=server_name, mce=mce, namespace=namespace),
        )

    async def _runs(self) -> list[RunSummary]:
        response = await list_runs(self._client, WORKFLOW_TYPE, what="listing uninstall runs")
        return parsed(
            response, _summaries, malformed="the orchestrator returned a malformed run list"
        )

    async def _run(self, workflow_id: str) -> WorkflowRun | None:
        response = await get_run(self._client, workflow_id)
        if response is None:
            return None
        malformed = f"the orchestrator returned a malformed run {workflow_id}"
        return parsed(response, _run, malformed=malformed)

    async def _start(self, *, server_name: str, mce: str, namespace: str | None) -> WorkflowRun:
        start = Start("uninstall", server_name, CHECK_FIRST)
        body: dict[str, str] = {"server_names": server_name, "mce_cluster": mce}
        if namespace:
            body["namespace"] = namespace
        response = await post_start(self._client, START_PATH, start, json=body)
        if response.status_code == 202:
            return WorkflowRun(workflow_id=started_id(response, start), status="running")
        if response.status_code == 409:
            raise UninstallAlreadyRunningError(f"an uninstall of {server_name} is already running")
        raise start_refused(response, start)


def _identity(raw: dict[str, JSON]) -> tuple[str, str]:
    """A run's ``workflow_id`` (a non-empty string) and ``status`` (a string)."""
    workflow_id, status = raw["workflow_id"], raw["status"]
    if not (isinstance(workflow_id, str) and workflow_id and isinstance(status, str)):
        raise ValueError("the run has no workflow_id or status")
    return workflow_id, status


def _summaries(raw: JSON) -> list[RunSummary]:
    if not isinstance(raw, list):
        raise TypeError("the run list is not a list")
    summaries: list[RunSummary] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TypeError("a run is not an object")
        workflow_id, status = _identity(item)
        summaries.append(RunSummary(workflow_id=workflow_id, status=run_status(status)))
    return summaries


def _run(raw: JSON) -> WorkflowRun:
    if not isinstance(raw, dict):
        raise TypeError("the run is not an object")
    workflow_id, status = _identity(raw)
    return WorkflowRun(
        workflow_id=workflow_id,
        status=run_status(status),
        phase=text(mapping(raw.get("progress")), "phase"),
        error=text(raw, "error"),
    )
