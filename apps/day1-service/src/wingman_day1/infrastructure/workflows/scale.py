"""HttpScaleWorkflow: the orchestrator's update-nodepool workflow, over httpx (ADR-0062).

The workflow reads one NodePool of the cluster in day1 and on the MCE, sets
its replicas in day1 ``main``, syncs the cluster's Argo CD Application and
checks the NodePool; day1 starts a run and reads it
(``docs/notes/2026-11-16-scale-nodepools-api.md``):

- ``POST /workflows/server-lifecycle/update-nodepool`` with
  ``{mce_cluster, cluster, nodepool, replicas}`` and, on a scale-down, either
  the servers that leave (``server_names``) or a policy for the run
  (``scale_down_policy``), never both (the body forbids other fields;
  ``infra_env_kind`` is refused since 2026-11-18) answers ``202
  {"workflow_id": "update-nodepool-<cluster>", "run_id"}``, 409 while a run
  of the cluster runs and while an upgrade-cluster run of it runs (its words
  say which), 422 for a body it refuses. Everything it judges later is a
  FAILED run, never a 4xx here.
- ``GET /workflows/runs/{id}`` is the run (404: none). Its ``progress`` names
  ``child_workflow_id`` while the scale-up-nodepool or scale-down-nodepool
  child runs; the child has no route of its own, so its phase is read by
  its id the same way.

Writes are never retried (ADR-0006). Refused before it was sent, a start is
``WorkflowsUnavailableError``; sent and unanswered, it may have happened:
``AmbiguousStartError``.

The start route never answers 404 itself (an unknown cluster, NodePool or
MCE is a FAILED run). A 404 whose body is FastAPI's own for a path it has no
route for (``NO_ROUTE``) is an orchestrator that has no update-nodepool yet:
``WorkflowsUnavailableError`` saying it is not deployed there, nothing
started. Once it is deployed the same request answers 202. Any other 404 is
a refusal in the orchestrator's words. Reading a run needs only the runs
route, so a cluster's Scale reads "no run" until then.
"""

from __future__ import annotations

import dataclasses
import time
from functools import partial
from typing import Final

import httpx

from wingman_core.observability.metrics import Dependency, WingmanMetrics
from wingman_day1.domain.errors import (
    ScaleAlreadyRunningError,
    ScaleRefusedError,
    WorkflowsError,
    WorkflowsUnavailableError,
)
from wingman_day1.domain.scale import ScaleChild, ScaleRequest, ScaleRun
from wingman_day1.infrastructure.http import JSON, json_client
from wingman_day1.infrastructure.observed import Observer, Timer, WorkflowsOperation
from wingman_day1.infrastructure.workflows.orchestrator import (
    Start,
    get_run,
    parsed,
    post_start,
    problems,
    start_refused,
    started_id,
    words,
)
from wingman_day1.infrastructure.workflows.scale_parse import child_run, scale_run

SCALE_PATH: Final = "/workflows/server-lifecycle/update-nodepool"
LOOK_FIRST: Final = "Look at the cluster's scale run before trying again."
NO_ROUTE: Final = {"detail": "Not Found"}
"""FastAPI's whole 404 body for a path it has no route for, unlike any answer of a route."""
_CLOSED_WITH_RESULT: Final = "completed"


class HttpScaleWorkflow:
    """A ``ScaleWorkflow`` over the orchestrator's REST API."""

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

    async def start(self, request: ScaleRequest) -> ScaleRun:
        """See ScaleWorkflow.start."""
        return await self._observer.call(
            WorkflowsOperation.START_UPDATE_NODEPOOL, self._start(request)
        )

    async def run(self, workflow_id: str) -> ScaleRun | None:
        """See ScaleWorkflow.run: the parent, then its child while the parent has no result."""
        run = await self._observer.call(WorkflowsOperation.GET_RUN, self._get(workflow_id))
        if run is None or run.child is None or run.status == _CLOSED_WITH_RESULT:
            return run
        child_id = run.child.workflow_id
        try:
            child = await self._observer.call(WorkflowsOperation.GET_RUN, self._child(child_id))
        except WorkflowsError:
            child = None  # the parent's own state still shows; the child's phase is unknown
        return dataclasses.replace(run, child=child or ScaleChild(child_id))

    # ── Internals ───────────────────────────────────────────────────────────

    async def _start(self, request: ScaleRequest) -> ScaleRun:
        cluster = request.cluster
        start = Start("scale", cluster, LOOK_FIRST)
        response = await post_start(self._client, SCALE_PATH, start, json=_start_body(request))
        status = response.status_code
        if status == 202:
            return ScaleRun(workflow_id=started_id(response, start), status="running")
        if status == 404 and _no_route(response):
            raise WorkflowsUnavailableError(
                f"update-nodepool is not deployed on this orchestrator yet (it has no POST "
                f"{SCALE_PATH}): nothing was started for {cluster}. Scaling works as soon as "
                "the workflow is deployed there, with no change to Wingman."
            )
        if status == 409:
            raise ScaleAlreadyRunningError(
                words(response) or f"{cluster} already has a scale or an upgrade running"
            )
        if status == 422:
            raise ScaleRefusedError(
                f"the orchestrator refused the scale of {cluster}; nothing was started",
                problems(response),
            )
        raise start_refused(response, start)

    async def _get(self, workflow_id: str) -> ScaleRun | None:
        response = await get_run(self._client, workflow_id)
        if response is None:
            return None
        return parsed(response, scale_run, malformed=_malformed(workflow_id))

    async def _child(self, workflow_id: str) -> ScaleChild | None:
        # The child is read leniently: only an answer that is not JSON is malformed
        response = await get_run(self._client, workflow_id)
        if response is None:
            return None
        return parsed(response, partial(child_run, workflow_id), malformed=_malformed(workflow_id))


def _malformed(workflow_id: str) -> str:
    return f"the orchestrator returned malformed run {workflow_id}"


def _start_body(request: ScaleRequest) -> dict[str, JSON]:
    """The start's JSON: these four fields, one NodePool, and a scale-down's names or policy."""
    body: dict[str, JSON] = {
        "mce_cluster": request.mce_cluster,
        "cluster": request.cluster,
        "nodepool": request.nodepool,
        "replicas": request.replicas,
    }
    if request.server_names:
        body["server_names"] = list(request.server_names)
    if request.scale_down_policy is not None:
        body["scale_down_policy"] = request.scale_down_policy
    return body


def _no_route(response: httpx.Response) -> bool:
    """Whether a 404 is FastAPI's for a path it has no route for: the workflow is not there."""
    try:
        return response.json() == NO_ROUTE
    except ValueError:
        return False
