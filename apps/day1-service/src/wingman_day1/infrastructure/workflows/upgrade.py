"""HttpUpgradeWorkflow: the orchestrator's upgrade-cluster workflow, over httpx (ADR-0055).

The workflow plans, checks and commits; day1 starts a run, reads it, and
passes on a person's decisions
(``docs/notes/2026-11-13-upgrade-cluster-workflow-api.md``):

- ``POST /workflows/cluster-upgrade/upgrade-cluster`` with the start's JSON
  answers ``202 {"workflow_id", "run_id"}``, 409 while the cluster has a
  run, 422 for a body it refuses. Everything it judges later is a FAILED run
  or a ``needs-human`` wait, never a 4xx here.
- ``POST .../upgrade-cluster/{id}/<decision>`` (and ``.../actions/{action}/approve|reject``)
  is a Temporal Update: 200 taken, 409 refused by the run's validator (its
  words), 404 no running run, 504 no answer in 15 s (it may have landed),
  500 failed otherwise.
- ``GET .../upgrade-targets?cluster=`` waits for a short read-only run, up
  to 60 s: its own timeout here. 404 no such file, 409 unusable, 504 no limb.
- ``GET /workflows/runs/{id}`` is the run (404: none);
  ``GET /workflows/runs?workflow_type=UpgradeClusterWorkflow&limit=200`` the
  fleet's newest runs, status and times only.

Writes are never retried (ADR-0006). Refused before it was sent, a write is
``WorkflowsUnavailableError``; sent and unanswered, it may have happened:
``AmbiguousStartError`` or ``AmbiguousDecisionError``. The run's JSON is read
in ``upgrade_parse.py``.
"""

from __future__ import annotations

import time
from typing import Final
from urllib.parse import quote

import httpx

from wingman_core.observability.metrics import Dependency, WingmanMetrics
from wingman_day1.domain.add_server import ListedRun
from wingman_day1.domain.errors import (
    AmbiguousDecisionError,
    ResourceNotFoundError,
    UpgradeAlreadyRunningError,
    UpgradeDecisionRefusedError,
    UpgradeRefusedError,
    UpgradeTargetsRefusedError,
    WorkflowsUnavailableError,
)
from wingman_day1.domain.upgrades import UpgradeDecision, UpgradeRequest, UpgradeRun, UpgradeTargets
from wingman_day1.infrastructure.http import JSON, NOT_SENT, json_client
from wingman_day1.infrastructure.observed import Observer, Timer, WorkflowsOperation
from wingman_day1.infrastructure.workflows.orchestrator import (
    Start,
    detail,
    get_run,
    list_runs,
    parsed,
    post_start,
    problems,
    start_refused,
    started_id,
    words,
)
from wingman_day1.infrastructure.workflows.parse import listed_runs
from wingman_day1.infrastructure.workflows.upgrade_parse import upgrade_run, upgrade_targets

UPGRADE_PATH: Final = "/workflows/cluster-upgrade/upgrade-cluster"
TARGETS_PATH: Final = "/workflows/cluster-upgrade/upgrade-targets"
WORKFLOW_TYPE: Final = "UpgradeClusterWorkflow"
"""The Temporal class name the run list filters on."""
LOOK_FIRST: Final = "Look at the cluster's upgrade run before trying again."


class HttpUpgradeWorkflow:
    """An ``UpgradeWorkflow`` over the orchestrator's REST API."""

    def __init__(
        self,
        *,
        base_url: str,
        verify: bool | str = True,
        timeout_seconds: float = 10.0,
        targets_timeout_seconds: float = 65.0,
        metrics: WingmanMetrics | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timer: Timer = time.perf_counter,
    ) -> None:
        """Call the orchestrator at ``base_url``; a targets read waits its own, longer timeout."""
        self._observer = Observer(Dependency.WORKFLOWS, metrics, timer=timer)
        self._targets_timeout = httpx.Timeout(targets_timeout_seconds)
        self._client = json_client(
            base_url=base_url, verify=verify, timeout_seconds=timeout_seconds, transport=transport
        )

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def targets(self, cluster: str) -> UpgradeTargets:
        """See UpgradeWorkflow.targets."""
        return await self._observer.call(WorkflowsOperation.UPGRADE_TARGETS, self._targets(cluster))

    async def start(self, request: UpgradeRequest) -> UpgradeRun:
        """See UpgradeWorkflow.start."""
        return await self._observer.call(WorkflowsOperation.START_UPGRADE, self._start(request))

    async def run(self, workflow_id: str) -> UpgradeRun | None:
        """See UpgradeWorkflow.run."""
        return await self._observer.call(WorkflowsOperation.GET_RUN, self._run(workflow_id))

    async def runs(self) -> list[ListedRun]:
        """See UpgradeWorkflow.runs."""
        return await self._observer.call(WorkflowsOperation.LIST_RUNS, self._runs())

    async def decide(
        self,
        workflow_id: str,
        decision: UpgradeDecision,
        *,
        by: str,
        reason: str | None = None,
        nodepool: str | None = None,
    ) -> None:
        """See UpgradeWorkflow.decide. Only the fields ``decision`` takes are sent."""
        body: dict[str, str] = {"by": by}
        if reason and decision.takes_reason:
            body["reason"] = reason
        if nodepool and decision is UpgradeDecision.CONTINUE:
            body["nodepool"] = nodepool
        path = f"{UPGRADE_PATH}/{quote(workflow_id, safe='')}/{decision.value}"
        await self._observer.call(
            WorkflowsOperation.DECIDE_UPGRADE, self._decide(path, body, what=decision.value)
        )

    async def decide_action(
        self, workflow_id: str, action_id: str, *, approve: bool, by: str
    ) -> None:
        """See UpgradeWorkflow.decide_action."""
        verb = "approve" if approve else "reject"
        path = (
            f"{UPGRADE_PATH}/{quote(workflow_id, safe='')}/actions/"
            f"{quote(action_id, safe='')}/{verb}"
        )
        await self._observer.call(
            WorkflowsOperation.DECIDE_UPGRADE,
            self._decide(path, {"by": by}, what=f"{verb} of action {action_id}"),
        )

    # ── Internals ───────────────────────────────────────────────────────────

    async def _targets(self, cluster: str) -> UpgradeTargets:
        what = f"reading the upgrade targets of {cluster}"
        try:
            response = await self._client.get(
                TARGETS_PATH, params={"cluster": cluster}, timeout=self._targets_timeout
            )
        except httpx.TransportError as exc:
            raise WorkflowsUnavailableError(
                f"the orchestrator did not answer {what}: {type(exc).__name__}"
            ) from exc
        status, why = response.status_code, detail(response)
        if status == 404:
            raise ResourceNotFoundError(f"the upgrade workflow's day1 has no {cluster}{why}")
        if status == 409:
            raise UpgradeTargetsRefusedError(f"the upgrade workflow cannot use {cluster}{why}")
        if status != 200:
            raise WorkflowsUnavailableError(f"the orchestrator answered {status} {what}{why}")
        malformed = f"the orchestrator returned malformed the upgrade targets of {cluster}"
        return parsed(response, upgrade_targets, malformed=malformed)

    async def _start(self, request: UpgradeRequest) -> UpgradeRun:
        cluster = request.cluster
        start = Start("upgrade", cluster, LOOK_FIRST)
        response = await post_start(self._client, UPGRADE_PATH, start, json=_start_body(request))
        status = response.status_code
        if status == 202:
            return UpgradeRun(workflow_id=started_id(response, start), status="running")
        if status == 409:
            raise UpgradeAlreadyRunningError(
                f"{cluster} already has an upgrade run{detail(response)}"
            )
        if status == 422:
            raise UpgradeRefusedError(
                f"the orchestrator refused the upgrade of {cluster}", problems(response)
            )
        raise start_refused(response, start)

    async def _run(self, workflow_id: str) -> UpgradeRun | None:
        response = await get_run(self._client, workflow_id)
        if response is None:
            return None
        malformed = f"the orchestrator returned malformed run {workflow_id}"
        return parsed(response, upgrade_run, malformed=malformed)

    async def _runs(self) -> list[ListedRun]:
        response = await list_runs(self._client, WORKFLOW_TYPE, what="listing upgrade runs")
        return parsed(
            response, listed_runs, malformed="the orchestrator returned malformed run list"
        )

    async def _decide(self, path: str, body: dict[str, str], *, what: str) -> None:
        try:
            response = await self._client.post(path, json=body)
        except NOT_SENT as exc:
            raise WorkflowsUnavailableError(
                f"the orchestrator could not be reached to send {what} "
                f"({type(exc).__name__}); nothing was sent"
            ) from exc
        except httpx.TransportError as exc:
            raise AmbiguousDecisionError(
                f"{what} was sent but no answer came back ({type(exc).__name__}): it may have "
                f"been taken. {LOOK_FIRST}"
            ) from exc
        status, why = response.status_code, detail(response)
        if status == 200:
            return
        if status == 409:
            # The run's validator refused it; its words name what the run waits for
            raise UpgradeDecisionRefusedError(words(response) or f"{what} was refused")
        if status == 404:
            raise ResourceNotFoundError(f"no running upgrade run takes {what}{why}")
        if status == 504:
            raise AmbiguousDecisionError(
                f"the run did not answer {what} in time: it may have been taken. {LOOK_FIRST}"
            )
        raise WorkflowsUnavailableError(f"the orchestrator answered {status} to {what}{why}")


def _start_body(request: UpgradeRequest) -> dict[str, JSON]:
    """The start's JSON: the cluster, who asked, and only what the person chose."""
    body: dict[str, JSON] = {"cluster": request.cluster, "requested_by": request.requested_by}
    optional: dict[str, JSON] = {
        "target_version": request.target_version,
        "target_minor": request.target_minor,
        "nodepool_order": list(request.nodepool_order) if request.nodepool_order else None,
        "max_unavailable": dict(request.max_unavailable) if request.max_unavailable else None,
        "workers_to_target": request.workers_to_target,
        "nodepool_mode": request.nodepool_mode,
        "auto_approve": request.auto_approve,
    }
    body.update({key: value for key, value in optional.items() if value is not None})
    return body
