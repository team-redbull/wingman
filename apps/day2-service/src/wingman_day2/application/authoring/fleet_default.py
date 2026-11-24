"""Fleet defaults: make one, adopting the clusters' own folders, and say what it reaches."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from enum import Enum
from typing import Final, Literal

from wingman_core.domain.git import FileChange, RepoPath
from wingman_day2.application.authoring.plan import (
    SCOPE_LABELS,
    SCOPE_NOUNS,
    Adoption,
    AuthoringPlan,
    Effect,
    fleet_apps,
    key_changes,
)
from wingman_day2.application.authoring.writer import PlanWriter
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ALLOWED_ENVS, ClusterKind, DefaultsScope
from wingman_day2.domain.deploy_config import SYNC_POLICY, leaf_application
from wingman_day2.domain.errors import ChangeRefusedError, ChartAlreadyInstalledError
from wingman_day2.domain.exclusions import set_excluded
from wingman_day2.domain.findings import Rule, warning
from wingman_day2.domain.merge import merge_values
from wingman_day2.domain.platform import (
    AppSource,
    Destination,
    PlannedApp,
    TeamPlan,
    scope_exclusions,
)
from wingman_day2.domain.sync_policy import SyncSettings, policy_override, sync_settings
from wingman_day2.domain.yaml_text import dump_yaml
from wingman_day2.domain.yaml_values import dump_values, parse_values


class _Unset(Enum):
    UNSET = "unset"


UNSET: Final = _Unset.UNSET
"""A field the request left out: leave it as it is."""

type Unset = Literal[_Unset.UNSET]


async def plan_default(
    writer: PlanWriter,
    plan: AuthoringPlan,
    scope: DefaultsScope,
    *,
    values: Mapping[str, object],
    sync: SyncSettings | None,
) -> None:
    """Add a new fleet default of the plan's chart on ``scope``, and adopt its clusters' folders."""
    chart = plan.chart
    base = plan.state.repo.tree
    fleet = layout.defaults_dir(scope).child(chart)
    if base.is_dir(fleet):
        raise ChartAlreadyInstalledError(
            f"{chart} is a fleet default on {SCOPE_LABELS[scope]} already ({fleet}/); edit it "
            "instead",
            details={"rule": "default-exists", "path": str(fleet)},
        )
    name = layout.deploy_config_name(chart)
    fleet_doc: dict[str, object] = {}
    if sync is not None:
        team_doc = await writer.doc(plan, layout.operators_dir(chart).child(name), after=True)
        override = policy_override([team_doc], sync.checked())
        if override:
            fleet_doc[SYNC_POLICY] = override
    plan.changes.append(FileChange.create(fleet.child(layout.VALUES_FILE), dump_values(values)))
    if fleet_doc:
        plan.changes.append(FileChange.create(fleet.child(name), dump_yaml(fleet_doc)))
    exclusions = (
        scope_exclusions(plan.state.repo, scope) if scope is not DefaultsScope.HUB else None
    )
    listed = set(exclusions.names(chart)) if exclusions else set()
    for destination in plan.state.plan.destinations:
        ref = destination.ref
        if ref.kind is ClusterKind.HUB or ref.defaults_scope is not scope:
            continue
        if base.is_dir(layout.chart_dir(ref, chart)):
            adoption = await adopt(writer, plan, destination, fleet)
            if ref.exclusion_key in listed:
                adoption = replace(adoption, exclusion_removed=True)
            plan.adopted.append(adoption)
    await _drop_stale_entries(writer, plan, scope)


async def _drop_stale_entries(
    writer: PlanWriter, plan: AuthoringPlan, scope: DefaultsScope
) -> None:
    """Remove the ``exclusions.yaml`` entries that would delete an adopted cluster's app.

    Until the default exists, an entry for its chart is inert (and a lint
    error: it names no chart folder). Once the folder is there it excludes
    the cluster, and the cluster's own folder is gone with the move: its
    app would be deleted and its workload orphaned. The cluster asked for
    nothing of the kind, and the entry is stale, so it goes in the same
    commit; the cluster is listed for confirmation (ADR-0053).
    """
    stale = {a.ref.exclusion_key or "" for a in plan.adopted if a.exclusion_removed}
    if not stale:
        return
    path = layout.exclusions_file(scope)
    file = await writer.read(plan, path)
    if file is None:
        return
    exclusions = scope_exclusions(plan.state.repo, scope)
    names = [n for n in (exclusions.names(plan.chart) if exclusions else ()) if n not in stale]
    text = set_excluded(file.content, plan.chart, names, path=str(path))
    if text is not None and text != file.content:
        writer.write(plan, path, text, file, None)
    plan.notes.append(
        f"{path} names {', '.join(sorted(stale))} for {plan.chart}: an entry that does "
        "nothing today (there is no default to exclude from) and that would delete the app "
        "of each once the default exists, because its own folder moves into the default. "
        "The entry goes in this MR, so each keeps its Application."
    )


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
            _, problem = parse_values(text, path=str(path))
            blocked = (
                problem.message
                if problem is not None
                else f"{tweak.name} would be the {ref.exclusion_key} env layer"
                if ref.exclusion_key in ALLOWED_ENVS
                else f"{tweak} exists already (another destination named {ref.exclusion_key})"
                if base.is_file(tweak) or plan.pending(tweak) is not None
                else None
            )
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


async def reach(
    writer: PlanWriter,
    plan: AuthoringPlan,
    after: TeamPlan,
    scope: DefaultsScope,
    *,
    new_default: bool = True,
) -> None:
    """Fill ``plan.reach`` with the default's destinations, and say what the merge does."""
    apps = fleet_apps(after, plan.chart, scope)
    plan.reach = [a.ref for a in apps]
    label = SCOPE_LABELS[scope]
    project = plan.state.team.project.path_with_namespace
    if not apps:
        plan.notes.append(
            f"{project} registers no {SCOPE_NOUNS[scope]} yet: the default deploys to each "
            "one once the team has a folder for it."
        )
        return
    leaves = []
    for app in apps:
        docs = [
            (str(x.path), await writer.doc(plan, x.path, after=True))
            for x in app.deploy_config_layers
        ]
        merged = merge_values({}, docs).values
        leaves.append(leaf_application(merged, team=plan.team, chart=plan.chart, ref=app.ref))
    auto = sum(1 for leaf in leaves if leaf.auto_sync)
    verb = "generates" if new_default else "updates"
    names = sorted({leaf.name for leaf in leaves})
    leaf_name = names[0] if len(names) == 1 else f"{plan.team}-<cluster>-{plan.chart}-deploy"
    where = (
        "the hub"
        if scope is DefaultsScope.HUB
        else f"the {len(apps)} {SCOPE_NOUNS[scope]} {project} registers "
        f"({', '.join(a.ref.name for a in apps)}), on each one's ArgoCD"
    )
    plan.notes.append(
        f"After the merge, ArgoCD {verb} {leaf_name} on {where}. "
        + (
            "They sync by themselves (auto-sync)."
            if auto == len(leaves)
            else "They are manual-sync: nothing deploys until someone syncs each one in "
            "ArgoCD (Wingman has no ArgoCD access yet)."
            if auto == 0
            else f"{auto} of them sync by themselves; the others wait for a manual sync."
        )
    )
    if plan.excluded:
        plan.notes.append(
            f"{layout.exclusions_file(scope)} keeps it off "
            f"{', '.join(r.name for r in plan.excluded)}."
        )
    removed = [i for i in plan.impact if i.effect is Effect.REMOVED]
    if plan.adopted:
        plan.notes.append(
            f"{len(plan.adopted)} of them had {plan.chart} in their own folder: those folders "
            "move into the default in this MR (a non-empty values.yaml becomes "
            f"defaults/{scope}/{plan.chart}/values-<cluster>.yaml), so their Applications keep "
            "their names and ArgoCD neither deletes nor re-creates them."
            + ("" if removed else " Nothing is orphaned.")
        )
    settings = {sync_settings(leaf.sync_policy) for leaf in leaves}
    if len(settings) > 1:
        plan.findings.append(
            warning(
                Rule.SYNC_DIFFERS,
                f"{plan.chart}'s sync options differ between destinations of {label}: an "
                "OCP-version pin or a cluster's own deploy config sets them for some",
                team=plan.team,
                chart=plan.chart,
            )
        )
