"""A sync opens its day1 MR, then the missing add-ons' day2 MRs (ADR-0037's 2026-11-25 amendment).

``lark`` is linked to ``agent-baseline`` v1.0.0, which lists
``redbull/cluster-roles`` (and, where a test says so, ``orca/metrics``);
day2 reports neither installed on it. Day2 is the fake: it answers, refuses
a team, does not confirm, or does not answer.
"""

from __future__ import annotations

from typing import Any, cast

import pytest

from wingman_core.domain.errors import AmbiguousWriteError
from wingman_core.domain.git import RepoPath
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab
from wingman_day1.api.deps import Day1Context
from wingman_day1.application.approvals import RepoKey
from wingman_day1.application.sync import SyncResult, SyncService
from wingman_day1.domain.addons import RequestedAddon
from wingman_day1.domain.changes import ClusterChange, ProvisionResult
from wingman_day1.domain.errors import StaleError
from wingman_day1.domain.paths import ClusterRef
from wingman_day1.infrastructure.fakes.day2 import FakeDay2Addons
from wingman_day1.ports import ClusterProvisioner, RolloutMergeRequests

MCE = "ocp4-prod-mce-site1-a"
LARK = ClusterRef("site1", MCE, "ocp4-prod-lark-site1")
LARK_REMOVALS = [(0, "worker-kubeletconfig-reserved"), (1, "restored-example-config")]
SPEC_FILE = "specs/agent-baseline.yaml"
METRICS = (
    "      - team: orca\n        name: metrics\n        version: main\n        overrideable: []\n"
)


async def link(context: Day1Context, support: Any, gitlab: InMemoryGitLab) -> None:
    """Lark's file on main with the flavor's header, as a merged import leaves it."""
    pid = await support.project_id(gitlab, support.DAY1)
    before = (await gitlab.read_file(pid, LARK.path, "main")).content
    header = '# specName: "agent-baseline"\n# specVersion: "1.0.0"\n'
    await support.push(
        gitlab, support.DAY1, branch="main", file=str(LARK.path), content=header + before
    )
    context.repos[RepoKey.DAY1].forget_files()


async def also_lists_orca(context: Day1Context, support: Any, gitlab: InMemoryGitLab) -> None:
    """The flavor lists a second team's add-on too (still v1.0.0, before anything reads it)."""
    pid = await support.project_id(gitlab, support.SPECS)
    current = (await gitlab.read_file(pid, RepoPath(SPEC_FILE), "main")).content
    await support.push(
        gitlab, support.SPECS, branch="main", file=SPEC_FILE, content=current + METRICS
    )
    context.repos[RepoKey.SPECS].forget_files()


async def sync(service: SyncService, support: Any) -> SyncResult:
    plan = await service.preview(LARK, hardware={})
    return await service.sync(
        LARK,
        last_commit_id=plan.cluster.last_commit_id,
        spec_version="1.0.0",
        hardware={},
        confirm_removals=LARK_REMOVALS,
        user=support.ALICE,
    )


async def day1_mrs(gitlab: InMemoryGitLab, support: Any) -> list[Any]:
    pid = await support.project_id(gitlab, support.DAY1)
    return await gitlab.list_merge_requests(pid, state=None)


async def test_the_sync_opens_its_mr_then_one_day2_mr_per_team_in_the_admins_name(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    await also_lists_orca(context, support, gitlab)
    result = await sync(context.sync, support)
    mr = result.provision.merge_request
    assert [(r.team, r.charts) for r in result.addons.opened] == [
        ("redbull", ("cluster-roles",)),
        ("orca", ("metrics",)),
    ]
    assert (result.addons.failed, result.addons.not_asked, result.addons.not_opened) == (
        (),
        None,
        (),
    )
    # Asked once per sync, as alice, after the day1 MR opened: each day2 MR links it
    assert day2.install_users == ["alice"]
    ((cluster, asked, message),) = day2.install_requests
    assert cluster == LARK
    assert [(a.team, a.name) for a in asked] == [("redbull", "cluster-roles"), ("orca", "metrics")]
    assert f"!{mr.ref.iid} ({mr.web_url})" in message
    assert "Wingman asks day2 for their install MRs, one per team" in mr.description


async def test_the_values_requested_at_create_travel_with_the_ask(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    pid = await support.project_id(gitlab, support.DAY1)
    before = (await gitlab.read_file(pid, LARK.path, "main")).content
    header = (
        '# specName: "agent-baseline"\n# specVersion: "1.0.0"\n'
        '# wingmanAddons: [{"team": "redbull", "name": "cluster-roles", "version": "main", '
        '"override_values": {"replicas": 2}}]\n'
    )
    await support.push(
        gitlab, support.DAY1, branch="main", file=str(LARK.path), content=header + before
    )
    context.repos[RepoKey.DAY1].forget_files()
    await sync(context.sync, support)
    ((_, asked, _),) = day2.install_requests
    assert asked == (RequestedAddon("redbull", "cluster-roles", "main", {"replicas": 2}),)


async def test_a_team_day2_refuses_is_said_in_its_words_and_the_day1_mr_stays(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    await also_lists_orca(context, support, gitlab)
    day2.refuse = {"orca": "orca hasn't given Wingman write access to sigs/orca"}
    result = await sync(context.sync, support)
    assert [r.team for r in result.addons.opened] == ["redbull"]
    assert result.addons.failed == ("orca: orca hasn't given Wingman write access to sigs/orca",)
    assert [a.name for a in result.addons.not_opened] == ["metrics"]
    assert [m.ref for m in await day1_mrs(gitlab, support)] == [result.provision.merge_request.ref]


async def test_an_install_day2_did_not_confirm_is_reported_and_not_resent(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    day2.unconfirmed = True
    result = await sync(context.sync, support)
    (line,) = result.addons.failed
    assert "may have opened" in line
    assert len(day2.install_requests) == 1


async def test_day2_not_answering_leaves_the_day1_mr_open_and_says_what_it_answered(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    await context.sync.preview(LARK, hardware={})  # day2 listed what is installed
    day2.installs_down = True
    result = await sync(context.sync, support)
    assert result.addons.not_asked == (
        "day2 did not answer: day2 unreachable listing its open merge requests (fake)"
    )
    assert [a.name for a in result.addons.not_opened] == ["cluster-roles"]
    assert day2.install_requests == []
    assert len(await day1_mrs(gitlab, support)) == 1


async def test_unknown_missing_add_ons_are_not_asked_for(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    day2.unavailable = True
    result = await sync(context.sync, support)
    assert result.plan.addons_error is not None
    assert result.addons.not_asked == result.plan.addons_error
    assert (result.addons.missing, day2.install_requests) == ((), [])


async def test_an_install_mr_already_open_is_listed_not_asked_again(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    earlier = await day2.install(
        LARK, [RequestedAddon("redbull", "cluster-roles", "main")], message="m", as_user=support.BOB
    )
    result = await sync(context.sync, support)
    assert result.addons.already_open == earlier.opened
    assert (result.addons.opened, result.addons.not_opened) == ((), ())
    assert day2.install_users == ["bob"]  # only the earlier one


class _TimesOut:
    """A provisioner whose write GitLab does not confirm."""

    async def apply(self, change: ClusterChange) -> ProvisionResult:
        raise AmbiguousWriteError("POST /projects/1/repository/commits timed out after it was sent")


async def test_nothing_opens_in_day2_when_the_day1_mr_did_not(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    service = SyncService(
        context.clusters,
        context.specs,
        context.drift,
        context.machine_configs,
        cast("ClusterProvisioner", _TimesOut()),
        context.repos[RepoKey.DAY1],
        cast("RolloutMergeRequests", None),
        day2=day2,
    )
    with pytest.raises(AmbiguousWriteError):
        await sync(service, support)
    assert day2.install_requests == []


async def test_a_stale_sync_opens_nothing_anywhere(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    await link(context, support, gitlab)
    plan = await context.sync.preview(LARK, hardware={})
    await support.push(
        gitlab,
        support.DAY1,
        branch="main",
        file=str(LARK.path),
        content=plan.cluster.content + "#\n",
    )
    context.repos[RepoKey.DAY1].forget_files()
    with pytest.raises(StaleError):
        await context.sync.sync(
            LARK,
            last_commit_id=plan.cluster.last_commit_id,
            spec_version="1.0.0",
            hardware={},
            confirm_removals=LARK_REMOVALS,
            user=support.ALICE,
        )
    assert (await day1_mrs(gitlab, support), day2.install_requests) == ([], [])
