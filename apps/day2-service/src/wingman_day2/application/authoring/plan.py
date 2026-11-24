"""An authoring MR's plan: what it writes, what it does to each destination, and its digest."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

from wingman_core.domain.git import FileChange, RepoPath
from wingman_core.domain.merge_request import MergeRequest
from wingman_day2.application.topology import TeamState
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ClusterKind, ClusterRef, DefaultsScope
from wingman_day2.domain.findings import Finding
from wingman_day2.domain.platform import AppSource, PlannedApp, TeamPlan
from wingman_day2.domain.tree import RepoTree
from wingman_day2.domain.yaml_text import same_value
from wingman_day2.domain.yaml_values import YamlProblem

SCOPE_LABELS: Final = {
    DefaultsScope.HUB: "the hub",
    DefaultsScope.MCES: "every MCE",
    DefaultsScope.HOSTED_CLUSTERS: "every hosted cluster",
    DefaultsScope.UPI: "every UPI cluster",
}
"""How a fleet scope is named to people: in titles, notes and the web."""

SCOPE_NOUNS: Final = {
    DefaultsScope.HUB: "hub",
    DefaultsScope.MCES: "MCE(s)",
    DefaultsScope.HOSTED_CLUSTERS: "hosted cluster(s)",
    DefaultsScope.UPI: "UPI cluster(s)",
}

SCOPE_ORDER: Final = (
    DefaultsScope.HOSTED_CLUSTERS,
    DefaultsScope.MCES,
    DefaultsScope.HUB,
    DefaultsScope.UPI,
)
"""The order the web shows the scopes in."""


class Action(StrEnum):
    """What an authoring MR does: its branch action, label and footer ``Action``."""

    CREATE = "create-addon"
    UPDATE_DEFAULT = "update-default"
    MAKE_DEFAULT = "make-default"
    OVERRIDE_VALUES = "override-values"


class Effect(StrEnum):
    """What an MR does to one destination's app of the chart."""

    CHANGED = "changed"
    REMOVED = "removed"
    ADDED = "added"


@dataclass(frozen=True, slots=True)
class KeyChange:
    """One leaf of a destination's effective deploy config or values that the MR changes.

    ``after_null`` is a Helm ``null``: the key is deleted, the chart's own default with it.
    """

    stack: str
    key: str
    before: object
    after: object
    after_null: bool = False

    def details(self) -> dict[str, object]:
        """As plain data."""
        return {
            "stack": self.stack,
            "key": self.key,
            "before": self.before,
            "after": self.after,
            "after_null": self.after_null,
        }


@dataclass(frozen=True, slots=True)
class Adoption:
    """A cluster whose own chart folder moves into the new fleet default.

    ``exclusion_removed``: an entry of the scope's ``exclusions.yaml`` named it
    for the chart (inert until now, the chart was no default), and would have
    deleted its app; the entry goes in the same commit.
    """

    ref: ClusterRef
    moved: tuple[tuple[RepoPath, RepoPath], ...]
    deleted: tuple[RepoPath, ...]
    gitkeep: RepoPath | None
    changes: tuple[KeyChange, ...]
    exclusion_removed: bool = False

    def details(self) -> dict[str, object]:
        """The adoption as plain data, for a problem's ``details``."""
        return {
            "cluster": self.ref.id,
            "name": self.ref.name,
            "changes": [c.details() for c in self.changes],
            "exclusion_removed": self.exclusion_removed,
        }


@dataclass(frozen=True, slots=True)
class DestinationImpact:
    """What the MR does to the chart's app on one destination."""

    ref: ClusterRef
    effect: Effect
    app_name: str
    changes: tuple[KeyChange, ...] = ()

    @property
    def orphaned(self) -> bool:
        """Whether the Application goes and its workload keeps running, unmanaged."""
        return self.effect is Effect.REMOVED

    @property
    def needs_confirmation(self) -> bool:
        """Whether the request must name this destination in ``confirm_changes``."""
        return self.effect is Effect.REMOVED or (
            self.effect is Effect.CHANGED and bool(self.changes)
        )

    def details(self) -> dict[str, object]:
        """As plain data."""
        return {
            "cluster": self.ref.id,
            "name": self.ref.name,
            "effect": str(self.effect),
            "app_name": self.app_name,
            "changes": [c.details() for c in self.changes],
            "orphaned": self.orphaned,
        }


@dataclass(slots=True)
class AuthoringPlan:
    """Everything one authoring MR writes and what it does."""

    state: TeamState
    action: Action
    chart: str
    scope: DefaultsScope | None
    title: str = ""
    changes: list[FileChange] = field(default_factory=list)
    previous: dict[str, str] = field(default_factory=dict)
    reach: list[ClusterRef] = field(default_factory=list)
    adopted: list[Adoption] = field(default_factory=list)
    impact: list[DestinationImpact] = field(default_factory=list)
    excluded: list[ClusterRef] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    docs: dict[str, tuple[dict[str, object], YamlProblem | None]] = field(
        default_factory=dict, repr=False
    )

    @property
    def team(self) -> str:
        """The team's name."""
        return self.state.team.name

    @property
    def tree(self) -> RepoTree:
        """The team repo as it would be after the MR."""
        return self.state.repo.tree.with_changes(self.changes)

    @property
    def needs_confirmation(self) -> list[str]:
        """The ids the request must confirm: what goes or changes, and moves that change."""
        ids = {a.ref.id for a in self.adopted if a.changes or a.exclusion_removed}
        ids |= {i.ref.id for i in self.impact if i.needs_confirmation}
        return sorted(ids)

    @property
    def digest(self) -> str:
        """A sha256 of what the MR writes and does; the preview's must match the submit's."""
        payload = {
            "title": self.title,
            "files": [
                [str(c.kind), str(c.path), c.content, str(c.previous_path or "")]
                for c in self.changes
            ],
            "impact": [i.details() for i in self.impact],
            "adopted": [a.details() for a in self.adopted],
        }
        text = json.dumps(_canonical(payload), sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(text.encode()).hexdigest()

    def pending(self, path: RepoPath) -> FileChange | None:
        """The last change this plan makes to ``path``."""
        return next((c for c in reversed(self.changes) if c.path == path), None)


@dataclass(frozen=True, slots=True)
class AuthoringResult:
    """A plan, and the MR it opened (``None`` for a dry run)."""

    plan: AuthoringPlan
    merge_request: MergeRequest | None


def _canonical(value: object) -> object:
    """``value`` with every mapping key a string (YAML allows ``1:``; JSON sorting does not)."""
    if isinstance(value, Mapping):
        return {f"{type(k).__name__}:{k}": _canonical(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_canonical(v) for v in value]
    return value


def flatten(values: object, prefix: str = "") -> dict[str, object]:
    """Dotted leaves of ``values`` (an empty mapping is a leaf)."""
    if isinstance(values, dict) and values:
        out: dict[str, object] = {}
        for key, sub in values.items():
            out |= flatten(sub, f"{prefix}.{key}" if prefix else str(key))
        return out
    return {prefix: values} if prefix else {}


def key_changes(stack: str, before: dict[str, object], after: dict[str, object]) -> list[KeyChange]:
    """Every leaf that differs between ``before`` and ``after``, by dotted key."""
    old, new = flatten(before), flatten(after)
    return [
        KeyChange(stack, key, old.get(key), new.get(key), key in new and new[key] is None)
        for key in sorted({*old, *new})
        if key not in old or key not in new or not same_value(old[key], new[key])
    ]


def scope_destinations(plan: TeamPlan, scope: DefaultsScope) -> tuple[ClusterRef, ...]:
    """The destinations of ``scope`` a team registers that the platform renders."""
    return tuple(d.ref for d in plan.destinations if d.ref.defaults_scope is scope and d.renders)


def fleet_apps(plan: TeamPlan, chart: str, scope: DefaultsScope) -> list[PlannedApp]:
    """The apps a fleet default of ``chart`` generates (on the hub, the hub's own folder)."""
    if scope is DefaultsScope.HUB:
        return [a for a in plan.apps if a.ref.kind is ClusterKind.HUB and a.chart == chart]
    return [
        a
        for a in plan.apps
        if a.chart == chart
        and a.source is AppSource.FLEET_DEFAULT
        and a.ref.defaults_scope is scope
    ]


def tweak_path(scope: DefaultsScope, chart: str, ref: ClusterRef) -> RepoPath:
    """``defaults/<scope>/<chart>/values-<name>.yaml``: a fleet default's values for one name."""
    return layout.defaults_dir(scope).child(chart, f"values-{ref.exclusion_key}.yaml")
