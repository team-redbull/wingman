"""An add-on's OCP-version pins: add, change and remove, one MR each (ADR-0043's amendment).

The fixture's ``redbull/cluster-roles`` tracks ``main`` (its chart repo also
has the branches ``2.0.0`` and ``2.1.5-hotfix``) on four hosted clusters and a
UPI cluster: eyal and itay run OCP 4.20.9, herzi, karniol and dok 4.16.27.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from functools import partial

import pytest
import yaml

from wingman_core.domain.errors import RevisionConflictError
from wingman_core.domain.git import ChangeKind, FileChange, RepoPath
from wingman_core.domain.users import User
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab
from wingman_day2.application.authoring import AuthoringResult, Effect, NewAddon
from wingman_day2.application.ocp_pins import PinChange
from wingman_day2.application.services import Day2Services
from wingman_day2.domain.errors import (
    ChangeRefusedError,
    ChartAlreadyInstalledError,
    ChartNotInstalledError,
    PlanChangedError,
    TeamReadOnlyError,
    UnknownChartError,
)
from wingman_day2.domain.findings import Rule
from wingman_day2.domain.ocp_pins import PinSpec
from wingman_day2.domain.sync_policy import PLATFORM_DEFAULT
from wingman_day2.infrastructure.repositories import GitLabSigsRepository
from wingman_day2.settings import FAKE_GITLAB_URL

PINS = "operators/cluster-roles/ocp-versions"
EYAL = "hosted:site1:prep:ocp4-prep-mce-site1-a:ocp4-prep-eyal-site1"
ITAY = "hosted:site1:prep:ocp4-prep-mce-site1-a:ocp4-prep-itay-site1"
PIN_TEXT = "# 4.20.9 needs the RBAC fix of the hotfix branch\ntargetRevision: 2.1.5-hotfix\n"


async def confirmed(write: Callable[..., Awaitable[AuthoringResult]]) -> AuthoringResult:
    preview = await write(dry_run=True)
    return await write(
        confirm_changes=preview.plan.needs_confirmation, expected_digest=preview.plan.digest
    )


@pytest.fixture
def by_hand(
    gitlab: InMemoryGitLab, sigs: GitLabSigsRepository, services: Day2Services
) -> Callable[..., Awaitable[None]]:
    """Commit to sigs/redbull's main as a person would, and drop day2's reads of it."""

    async def commit(*changes: FileChange) -> None:
        project = await gitlab.get_project("sigs/redbull")
        await gitlab.commit(project.id, branch="main", message="by hand", changes=list(changes))
        sigs.invalidate((await services.topology.load()).team("redbull").team)

    return commit


Commit = Callable[..., Awaitable[None]]


async def files_of(gitlab: InMemoryGitLab, result: AuthoringResult) -> dict[str, str]:
    assert result.merge_request is not None
    project = await gitlab.get_project("sigs/redbull")
    return gitlab.snapshot(project.id, result.merge_request.source_branch)


async def pinned(commit: Commit, values: str | None = "extra: 1\n") -> None:
    """``cluster-roles`` pinned on 4.20.9 by hand, with a comment and, by default, values."""
    changes = [FileChange.create(RepoPath(f"{PINS}/4.20.9/cluster-roles.yaml"), PIN_TEXT)]
    if values is not None:
        changes.append(FileChange.create(RepoPath(f"{PINS}/4.20.9/values.yaml"), values))
    await commit(*changes)


async def read_at(services: Day2Services) -> str:
    """The commit the 4.20.9 pin was read at, as the add-on's page sends it back."""
    detail = await services.operators.detail("redbull", "cluster-roles")
    (pin,) = detail.ocp_versions
    file = pin.deploy.file or pin.values.file
    assert file is not None
    return file.last_commit_id


# ── add ─────────────────────────────────────────────────────────────────────


async def test_a_new_pin_moves_the_destinations_at_its_version_only(
    services: Day2Services, gitlab: InMemoryGitLab, jane_user: User
) -> None:
    write = partial(
        services.ocp_pins.add,
        "redbull",
        "cluster-roles",
        PinSpec("4.20.9", "2.1.5-hotfix", {"extra": 1}),
        jane_user,
    )
    plan = (await write(dry_run=True)).plan
    assert [(c.kind, str(c.path), c.content) for c in plan.changes] == [
        (ChangeKind.CREATE, f"{PINS}/4.20.9/cluster-roles.yaml", "targetRevision: 2.1.5-hotfix\n"),
        (ChangeKind.CREATE, f"{PINS}/4.20.9/values.yaml", "extra: 1\n"),
    ]
    assert plan.title == (
        "[Wingman/Day2] Update addon redbull/cluster-roles OCP-version pin 4.20.9 "
        "(new: 2.1.5-hotfix)"
    )
    assert [r.id for r in plan.reach] == [EYAL, ITAY]
    assert [(i.ref.id, i.effect) for i in plan.impact] == [
        (EYAL, Effect.CHANGED),
        (ITAY, Effect.CHANGED),
    ]
    assert [(c.stack, c.key, c.before, c.after) for c in plan.impact[0].changes] == [
        ("deploy", "targetRevision", "main", "2.1.5-hotfix"),
        ("values", "extra", None, 1),
    ]
    assert plan.needs_confirmation == [EYAL, ITAY]
    # Every other version the add-on runs on has no pin: said, as the lints will.
    assert any("also runs on OCP 4.16.27, with no pin" in n for n in plan.notes)
    with pytest.raises(ChangeRefusedError) as raised:
        await write()
    assert raised.value.details["rule"] == "confirm-changes"

    result = await confirmed(write)
    assert result.merge_request is not None
    assert set(result.merge_request.labels) == {"wingman", "day2", "update-default"}
    assert result.merge_request.source_branch.startswith(
        "platform/jane/update-default-cluster-roles-"
    )
    files = await files_of(gitlab, result)
    assert yaml.safe_load(files[f"{PINS}/4.20.9/cluster-roles.yaml"]) == {
        "targetRevision": "2.1.5-hotfix"
    }
    assert yaml.safe_load(files[f"{PINS}/4.20.9/values.yaml"]) == {"extra": 1}


async def test_a_pin_ahead_of_an_upgrade_changes_nothing_yet(
    services: Day2Services, jane_user: User
) -> None:
    result = await services.ocp_pins.add(
        "redbull", "cluster-roles", PinSpec("4.21.3", "2.0.0"), jane_user
    )
    assert result.merge_request is not None
    plan = result.plan
    assert [str(c.path) for c in plan.changes] == [f"{PINS}/4.21.3/cluster-roles.yaml"]
    assert plan.impact == [] and plan.reach == [] and plan.needs_confirmation == []
    assert any("No destination that gets cluster-roles runs OCP 4.21.3" in n for n in plan.notes)


async def test_a_new_pins_refusals(
    services: Day2Services, jane_user: User, by_hand: Commit
) -> None:
    add = partial(services.ocp_pins.add, "redbull", "cluster-roles", user=jane_user, dry_run=True)
    for pin, rule in [
        (PinSpec("4.20", "2.0.0"), "ocp-version-invalid"),
        (PinSpec("4.20.9", ""), "pin-revision-missing"),
        (PinSpec("4.20.9", "9.9.9"), "revision-unknown"),
    ]:
        with pytest.raises(ChangeRefusedError) as raised:
            await add(pin=pin)
        assert raised.value.details["rule"] == rule
    await pinned(by_hand)
    with pytest.raises(ChartAlreadyInstalledError) as exists:
        await add(pin=PinSpec("4.20.9", "2.0.0"))
    assert exists.value.details["rule"] == "pin-exists"
    with pytest.raises(UnknownChartError):
        await services.ocp_pins.add("redbull", "nope", PinSpec("4.20.9", "2.0.0"), jane_user)


async def test_a_read_only_team_is_refused_before_anything_is_checked(
    services: Day2Services, jane_user: User
) -> None:
    with pytest.raises(TeamReadOnlyError) as raised:
        await services.ocp_pins.add("orca", "metrics", PinSpec("4.16", ""), jane_user)
    assert raised.value.details["team"] == "orca"
    with pytest.raises(TeamReadOnlyError):
        await services.ocp_pins.remove("orca", "metrics", "4.16.27", jane_user)


async def test_a_fleet_defaults_revision_over_every_pin_is_warned(
    services: Day2Services, jane_user: User, by_hand: Commit
) -> None:
    # The footgun: a defaults config's targetRevision is layer 3, the pin layer 2.
    folder = "defaults/hosted-clusters/bmhgen"
    await by_hand(
        FileChange.create(RepoPath(f"{folder}/bmhgen.yaml"), "targetRevision: 1.0.0\n"),
        FileChange.create(RepoPath(f"{folder}/values.yaml"), "{}\n"),
    )
    plan = (
        await services.ocp_pins.add(
            "redbull", "bmhgen", PinSpec("4.20.9", "1.1.0"), jane_user, dry_run=True
        )
    ).plan
    (finding,) = [f for f in plan.findings if f.rule is Rule.FLEET_PIN_OVERRIDES_OCP_VERSIONS]
    assert finding.path == f"{folder}/bmhgen.yaml"
    assert "on every hosted cluster a pin's revision does nothing" in finding.message
    # The MCE at 4.20.9 gets it from its own folder: the pin's revision reaches it.
    changed = {i.ref.name: i.changes for i in plan.impact}
    assert [c.key for c in changed["ocp4-prep-mce-site1-a"]] == ["targetRevision"]
    assert "ocp4-prep-eyal-site1" not in changed


# ── change ──────────────────────────────────────────────────────────────────


async def test_a_pins_revision_is_edited_in_place_and_its_values_replaced(
    services: Day2Services, gitlab: InMemoryGitLab, jane_user: User, by_hand: Commit
) -> None:
    await pinned(by_hand)
    at = await read_at(services)
    write = partial(
        services.ocp_pins.change,
        "redbull",
        "cluster-roles",
        "4.20.9",
        PinChange(target_revision="2.0.0", values={"extra": 2}),
        jane_user,
        last_commit_id=at,
    )
    result = await confirmed(write)
    plan = result.plan
    assert plan.title == "[Wingman/Day2] Update addon redbull/cluster-roles OCP-version pin 4.20.9"
    assert [(c.kind, c.last_commit_id) for c in plan.changes] == [
        (ChangeKind.UPDATE, at),
        (ChangeKind.UPDATE, at),
    ]
    files = await files_of(gitlab, result)
    # The comment stays: only the key that changed is rewritten.
    assert files[f"{PINS}/4.20.9/cluster-roles.yaml"] == (
        "# 4.20.9 needs the RBAC fix of the hotfix branch\ntargetRevision: 2.0.0\n"
    )
    assert yaml.safe_load(files[f"{PINS}/4.20.9/values.yaml"]) == {"extra": 2}
    assert {(c.key, c.before, c.after) for i in plan.impact for c in i.changes} == {
        ("targetRevision", "2.1.5-hotfix", "2.0.0"),
        ("extra", 1, 2),
    }


async def test_emptied_values_delete_the_file_and_a_values_only_pin_keeps_its_shape(
    services: Day2Services, jane_user: User, by_hand: Commit
) -> None:
    await pinned(by_hand)
    plan = (
        await services.ocp_pins.change(
            "redbull",
            "cluster-roles",
            "4.20.9",
            PinChange(values={}),
            jane_user,
            last_commit_id=await read_at(services),
            dry_run=True,
        )
    ).plan
    assert [(c.kind, str(c.path)) for c in plan.changes] == [
        (ChangeKind.DELETE, f"{PINS}/4.20.9/values.yaml")
    ]
    # A layer holding values only, written by hand: a values change leaves it without a revision.
    await by_hand(
        FileChange.create(RepoPath(f"{PINS}/4.16.27/values.yaml"), "a: 1\n"),
    )
    plan = (
        await services.ocp_pins.change(
            "redbull",
            "cluster-roles",
            "4.16.27",
            PinChange(values={"a": 2}),
            jane_user,
            dry_run=True,
        )
    ).plan
    assert [str(c.path) for c in plan.changes] == [f"{PINS}/4.16.27/values.yaml"]
    with pytest.raises(ChangeRefusedError) as raised:
        await services.ocp_pins.change(
            "redbull", "cluster-roles", "4.16.27", PinChange(values={}), jane_user, dry_run=True
        )
    assert raised.value.details["rule"] == "pin-empty"


async def test_a_change_refuses_nothing_to_change_a_missing_pin_and_a_blank_revision(
    services: Day2Services, jane_user: User, by_hand: Commit
) -> None:
    change = partial(services.ocp_pins.change, "redbull", "cluster-roles", user=jane_user)
    with pytest.raises(ChartNotInstalledError) as raised:
        await change(version="4.20.9", change=PinChange(target_revision="2.0.0"))
    assert raised.value.details["rule"] == "pin-unknown"
    await pinned(by_hand)
    for edit, rule in [
        (PinChange(target_revision="2.1.5-hotfix", values={"extra": 1}), "no-change"),
        (PinChange(target_revision=" "), "pin-revision-missing"),
        (PinChange(target_revision="9.9.9"), "revision-unknown"),
    ]:
        with pytest.raises(ChangeRefusedError) as refused:
            await change(version="4.20.9", change=edit, dry_run=True)
        assert refused.value.details["rule"] == rule


async def test_a_stale_change_conflicts_instead_of_overwriting(
    services: Day2Services, jane_user: User, by_hand: Commit
) -> None:
    await pinned(by_hand)
    stale = await read_at(services)
    await by_hand(
        FileChange.update(
            RepoPath(f"{PINS}/4.20.9/cluster-roles.yaml"),
            "targetRevision: main\n",
            last_commit_id=None,
        ),
    )
    with pytest.raises(RevisionConflictError):
        await confirmed(
            partial(
                services.ocp_pins.change,
                "redbull",
                "cluster-roles",
                "4.20.9",
                PinChange(target_revision="2.0.0"),
                jane_user,
                last_commit_id=stale,
            )
        )


async def test_a_preview_the_repo_moved_away_from_is_refused(
    services: Day2Services, gitlab: InMemoryGitLab, jane_user: User, by_hand: Commit
) -> None:
    write = partial(
        services.ocp_pins.add, "redbull", "cluster-roles", PinSpec("4.20.9", "2.0.0"), jane_user
    )
    preview = (await write(dry_run=True)).plan
    # Someone moves the add-on itself to 2.0.0: the pin would now change nothing on eyal and itay.
    path = RepoPath("operators/cluster-roles/cluster-roles.yaml")
    text = (
        await gitlab.read_file((await gitlab.get_project("sigs/redbull")).id, path, ref="main")
    ).content
    await by_hand(
        FileChange.update(
            path, text.replace("targetRevision: main", "targetRevision: 2.0.0"), last_commit_id=None
        ),
    )
    with pytest.raises(PlanChangedError):
        await write(confirm_changes=preview.needs_confirmation, expected_digest=preview.digest)


# ── remove ──────────────────────────────────────────────────────────────────


async def test_a_removed_pin_takes_its_folder_and_its_destinations_back(
    services: Day2Services, gitlab: InMemoryGitLab, jane_user: User, by_hand: Commit
) -> None:
    await pinned(by_hand)
    at = await read_at(services)
    result = await confirmed(
        partial(
            services.ocp_pins.remove,
            "redbull",
            "cluster-roles",
            "4.20.9",
            jane_user,
            last_commit_id=at,
        )
    )
    plan = result.plan
    assert plan.title == (
        "[Wingman/Day2] Update addon redbull/cluster-roles OCP-version pin 4.20.9 (removed)"
    )
    assert [(c.kind, str(c.path), c.last_commit_id) for c in plan.changes] == [
        (ChangeKind.DELETE, f"{PINS}/4.20.9/cluster-roles.yaml", at),
        (ChangeKind.DELETE, f"{PINS}/4.20.9/values.yaml", at),
    ]
    assert plan.previous[f"{PINS}/4.20.9/cluster-roles.yaml"] == PIN_TEXT
    assert {(c.key, c.before, c.after) for i in plan.impact for c in i.changes} == {
        ("targetRevision", "2.1.5-hotfix", "main"),
        ("extra", 1, None),
    }
    assert any("go back to the add-on's revision (main)" in n for n in plan.notes)
    assert not any(p.startswith(f"{PINS}/") for p in await files_of(gitlab, result))


async def test_removing_a_pin_deleted_since_the_read_is_a_conflict(
    services: Day2Services, jane_user: User, by_hand: Commit
) -> None:
    await pinned(by_hand, values=None)
    at = await read_at(services)
    await by_hand(FileChange.delete(RepoPath(f"{PINS}/4.20.9/cluster-roles.yaml")))
    remove = partial(services.ocp_pins.remove, "redbull", "cluster-roles", "4.20.9", jane_user)
    with pytest.raises(RevisionConflictError):
        await remove(last_commit_id=at, dry_run=True)
    with pytest.raises(ChartNotInstalledError):
        await remove(dry_run=True)


# ── a new add-on's pins ─────────────────────────────────────────────────────


def podinfo(*pins: PinSpec) -> NewAddon:
    return NewAddon(
        team="redbull",
        chart="podinfo",
        repourl=f"{FAKE_GITLAB_URL}/redbull/helm-charts/example-chart.git",
        sync=PLATFORM_DEFAULT,
        project_namespace="podinfo",
        pins=pins,
    )


async def test_a_new_addons_pins_are_written_in_its_create_mr(
    services: Day2Services, gitlab: InMemoryGitLab, jane_user: User
) -> None:
    spec = podinfo(PinSpec("4.20.9", "0.1.0", {"a": 1}), PinSpec("4.16.27", "HEAD"))
    result = await services.authoring.create(spec, jane_user)
    plan = result.plan
    assert [(c.kind, str(c.path)) for c in plan.changes] == [
        (ChangeKind.CREATE, "operators/podinfo/podinfo.yaml"),
        (ChangeKind.CREATE, "operators/podinfo/values.yaml"),
        (ChangeKind.CREATE, "operators/podinfo/ocp-versions/4.16.27/podinfo.yaml"),
        (ChangeKind.CREATE, "operators/podinfo/ocp-versions/4.20.9/podinfo.yaml"),
        (ChangeKind.CREATE, "operators/podinfo/ocp-versions/4.20.9/values.yaml"),
    ]
    assert plan.title == "[Wingman/Day2] Create addon redbull/podinfo in the team catalog"
    pinned_note = "ocp-versions/ pins it per OCP version (4.16.27: HEAD, 4.20.9: 0.1.0)"
    assert any(pinned_note in n for n in plan.notes)
    files = await files_of(gitlab, result)
    assert files["operators/podinfo/ocp-versions/4.16.27/podinfo.yaml"] == "targetRevision: HEAD\n"
    assert yaml.safe_load(files["operators/podinfo/ocp-versions/4.20.9/values.yaml"]) == {"a": 1}


async def test_a_new_addons_pins_are_checked_before_anything_is_written(
    services: Day2Services, jane_user: User
) -> None:
    for pins, rule in [
        ((PinSpec("4.20.9", "0.1.0"), PinSpec("4.20.9", "HEAD")), "pin-duplicate"),
        ((PinSpec("4.20", "0.1.0"),), "ocp-version-invalid"),
        ((PinSpec("4.20.9", ""),), "pin-revision-missing"),
        ((PinSpec("4.20.9", "9.9.9"),), "revision-unknown"),
    ]:
        with pytest.raises(ChangeRefusedError) as raised:
            await services.authoring.create(podinfo(*pins), jane_user, dry_run=True)
        assert raised.value.details["rule"] == rule
