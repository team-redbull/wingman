"""Fleet defaults: make one, edit its sync settings, and say what it reaches (ADR-0053)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
from enum import Enum
from typing import Final, Literal

from wingman_core.domain.git import FileChange, RepoPath
from wingman_day2.application.authoring.adoption import adopt
from wingman_day2.application.authoring.plan import (
    SCOPE_LABELS,
    SCOPE_NOUNS,
    AuthoringPlan,
    Effect,
    fleet_apps,
)
from wingman_day2.application.authoring.writer import PlanWriter
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ClusterKind, DefaultsScope
from wingman_day2.domain.deploy_config import SYNC_POLICY, LeafApplication, leaf_application
from wingman_day2.domain.errors import ChangeRefusedError, ChartAlreadyInstalledError
from wingman_day2.domain.exclusions import set_excluded
from wingman_day2.domain.findings import Rule, warning
from wingman_day2.domain.merge import merge_values
from wingman_day2.domain.platform import PlannedApp, TeamPlan, scope_exclusions
from wingman_day2.domain.sync_policy import (
    AUTOMATED,
    SYNC_OPTIONS,
    SyncSettings,
    policy_override,
    sync_settings,
)
from wingman_day2.domain.yaml_text import dump_yaml, edit_mapping_text, same_value
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


async def plan_sync(
    writer: PlanWriter,
    plan: AuthoringPlan,
    path: RepoPath,
    sync: SyncSettings | None,
    last_commit_id: str | None,
) -> None:
    """Set the fleet layer's sync settings in ``path``; ``None`` goes back to the team default's.

    The file is edited in place (comments and untouched lines kept), guarded by
    ``last_commit_id``.
    """
    file = await writer.read(plan, path) if plan.state.repo.tree.is_file(path) else None
    old_text = file.content if file else ""
    doc, problem = parse_values(old_text, path=str(path))
    if problem is not None:
        raise ChangeRefusedError(
            f"{problem.message} ({path}): fix it by hand first",
            details={"rule": str(Rule.YAML_INVALID), "path": str(path)},
        )
    policy = await _fleet_policy(writer, plan, doc.get(SYNC_POLICY), sync)
    new = (
        {**doc, SYNC_POLICY: policy}
        if policy
        else {k: v for k, v in doc.items() if k != SYNC_POLICY}
    )
    if not same_value(new, doc):
        text = edit_mapping_text(old_text, new, path=str(path)) if file else dump_yaml(new)
        writer.write(plan, path, text, file, last_commit_id)


async def _fleet_policy(
    writer: PlanWriter, plan: AuthoringPlan, current: object, sync: SyncSettings | None
) -> dict[str, object]:
    """The fleet layer's ``syncPolicy`` for ``sync``; for ``None``, ``current`` without them."""
    if sync is None:
        policy = dict(current) if isinstance(current, Mapping) else {}
        policy.pop(AUTOMATED, None)
        policy.pop(SYNC_OPTIONS, None)
        return policy
    team_deploy = layout.operators_dir(plan.chart).child(layout.deploy_config_name(plan.chart))
    team_doc = await writer.doc(plan, team_deploy, after=False)
    return policy_override([team_doc], sync.checked(), current)


async def fleet_reach(
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
    if not apps:
        plan.notes.append(
            f"{plan.state.team.project.path_with_namespace} registers no {SCOPE_NOUNS[scope]} "
            "yet: the default deploys to each one once the team has a folder for it."
        )
        return
    leaves = [await _leaf(writer, plan, app) for app in apps]
    plan.notes.append(_merge_note(plan, scope, apps, leaves, new_default=new_default))
    if plan.excluded:
        plan.notes.append(
            f"{layout.exclusions_file(scope)} keeps it off "
            f"{', '.join(r.name for r in plan.excluded)}."
        )
    if plan.adopted:
        removed = any(i.effect is Effect.REMOVED for i in plan.impact)
        plan.notes.append(
            f"{len(plan.adopted)} of them had {plan.chart} in their own folder: those folders "
            "move into the default in this MR (a non-empty values.yaml becomes "
            f"defaults/{scope}/{plan.chart}/values-<cluster>.yaml), so their Applications keep "
            "their names and ArgoCD neither deletes nor re-creates them."
            + ("" if removed else " Nothing is orphaned.")
        )
    if len({sync_settings(leaf.sync_policy) for leaf in leaves}) > 1:
        plan.findings.append(
            warning(
                Rule.SYNC_DIFFERS,
                f"{plan.chart}'s sync options differ between destinations of "
                f"{SCOPE_LABELS[scope]}: an OCP-version pin or a cluster's own deploy config sets "
                "them for some",
                team=plan.team,
                chart=plan.chart,
            )
        )


async def _leaf(writer: PlanWriter, plan: AuthoringPlan, app: PlannedApp) -> LeafApplication:
    """The leaf Application ``app`` generates after the MR."""
    docs = [
        (str(x.path), await writer.doc(plan, x.path, after=True)) for x in app.deploy_config_layers
    ]
    merged = merge_values({}, docs).values
    return leaf_application(merged, team=plan.team, chart=plan.chart, ref=app.ref)


def _merge_note(
    plan: AuthoringPlan,
    scope: DefaultsScope,
    apps: Sequence[PlannedApp],
    leaves: Sequence[LeafApplication],
    *,
    new_default: bool,
) -> str:
    """What ArgoCD does once the MR is merged: which Application, where, and how it syncs."""
    project = plan.state.team.project.path_with_namespace
    verb = "generates" if new_default else "updates"
    names = sorted({leaf.name for leaf in leaves})
    leaf_name = names[0] if len(names) == 1 else f"{plan.team}-<cluster>-{plan.chart}-deploy"
    where = (
        "the hub"
        if scope is DefaultsScope.HUB
        else f"the {len(apps)} {SCOPE_NOUNS[scope]} {project} registers "
        f"({', '.join(a.ref.name for a in apps)}), on each one's ArgoCD"
    )
    sync = _sync_sentence(sum(1 for leaf in leaves if leaf.auto_sync), len(leaves))
    return f"After the merge, ArgoCD {verb} {leaf_name} on {where}. {sync}"


def _sync_sentence(auto: int, total: int) -> str:
    if auto == total:
        return "They sync by themselves (auto-sync)."
    if auto == 0:
        return (
            "They are manual-sync: nothing deploys until someone syncs each one in ArgoCD "
            "(Wingman has no ArgoCD access yet)."
        )
    return f"{auto} of them sync by themselves; the others wait for a manual sync."
