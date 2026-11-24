"""What every change of a cluster's charts shares: its plan, its checks and its result."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

from wingman_core.domain.git import FileChange
from wingman_core.domain.merge_request import MergeRequest
from wingman_day2.application.preview import find_app
from wingman_day2.application.topology import ClusterSummary, TeamState, Topology
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ClusterKind
from wingman_day2.domain.deploy_config import LeafApplication
from wingman_day2.domain.errors import ChangeRefusedError, ChartNotInstalledError
from wingman_day2.domain.findings import Finding, Rule, Severity
from wingman_day2.domain.lints import lint_team
from wingman_day2.domain.platform import PlannedApp, TeamPlan, plan_team
from wingman_day2.domain.tree import RepoTree

CHART_NAME = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
"""A chart folder becomes part of Application names, so it must be a DNS label."""


@dataclass(frozen=True, slots=True)
class ChangeResult:
    """An opened MR and what it does."""

    team: str
    cluster: ClusterSummary
    merge_request: MergeRequest
    changes: tuple[FileChange, ...]
    app_names: tuple[str, ...]
    findings: tuple[Finding, ...]
    notes: tuple[str, ...]


@dataclass(slots=True)
class ChangePlan:
    """What one MR on one team's repo writes for one cluster, while it is planned."""

    state: TeamState
    summary: ClusterSummary
    charts: list[str] = field(default_factory=list)
    changes: list[FileChange] = field(default_factory=list)
    leaves: list[LeafApplication] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def tree(self) -> RepoTree:
        """The team repo's tree as it would be after the MR."""
        return self.state.repo.tree.with_changes(self.changes)


def check_chart_name(chart: str) -> str:
    """``chart`` if it can be a chart folder, else a refusal."""
    if not CHART_NAME.match(chart):
        raise ChangeRefusedError(
            f"{chart!r} is not a valid chart name (lowercase letters, digits and '-')",
            details={"rule": "chart-name", "chart": chart},
        )
    return chart


def require_writable(topology: Topology, summary: ClusterSummary) -> None:
    """Refuse a destination the platform would not render, or could render only as a phantom."""
    ref = summary.ref
    if ref.kind is ClusterKind.HUB:
        return
    if not ref.env:
        raise ChangeRefusedError(
            f"{ref.name}'s env is unknown; place it in a team repo first",
            details={"rule": str(Rule.ENV_UNKNOWN), "cluster": ref.id},
        )
    if not ref.env_allowed:
        raise ChangeRefusedError(
            f"{ref.id}: env {ref.env!r} is not one the platform accepts",
            details={"rule": str(Rule.ENV_NOT_ALLOWED), "cluster": ref.id},
        )
    if ref.kind is ClusterKind.UPI:
        return
    mce = topology.day1.mce(ref.site, ref.mce)
    hosted = topology.day1.hosted_cluster(ref.site, ref.mce, ref.name)
    if mce is None or mce.ocp_version is None:
        missing = layout.day1_mce_version_file(ref.site, ref.mce)
    elif ref.kind is ClusterKind.HOSTED and (hosted is None or hosted.ocp_version is None):
        missing = layout.day1_hosted_cluster_file(ref.site, ref.mce, ref.name)
    else:
        return
    raise ChangeRefusedError(
        f"day1 has no mastertag at {missing}: the platform renders nothing for {ref.name}, and a "
        "folder for it would be a phantom",
        details={"rule": str(Rule.DAY1_VERSION_MISSING), "cluster": ref.id, "path": str(missing)},
    )


def refuse_new_errors(
    topology: Topology, state: TeamState, changes: Sequence[FileChange]
) -> TeamPlan:
    """What the repo after ``changes`` generates, or the refusal of the errors it adds (ADR-0023).

    Errors the team repo already has do not block a change; only new ones do. The control
    files (``exclusions.yaml``, UPI ``version.yaml``) are read as the change leaves them.
    """
    before = {(f.rule, f.path, f.message) for f in state.findings if f.severity is Severity.ERROR}
    repo = state.repo.with_changes(changes)
    after_plan = plan_team(repo, topology.day1)
    added = [
        f
        for f in lint_team(repo, topology.day1, after_plan)
        if f.severity is Severity.ERROR and (f.rule, f.path, f.message) not in before
    ]
    if added:
        raise ChangeRefusedError(
            f"the change would break the platform's rules: {added[0].message}",
            details={"rule": str(added[0].rule), "findings": [f.message for f in added]},
        )
    return after_plan


def installed_app(state: TeamState, summary: ClusterSummary, chart: str) -> PlannedApp:
    """The app of ``chart`` that ``state``'s team deploys to the cluster, or a 404."""
    app = find_app(state, summary, chart)
    if app is None:
        raise ChartNotInstalledError(
            f"{state.team.name} does not deploy {chart} to {summary.ref.name}",
            details={"team": state.team.name, "chart": chart, "cluster": summary.ref.id},
        )
    return app


def validate(topology: Topology, plan: ChangePlan) -> None:
    """Refuse a change that adds a platform error; note the apps it adds besides its own."""
    state = plan.state
    after_plan = refuse_new_errors(topology, state, plan.changes)
    old = {(a.ref, a.chart, a.source) for a in state.plan.apps}
    for app in after_plan.apps:
        if (app.ref, app.chart, app.source) not in old and app.chart not in plan.charts:
            plan.notes.append(
                f"This also registers {app.ref.name} with {state.team.name}, so the fleet "
                f"default {app.chart} ({app.folder}/) deploys to it too."
            )


def sync_note(leaf: LeafApplication) -> str:
    """What happens on ``leaf``'s ArgoCD once the MR is merged."""
    if leaf.auto_sync:
        return (
            f"{leaf.name} on {leaf.argo}'s ArgoCD syncs automatically (its syncPolicy is "
            "automated) once the MR is merged."
        )
    return (
        f"After the merge, ArgoCD on {leaf.argo} generates {leaf.name}, which is manual-sync: "
        "nothing is deployed until someone syncs it. Wingman has no ArgoCD access yet."
    )
