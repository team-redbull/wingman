"""Edit a team default: ``operators/<chart>/<chart>.yaml`` in place, and what it reaches."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final

from wingman_day2.application.authoring.chart_repo import check_repourl
from wingman_day2.application.authoring.create import check_ignore_differences, check_namespace
from wingman_day2.application.authoring.plan import AuthoringPlan, Effect
from wingman_day2.application.authoring.writer import PlanWriter
from wingman_day2.domain import layout
from wingman_day2.domain.deploy_config import (
    DEFAULT_PATH,
    DEFAULT_REVISION,
    IGNORE_DIFFERENCES,
    PATH,
    PROJECT_NAMESPACE,
    REPOURL,
    SYNC_POLICY,
    TARGET_REVISION,
    miscased_repourl_keys,
    truthy,
)
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.findings import Rule
from wingman_day2.domain.platform import TeamPlan
from wingman_day2.domain.sync_policy import SyncSettings, full_policy
from wingman_day2.domain.yaml_text import dump_yaml, edit_mapping_text, same_value
from wingman_day2.domain.yaml_values import parse_values
from wingman_day2.ports import ChartRepository

EDITABLE_KEYS: Final = (REPOURL, TARGET_REVISION, PATH, PROJECT_NAMESPACE, IGNORE_DIFFERENCES)
"""The team-default deploy-config keys an edit may set (sync options go separately)."""


@dataclass(frozen=True, slots=True)
class TeamDefaultEdit:
    """An edit of ``operators/<chart>/``: the keys it sets (``None`` removes), sync, values."""

    keys: Mapping[str, object | None] = field(default_factory=dict)
    sync: SyncSettings | None = None
    values: Mapping[str, object] | None = None
    last_commit_id: str | None = None


async def plan_deploy_edit(
    writer: PlanWriter, charts: ChartRepository, plan: AuthoringPlan, edit: TeamDefaultEdit
) -> dict[str, object]:
    """Edit the chart's ``<chart>.yaml`` in place, comments kept; the deploy config after it.

    A repo, revision or path the edit sets is checked as a new add-on's is. The
    write is guarded by the caller's read, and refused if the file was deleted
    since (ADR-0006).
    """
    path = layout.operators_dir(plan.chart).child(layout.deploy_config_name(plan.chart))
    file = await writer.read(plan, path) if plan.state.repo.tree.is_file(path) else None
    if file is None:
        await writer.refuse_if_deleted(plan, path, edit.last_commit_id)
    old_text = file.content if file else ""
    doc, problem = parse_values(old_text, path=str(path))
    if problem is not None:
        raise ChangeRefusedError(
            f"{problem.message} ({path}): fix it by hand first",
            details={"rule": str(Rule.YAML_INVALID), "path": str(path)},
        )
    new, renames = edited_deploy(doc, edit)
    if {REPOURL, TARGET_REVISION, PATH} & set(edit.keys) and truthy(new.get(REPOURL)):
        plan.findings += await check_repourl(
            charts,
            str(new[REPOURL]),
            new.get(TARGET_REVISION),
            new.get(PATH),
            file=str(path),
            where={"team": plan.team, "chart": plan.chart},
        )
    if not same_value(new, doc):
        text = (
            edit_mapping_text(old_text, new, path=str(path), renames=renames)
            if file
            else dump_yaml(new)
        )
        writer.write(plan, path, text, file, edit.last_commit_id)
    return new


def team_reach(
    plan: AuthoringPlan, after: TeamPlan, edit: TeamDefaultEdit, new: Mapping[str, object]
) -> None:
    """Fill ``plan.reach`` with every destination that gets the chart, and say what it inherits."""
    plan.reach = sorted({a.ref for a in after.apps if a.chart == plan.chart}, key=lambda r: r.id)
    changed = sum(1 for i in plan.impact if i.effect is Effect.CHANGED)
    revision = (
        f"targetRevision moves to {new.get(TARGET_REVISION) or DEFAULT_REVISION} on every one "
        "that does not pin it. "
        if TARGET_REVISION in edit.keys
        else ""
    )
    plan.notes.append(
        f"Destinations that get {plan.chart} from {plan.team} inherit these Sig values and "
        "deploy config unless an OCP-version pin, a fleet default or their own folder sets the "
        f"same key: {len(plan.reach)} destination(s) get {plan.chart} today, and what {changed} "
        f"of them deploy changes (listed key by key). {revision}"
        "Leaves that are manual-sync deploy the change only when someone syncs them."
    )


def edited_deploy(
    doc: Mapping[str, object], edit: TeamDefaultEdit
) -> tuple[dict[str, object], dict[str, str]]:
    """The deploy config after ``edit``, and the miscased keys renamed to ``repourl``."""
    unknown = sorted(set(edit.keys) - set(EDITABLE_KEYS))
    if unknown:
        raise ChangeRefusedError(
            f"{unknown[0]} is not a key Wingman edits", details={"rule": "key-not-editable"}
        )
    new = dict(doc)
    renames: dict[str, str] = {}
    for key, value in edit.keys.items():
        edited = _edited_value(key, value)
        if key == REPOURL:
            new, renames = _lowercase_repourl(new)
        _put(new, key, edited)
    if edit.sync is not None:
        _put(new, SYNC_POLICY, full_policy(edit.sync.checked(), new.get(SYNC_POLICY)) or None)
    return new, renames


def _edited_value(key: str, value: object | None) -> object | None:
    """``value`` checked for ``key``; ``None`` for the platform's own default, which removes it."""
    if key == REPOURL:
        if value is None or not str(value).strip():
            raise ChangeRefusedError(
                "repourl cannot be removed: the platform needs it to find the chart",
                details={"rule": str(Rule.REPOURL_MISSING)},
            )
        return str(value).strip()
    if key == PROJECT_NAMESPACE:
        check_namespace(value)
    if key == IGNORE_DIFFERENCES:
        check_ignore_differences(value)
    if key == TARGET_REVISION and value == DEFAULT_REVISION:
        return None
    if key == PATH and value is not None and str(value).strip("/") in ("", DEFAULT_PATH):
        return None
    return value


def _lowercase_repourl(doc: dict[str, object]) -> tuple[dict[str, object], dict[str, str]]:
    """``doc`` without its miscased ``repourl`` keys: the first one renamed, in place, if needed."""
    miscased = miscased_repourl_keys(doc)
    if not miscased or REPOURL in doc:
        return {k: v for k, v in doc.items() if k not in miscased}, {}
    first, strays = miscased[0], miscased[1:]
    renamed = {(REPOURL if k == first else k): v for k, v in doc.items() if k not in strays}
    return renamed, {first: REPOURL}


def _put(doc: dict[str, object], key: str, value: object | None) -> None:
    # An empty value removes the key: ArgoCD reads `ignoreDifferences: []` as none too.
    if value is None or value == "" or value == []:
        doc.pop(key, None)
    else:
        doc[key] = value
