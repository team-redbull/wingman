"""Create: a new add-on in a team's catalog, and the checks of what it sets (ADR-0043)."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final

from wingman_day2.application.authoring.plan import AuthoringPlan, Effect
from wingman_day2.domain.clusters import DefaultsScope
from wingman_day2.domain.deploy_config import (
    DEFAULT_PATH,
    DEFAULT_REVISION,
    IGNORE_DIFFERENCES,
    PATH,
    PROJECT_NAMESPACE,
    REPOURL,
    SYNC_POLICY,
    TARGET_REVISION,
)
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.sync_policy import SyncSettings, full_policy

NAMESPACE: Final = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")
"""A Kubernetes namespace name (a DNS label)."""


@dataclass(frozen=True, slots=True)
class NewAddon:
    """A new add-on for a team's catalog, optionally a fleet default at once."""

    team: str
    chart: str
    repourl: str
    sync: SyncSettings
    target_revision: str | None = None
    path: str | None = None
    project_namespace: str | None = None
    ignore_differences: list[object] | None = None
    values: Mapping[str, object] = field(default_factory=dict)
    default_scope: DefaultsScope | None = None
    default_values: Mapping[str, object] = field(default_factory=dict)
    confirm_changes: tuple[str, ...] = ()


def new_deploy_config(spec: NewAddon) -> dict[str, object]:
    """The ``<chart>.yaml`` of a new add-on: only the keys that are set, lowercase ``repourl``."""
    doc: dict[str, object] = {REPOURL: spec.repourl.strip()}
    if spec.target_revision and spec.target_revision != DEFAULT_REVISION:
        doc[TARGET_REVISION] = spec.target_revision
    if spec.path and spec.path.strip("/") not in ("", DEFAULT_PATH):
        doc[PATH] = spec.path.strip("/")
    if spec.project_namespace:
        doc[PROJECT_NAMESPACE] = spec.project_namespace
    policy = full_policy(spec.sync)
    if policy:
        doc[SYNC_POLICY] = policy
    if spec.ignore_differences:
        doc[IGNORE_DIFFERENCES] = list(spec.ignore_differences)
    return doc


def check_namespace(namespace: object) -> None:
    """Refuse a value that is no Kubernetes namespace name."""
    if namespace is not None and not NAMESPACE.match(str(namespace)):
        raise ChangeRefusedError(
            f"{namespace!r} is not a Kubernetes namespace name (lowercase letters, digits, '-')",
            details={"rule": "namespace-invalid"},
        )


def check_ignore_differences(value: object) -> None:
    """Refuse a value that is not ArgoCD's list of ``ignoreDifferences`` entries."""
    if value is not None and not (
        isinstance(value, list) and all(isinstance(item, dict) for item in value)
    ):
        raise ChangeRefusedError(
            "ignoreDifferences is ArgoCD's list of {group, kind, jsonPointers, ...} entries",
            details={"rule": "ignore-differences-invalid"},
        )


def sync_words(sync: SyncSettings) -> str:
    """``sync`` in words: ``auto-sync with prune and ...``, or ``manual sync and ...``."""
    mode = (
        "auto-sync"
        + (" with prune" if sync.prune else "")
        + (" and self-heal" if sync.self_heal else "")
        if sync.auto_sync
        else "manual sync"
    )
    options = ", ".join(sync.sync_options) if sync.sync_options else "no sync options"
    return f"{mode} and {options}"


def existing_note(plan: AuthoringPlan) -> str | None:
    """The note on destinations that had the chart before and whose deploy config changes."""
    changed = [i for i in plan.impact if i.effect is Effect.CHANGED]
    if not changed:
        return None
    return (
        f"{len(changed)} destination(s) already deploy {plan.chart} "
        f"({', '.join(i.ref.name for i in changed)}), and this change moves what they deploy: "
        "listed below key by key, each to be confirmed. A manual-sync leaf deploys it when "
        "someone syncs it; an auto-sync one at once."
    )
