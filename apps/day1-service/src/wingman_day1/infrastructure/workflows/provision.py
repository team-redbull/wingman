"""HttpProvisionWorkflow: the orchestrator's provision-cluster workflow, over httpx (ADR-0042).

The workflow creates a cluster: it judges the file, reserves the segment,
pushes the file on its own branch, opens the merge request, waits for a
person to merge it and registers the cluster in day2. Day1 starts a run and
reads how it is going:

- ``POST /workflows/cluster-lifecycle/provision-cluster?cluster=&mce=`` with
  the cluster file as an ``application/yaml`` body answers ``202
  {"workflow_id", "run_id"}``, 409 while a run for the cluster is going and
  422 for a name or body it cannot use. Everything it judges after the start
  is a FAILED run, never a 4xx here.
- ``GET /workflows/runs/{id}`` is one run: ``progress.phase``,
  ``progress.merge_request_url`` and ``progress.merge_request_state`` while
  it runs (and where a failure stopped it), ``error`` once failed (404: none).

A start is never retried (ADR-0006); ``orchestrator.py`` has what each
answer means.
"""

from __future__ import annotations

import time
from typing import Final

import httpx

from wingman_core.observability.metrics import Dependency, WingmanMetrics
from wingman_day1.domain.errors import ProvisionAlreadyRunningError, ProvisionRefusedError
from wingman_day1.domain.servers import run_status
from wingman_day1.domain.workflows import ProvisionRun
from wingman_day1.infrastructure.http import JSON, json_client
from wingman_day1.infrastructure.observed import Observer, Timer, WorkflowsOperation
from wingman_day1.infrastructure.workflows.orchestrator import (
    Start,
    detail,
    get_run,
    parsed,
    post_start,
    problems,
    start_refused,
    started_id,
)
from wingman_day1.infrastructure.workflows.parse import mapping, text

START_PATH: Final = "/workflows/cluster-lifecycle/provision-cluster"
CHECK_FIRST: Final = "Look at the cluster's provision run before starting it again."


class HttpProvisionWorkflow:
    """A ``ProvisionWorkflow`` over the orchestrator's REST API."""

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

    async def start(self, *, cluster: str, mce: str, content: str) -> ProvisionRun:
        """See ProvisionWorkflow.start."""
        return await self._observer.call(
            WorkflowsOperation.START_PROVISION,
            self._start(cluster=cluster, mce=mce, content=content),
        )

    async def run(self, workflow_id: str) -> ProvisionRun | None:
        """See ProvisionWorkflow.run."""
        return await self._observer.call(WorkflowsOperation.GET_RUN, self._run(workflow_id))

    async def _start(self, *, cluster: str, mce: str, content: str) -> ProvisionRun:
        start = Start("provision", cluster, CHECK_FIRST)
        response = await post_start(
            self._client,
            START_PATH,
            start,
            params={"cluster": cluster, "mce": mce},
            content=content.encode("utf-8"),
            headers={"Content-Type": "application/yaml"},
        )
        status = response.status_code
        if status == 202:
            return ProvisionRun(workflow_id=started_id(response, start), status="running")
        if status == 409:
            raise ProvisionAlreadyRunningError(
                f"a provision run for {cluster} is already going{detail(response)}"
            )
        if status == 422:
            raise ProvisionRefusedError(
                f"the orchestrator refused to provision {cluster}", problems(response)
            )
        raise start_refused(response, start)

    async def _run(self, workflow_id: str) -> ProvisionRun | None:
        response = await get_run(self._client, workflow_id)
        if response is None:
            return None
        malformed = f"the orchestrator returned a malformed run {workflow_id}"
        return parsed(response, provision_run, malformed=malformed)


def provision_run(raw: JSON) -> ProvisionRun:
    """``GET /workflows/runs/{id}`` for a provision run; malformed raises Type/Key/ValueError."""
    if not isinstance(raw, dict):
        raise TypeError("the run is not an object")
    workflow_id, status = raw["workflow_id"], raw["status"]
    if not (isinstance(workflow_id, str) and workflow_id and isinstance(status, str)):
        raise ValueError("the run has no workflow_id or status")
    progress, result = mapping(raw.get("progress")), mapping(raw.get("result"))
    return ProvisionRun(
        workflow_id=workflow_id,
        status=run_status(status),
        phase=text(progress, "phase"),
        error=text(raw, "error"),
        merge_request_url=text(progress, "merge_request_url") or text(result, "merge_request_url"),
        merge_request_state=text(progress, "merge_request_state"),
    )
