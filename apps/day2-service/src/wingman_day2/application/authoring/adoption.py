"""Adoption: a cluster's own chart folder moves into a new fleet default (ADR-0053).

Both folders generate the same Application names, so ArgoCD keeps the
cluster's Application: nothing is deleted, re-created or orphaned. What the
move changes in its effective deploy config or values is compared, and must
be confirmed.
"""

from __future__ import annotations

from wingman_core.domain.git import FileChange, RepoPath
from wingman_day2.application.authoring.plan import Adoption, AuthoringPlan, key_changes
from wingman_day2.application.authoring.writer import PlanWriter
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ALLOWED_ENVS, ClusterRef
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.platform import AppSource, Destination, PlannedApp
from wingman_day2.domain.yaml_values import parse_values


async def adopt(
    writer: PlanWriter, plan: AuthoringPlan, destination: Destination, fleet: RepoPath
) -> Adoption:
    """Move ``destination``'s own chart folder into the fleet default; compare before, after.

    A non-empty ``values.yaml`` becomes ``values-<name>.yaml`` in ``fleet``,
    byte for byte: refused when that name is an env (the env layer has that
    file name) or the file exists already (another destination of that name).
    """
    ref = destination.ref
    chart = plan.chart
    team = plan.state.team
    base = plan.state.repo.tree
    own = layout.chart_dir(ref, chart)
    values_path = own.child(layout.VALUES_FILE)
    deploy_path = own.child(layout.deploy_config_name(chart))
    files = base.files_under(own)
    others = [
        p for p in files if p not in (values_path, deploy_path) and not p.name.startswith(".")
    ]
    if others:
        raise ChangeRefusedError(
            f"{own}/ holds {others[0]} besides its values and deploy config; move or delete it "
            f"by hand first",
            details={
                "rule": "adoption-blocked",
                "cluster": ref.id,
                "files": [str(p) for p in others],
            },
        )
    app = PlannedApp(team.name, ref, chart, AppSource.CLUSTER, destination.ocp_version)
    deploy_before, values_before, _ = await writer.app_state(plan, app, after=False)
    moved: list[tuple[RepoPath, RepoPath]] = []
    deleted: list[RepoPath] = []
    tweak = fleet.child(f"values-{ref.exclusion_key}.yaml")
    for path in files:
        file = await writer.read(plan, path)
        text = file.content if file else ""
        if path == values_path and text.strip() not in ("", "{}"):
            blocked = _move_blocked(plan, ref, path, text, tweak)
            if blocked is not None:
                raise ChangeRefusedError(
                    f"{path} cannot move into the default: {blocked}; move it by hand first",
                    details={"rule": "adoption-blocked", "cluster": ref.id, "path": str(path)},
                )
            plan.changes.append(FileChange.create(tweak, text))
            moved.append((path, tweak))
        else:
            deleted.append(path)
        plan.previous[str(path)] = text
        plan.changes.append(
            FileChange.delete(path, last_commit_id=file.last_commit_id if file else None)
        )
    gitkeep = None
    registration = layout.registration_dir(ref)
    if registration is not None and not plan.tree.is_dir(registration):
        gitkeep = registration.child(layout.GITKEEP)
        plan.changes.append(FileChange.create(gitkeep, ""))
    after_app = PlannedApp(team.name, ref, chart, AppSource.FLEET_DEFAULT, destination.ocp_version)
    deploy_after, values_after, _ = await writer.app_state(plan, after_app, after=True)
    changes = [
        *key_changes("deploy", deploy_before, deploy_after),
        *key_changes("values", values_before, values_after),
    ]
    return Adoption(ref, tuple(moved), tuple(deleted), gitkeep, tuple(changes))


def _move_blocked(
    plan: AuthoringPlan, ref: ClusterRef, path: RepoPath, text: str, tweak: RepoPath
) -> str | None:
    """Why ``path``'s values cannot become the default's ``tweak``, if they cannot."""
    _, problem = parse_values(text, path=str(path))
    if problem is not None:
        return problem.message
    if ref.exclusion_key in ALLOWED_ENVS:
        return f"{tweak.name} would be the {ref.exclusion_key} env layer"
    if plan.state.repo.tree.is_file(tweak) or plan.pending(tweak) is not None:
        return f"{tweak} exists already (another destination named {ref.exclusion_key})"
    return None
