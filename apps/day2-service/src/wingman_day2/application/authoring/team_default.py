"""Edit a team default: the keys of ``operators/<chart>/<chart>.yaml`` an edit may set."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final

from wingman_day2.application.authoring.create import check_ignore_differences, check_namespace
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
)
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.findings import Rule
from wingman_day2.domain.sync_policy import SyncSettings, full_policy

EDITABLE_KEYS: Final = (REPOURL, TARGET_REVISION, PATH, PROJECT_NAMESPACE, IGNORE_DIFFERENCES)
"""The team-default deploy-config keys an edit may set (sync options go separately)."""


@dataclass(frozen=True, slots=True)
class TeamDefaultEdit:
    """An edit of ``operators/<chart>/``: the keys it sets (``None`` removes), sync, values."""

    keys: Mapping[str, object | None] = field(default_factory=dict)
    sync: SyncSettings | None = None
    values: Mapping[str, object] | None = None
    last_commit_id: str | None = None


def edited_deploy(  # noqa: C901 - baseline: one rule per editable key
    doc: Mapping[str, object], edit: TeamDefaultEdit
) -> tuple[dict[str, object], dict[str, str]]:
    """The deploy config after ``edit``, and the miscased keys renamed to ``repourl``."""
    new = dict(doc)
    renames: dict[str, str] = {}
    unknown = sorted(set(edit.keys) - set(EDITABLE_KEYS))
    if unknown:
        raise ChangeRefusedError(
            f"{unknown[0]} is not a key Wingman edits", details={"rule": "key-not-editable"}
        )
    for key, value in edit.keys.items():
        if key == REPOURL:
            if value is None or not str(value).strip():
                raise ChangeRefusedError(
                    "repourl cannot be removed: the platform needs it to find the chart",
                    details={"rule": str(Rule.REPOURL_MISSING)},
                )
            miscased = miscased_repourl_keys(new)
            if miscased and REPOURL not in new:
                renames[miscased[0]] = REPOURL
                new = {(REPOURL if k == miscased[0] else k): v for k, v in new.items()}
                miscased = miscased[1:]
            for stray in miscased:
                new.pop(stray, None)
            value = str(value).strip()
        if key == PROJECT_NAMESPACE:
            check_namespace(value)
        if key == IGNORE_DIFFERENCES:
            check_ignore_differences(value)
        if key == TARGET_REVISION and value == DEFAULT_REVISION:
            value = None
        if key == PATH and value is not None and str(value).strip("/") in ("", DEFAULT_PATH):
            value = None
        # An empty value removes the key: ArgoCD reads `ignoreDifferences: []` as none too.
        if value is None or value == "" or value == []:
            new.pop(key, None)
        else:
            new[key] = value
    if edit.sync is not None:
        policy = full_policy(edit.sync.checked(), new.get(SYNC_POLICY))
        if policy:
            new[SYNC_POLICY] = policy
        else:
            new.pop(SYNC_POLICY, None)
    return new, renames
