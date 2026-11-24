"""The update-nodepool workflow's run JSON, read into ``wingman_day1.domain.scale`` (ADR-0062).

``GET /workflows/runs/{id}`` answers ``{workflow_id, workflow_type, status,
progress?, result?, error?}``: ``progress`` is the run's ``progress`` query
(``phase``, ``direction``, ``child_workflow_id``) while it runs and after a
failure, ``result`` the ``UpdateNodePoolResult`` once completed, with its
child's ``NodePoolScaleResult`` in ``scale`` (``infra_env_kind`` only on a
run recorded by kind before 2026-11-18). The id and status must be
there; everything else is read leniently, since the workflow's branch can
still change: an unknown field is ignored, a field of the wrong type is left
out, and strings are kept as the workflow wrote them. Malformed required
fields raise ``TypeError``/``KeyError``/``ValueError``, which the adapter
turns into ``WorkflowsUnavailableError``.
"""

from __future__ import annotations

from collections.abc import Mapping

from wingman_day1.domain.scale import (
    ChosenServer,
    LiveReplicas,
    NodePoolChange,
    ScaleChild,
    ScaleResult,
    ScaleRun,
)
from wingman_day1.domain.servers import run_status
from wingman_day1.infrastructure.http import JSON, required_text
from wingman_day1.infrastructure.workflows.parse import integer, mapping, text


def _objects(value: JSON) -> list[dict[str, JSON]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _texts(value: JSON) -> tuple[str, ...]:
    return tuple(v for v in value if isinstance(v, str) and v) if isinstance(value, list) else ()


def scale_run(raw: JSON) -> ScaleRun:
    """One run of update-nodepool; its child is read separately (``with_child``)."""
    if not isinstance(raw, dict):
        raise TypeError("the run is not an object")
    progress = mapping(raw.get("progress"))
    result = raw.get("result")
    return ScaleRun(
        workflow_id=required_text(raw, "workflow_id"),
        status=run_status(required_text(raw, "status")),
        phase=text(progress, "phase"),
        direction=text(progress, "direction") or text(mapping(result), "direction"),
        child=ScaleChild(child) if (child := text(progress, "child_workflow_id")) else None,
        result=scale_result(result) if isinstance(result, dict) else None,
        error=text(raw, "error"),
    )


def child_run(workflow_id: str, raw: JSON) -> ScaleChild:
    """The scale-up-nodepool or scale-down-nodepool run, as far as it reads."""
    found = mapping(raw)
    status = text(found, "status")
    return ScaleChild(
        workflow_id=workflow_id,
        status=run_status(status) if status else None,
        phase=text(mapping(found.get("progress")), "phase"),
        error=text(found, "error"),
    )


def scale_result(raw: Mapping[str, JSON]) -> ScaleResult:
    """``UpdateNodePoolResult``, with its child's result in ``scale`` flattened in."""
    scale = mapping(raw.get("scale"))
    return ScaleResult(
        direction=text(raw, "direction") or "none",
        infra_env_kind=text(raw, "infra_env_kind"),
        nodepool=text(raw, "nodepool"),
        day1_path=text(raw, "day1_path"),
        total_before=integer(raw, "total_before"),
        total_after=integer(raw, "total_after"),
        nodepools=tuple(
            NodePoolChange(
                name=str(item["name"]),
                infra_env=text(item, "infra_env"),
                before=integer(item, "before"),
                after=integer(item, "after"),
                scale_down_policy=text(item, "scale_down_policy"),
            )
            for item in _objects(raw.get("nodepools"))
            if text(item, "name")
        ),
        child_workflow_id=text(raw, "child_workflow_id"),
        revision=text(scale, "revision"),
        committed=scale["committed"] if isinstance(scale.get("committed"), bool) else None,
        live=tuple(
            LiveReplicas(
                name=str(item["name"]),
                replicas=integer(item, "replicas"),
                ready_replicas=integer(item, "ready_replicas"),
            )
            for item in _objects(scale.get("nodepools"))
            if text(item, "name")
        ),
        chosen=tuple(
            ChosenServer(
                nodepool=str(item["nodepool"]),
                machine=str(item["machine"]),
                node=text(item, "node"),
                policy=text(item, "policy") or "",
                reason=text(item, "reason") or "",
                server=text(item, "server"),
            )
            for item in _objects(scale.get("chosen"))
            if text(item, "nodepool") and text(item, "machine")
        ),
        deleting=_texts(scale.get("deleting")),
        ignored=_texts(raw.get("ignored")),
    )
