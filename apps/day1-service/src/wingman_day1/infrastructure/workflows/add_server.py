"""HttpAddServerWorkflow: the orchestrator's add-server-to-mce workflow, over httpx (ADR-0057).

The workflow makes servers Agents in an MCE's InfraEnv pool. Day1 starts runs
and reads them:

- ``POST /workflows/server-lifecycle/add-server-to-mce`` with
  ``{"infra_env", "mce_cluster", "namespace"?, "count" | "server_names",
  "allow_unhealthy"?}``; ``allow_unhealthy`` (the workflow's hidden health
  waiver) only with ``server_names`` and only when true, as the workflow
  leaves it out of its own payloads while false.
  Day1 always sends a count or a list, so the orchestrator answers ``202
  {"started", "already_running", "failed", "results": [{"workflow_id",
  "status", "server_name"?, "slot"?, "error"?}]}`` (a lone run's ``202
  {"workflow_id", "run_id"}`` is read too). 409 for a named server already
  installing or every slot busy, 422 for a body it refuses, 502 when
  Temporal refuses. Every other refusal is a FAILED run, never a 4xx here.
- ``GET /workflows/runs?workflow_type=AddServerToMceWorkflow&limit=200``
  lists the fleet's newest runs; ``GET /workflows/runs/{id}`` is one run,
  with ``progress.phase``, ``progress.server_name`` and the health checks it
  waived, ``progress.allowed_unhealthy`` (or the result's; 404: no run).

A start is a write and is never retried (ADR-0006): sent twice, a pool draw
installs twice. Refused before it was sent (no connection), it is
``WorkflowsUnavailableError``; sent and unanswered, ``AmbiguousStartError``:
some runs may exist. Its JSON is read in ``add_server_parse.py``.
"""

from __future__ import annotations

import time
from typing import Final

import httpx

from wingman_core.observability.metrics import Dependency, WingmanMetrics
from wingman_day1.domain.add_server import AddServerRequest, AddServerRun, AddServerStart, ListedRun
from wingman_day1.domain.errors import (
    AddServerAlreadyRunningError,
    AddServerRefusedError,
    AmbiguousStartError,
    WorkflowRefusedError,
    WorkflowsUnavailableError,
)
from wingman_day1.infrastructure.http import NOT_SENT, json_client
from wingman_day1.infrastructure.observed import Observer, Timer, WorkflowsOperation
from wingman_day1.infrastructure.workflows.add_server_parse import add_server_run, started
from wingman_day1.infrastructure.workflows.orchestrator import (
    detail,
    get_run,
    list_runs,
    parsed,
    problems,
)
from wingman_day1.infrastructure.workflows.parse import listed_runs

START_PATH: Final = "/workflows/server-lifecycle/add-server-to-mce"
WORKFLOW_TYPE: Final = "AddServerToMceWorkflow"
"""The Temporal class name the run list filters on."""
CHECK_FIRST: Final = "Look at the pool's add-server runs before asking again."


class HttpAddServerWorkflow:
    """An ``AddServerWorkflow`` over the orchestrator's REST API."""

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

    async def runs(self) -> list[ListedRun]:
        """See AddServerWorkflow.runs."""
        return await self._observer.call(WorkflowsOperation.LIST_RUNS, self._runs())

    async def run(self, workflow_id: str) -> AddServerRun | None:
        """See AddServerWorkflow.run."""
        return await self._observer.call(WorkflowsOperation.GET_RUN, self._run(workflow_id))

    async def start(self, request: AddServerRequest) -> AddServerStart:
        """See AddServerWorkflow.start."""
        return await self._observer.call(WorkflowsOperation.START_ADD_SERVER, self._start(request))

    async def _runs(self) -> list[ListedRun]:
        response = await list_runs(self._client, WORKFLOW_TYPE, what="listing add-server runs")
        malformed = "the orchestrator returned a malformed run list"
        return parsed(response, listed_runs, malformed=malformed)

    async def _run(self, workflow_id: str) -> AddServerRun | None:
        response = await get_run(self._client, workflow_id)
        if response is None:
            return None
        malformed = f"the orchestrator returned a malformed run {workflow_id}"
        return parsed(response, add_server_run, malformed=malformed)

    async def _start(self, request: AddServerRequest) -> AddServerStart:
        # A pool draw is several runs, so its answers say "some may have started"
        what = f"adding {request.size} server(s) to {request.infra_env} on {request.mce}"
        try:
            response = await self._client.post(START_PATH, json=start_body(request))
        except NOT_SENT as exc:
            raise WorkflowsUnavailableError(
                f"the orchestrator could not be reached for {what} ({type(exc).__name__}); "
                "nothing was started"
            ) from exc
        except httpx.TransportError as exc:
            raise AmbiguousStartError(
                f"{what} was sent but no answer came back ({type(exc).__name__}): some may "
                f"have started. {CHECK_FIRST}"
            ) from exc
        return _answer(response, what)


def _answer(response: httpx.Response, what: str) -> AddServerStart:
    status, why = response.status_code, detail(response)
    if status == 202:
        try:
            return started(response.json())
        except (ValueError, KeyError, TypeError) as exc:
            raise AmbiguousStartError(
                f"the orchestrator accepted {what} (202) but its answer could not be read. "
                f"{CHECK_FIRST}"
            ) from exc
    if status == 409:
        raise AddServerAlreadyRunningError(f"the orchestrator refused {what}{why}")
    if status == 422:
        raise AddServerRefusedError(f"the orchestrator refused {what}", problems(response))
    if status == 504:
        raise AmbiguousStartError(
            f"a gateway timed out waiting for the orchestrator on {what}: some may have "
            f"started. {CHECK_FIRST}"
        )
    if 400 <= status < 500:
        raise WorkflowRefusedError(f"the orchestrator refused {what} ({status}){why}")
    raise WorkflowsUnavailableError(f"the orchestrator answered {status} to {what}{why}")


def start_body(request: AddServerRequest) -> dict[str, object]:
    """The start's JSON: always a count or a list, so the answer is always per run."""
    body: dict[str, object] = {"infra_env": request.infra_env, "mce_cluster": request.mce}
    if request.namespace:
        body["namespace"] = request.namespace
    if request.count is not None:
        body["count"] = request.count
    else:
        body["server_names"] = list(request.server_names)
        if request.allow_unhealthy:
            body["allow_unhealthy"] = True
    return body
