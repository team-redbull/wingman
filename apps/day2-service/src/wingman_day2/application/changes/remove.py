"""Remove: every file of a chart's folder; ArgoCD then orphans the workload (runbook R8)."""

from __future__ import annotations

from wingman_core.domain.git import FileChange
from wingman_day2.application.apps import load_deploy
from wingman_day2.application.changes.plan import ChangePlan
from wingman_day2.application.topology import ClusterSummary, TeamState
from wingman_day2.domain import layout
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.platform import AppSource, PlannedApp
from wingman_day2.ports import SigsRepository


def refuse_fleet_default(app: PlannedApp, summary: ClusterSummary) -> None:
    """Refuse removing a fleet default from one destination: it is on all of its scope."""
    if app.source is not AppSource.FLEET_DEFAULT:
        return
    team, chart = app.team, app.chart
    raise ChangeRefusedError(
        f"{chart} reaches {summary.ref.name} as a fleet default of {team} ({app.folder}/): "
        f"it is on every destination of {app.ref.defaults_scope}, and is not removed from one. "
        "Its values for this cluster are set here, or on the add-on's page on Addons "
        f"({team}/{chart}). An add-on wanted on some MCEs only is not a default: it is "
        "deployed on those MCEs (ADR-0053).",
        details={
            "rule": "fleet-default-remove",
            "path": str(app.folder),
            "addon": f"/addons/{team}/{chart}",
            # 3.12.0's key; that page now redirects to the add-on's.
            "operator": f"/teams/{team}/operators/{chart}",
        },
    )


async def plan_remove(
    sigs: SigsRepository,
    state: TeamState,
    summary: ClusterSummary,
    app: PlannedApp,
    last_commit_id: str | None,
) -> ChangePlan:
    """Delete the app's folder, its values file guarded by ``last_commit_id`` (ADR-0006)."""
    deploy = await load_deploy(sigs, state.team, state.repo.tree, app)
    leaf, ref, chart = deploy.leaf, summary.ref, app.chart
    plan = ChangePlan(state, summary, charts=[chart], leaves=[leaf])
    values_path = app.folder.child(layout.VALUES_FILE)
    for path in state.repo.tree.files_under(app.folder):
        file = await sigs.read(state.team, path)
        guard = last_commit_id if (last_commit_id and path == values_path) else None
        plan.changes.append(
            FileChange.delete(path, last_commit_id=guard or (file.last_commit_id if file else None))
        )
    registration = layout.registration_dir(ref)
    if registration is not None and not plan.tree.is_dir(registration):
        keep = registration.child(layout.GITKEEP)
        plan.changes.append(FileChange.create(keep, ""))
        plan.notes.append(
            f"{chart} was the last chart folder of {ref.name} in {app.team}: {keep} keeps "
            f"the cluster registered, so {app.team}'s fleet defaults on it stay managed."
        )
    plan.notes.append(
        f"Deleting {app.folder}/ deletes the ArgoCD Application {leaf.name}, but ArgoCD "
        f"orphans the workload: {chart} keeps running on {ref.name}. A full teardown "
        f"needs `argocd app delete {leaf.name} --cascade` on {leaf.argo}'s "
        "ArgoCD after the merge (runbook R8). Wingman has no ArgoCD access yet."
    )
    return plan
