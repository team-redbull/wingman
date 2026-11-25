"""An import asks day2 for each opened cluster's missing add-ons (ADR-0037's 2026-11-25 amendment).

``agent-baseline`` lists ``redbull/cluster-roles``; day2 reports it
installed on ``herzi`` only, so ``lark``, ``heron`` and ``karniol`` lack it.
Day2 is the fake; the clock is one the test moves.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest

from wingman_core.domain.errors import RevisionConflictError
from wingman_core.domain.mr_conventions import Repo
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab
from wingman_day1.api.deps import Day1Context
from wingman_day1.application import addon_installs
from wingman_day1.application.addon_installs import AddonInstalls
from wingman_day1.application.approvals import RepoKey
from wingman_day1.application.imports import ImportPick, ImportResult, ImportService
from wingman_day1.domain.changes import ClusterChange, ProvisionResult
from wingman_day1.domain.paths import ClusterRef
from wingman_day1.infrastructure.fakes.day2 import FakeDay2Addons
from wingman_day1.infrastructure.merge_requests import GitClusterProvisioner, MergeRequestWriter
from wingman_day1.infrastructure.repositories import CachedRepository
from wingman_day1.ports import ClusterProvisioner

MCE = "ocp4-prod-mce-site1-a"
LARK = ClusterRef("site1", MCE, "ocp4-prod-lark-site1")
HERON = ClusterRef("site1", MCE, "ocp4-prod-heron-site1")
HERZI = ClusterRef("site1", MCE, "ocp4-prod-herzi-site1")
KARNIOL = ClusterRef("site1", MCE, "ocp4-prod-karniol-site1")


class Clock:
    """Stands still until a test moves it."""

    def __init__(self) -> None:
        self.now = datetime(2026, 11, 25, 9, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


class GitLab:
    """day1's provisioner, with GitLab refusing ``refused``'s file and taking ``takes`` a write."""

    def __init__(
        self, real: ClusterProvisioner, clock: Clock, refused: ClusterRef | None, takes: timedelta
    ) -> None:
        self.real = real
        self.clock = clock
        self.refused = refused
        self.takes = takes

    async def apply(self, change: ClusterChange) -> ProvisionResult:
        self.clock.now += self.takes
        if change.cluster == self.refused:
            raise RevisionConflictError(f"{change.cluster.path} changed since the commit")
        return await self.real.apply(change)


def service(
    context: Day1Context,
    gitlab: InMemoryGitLab,
    day2: FakeDay2Addons,
    clock: Clock,
    *,
    refused: ClusterRef | None = None,
    takes: timedelta = timedelta(0),
) -> ImportService:
    day1 = cast("CachedRepository", context.repos[RepoKey.DAY1])
    real = GitClusterProvisioner(
        MergeRequestWriter(gitlab, day1, repo=Repo.DAY1, label="day1", clock=clock)
    )
    return ImportService(
        context.clusters,
        context.specs,
        context.drift,
        context.machine_configs,
        GitLab(real, clock, refused, takes),
        day2,
        clock=clock,
    )


async def run(
    imports: ImportService, context: Day1Context, support: Any, *refs: ClusterRef
) -> ImportResult:
    picks = [ImportPick(r, (await context.clusters.get(r)).last_commit_id) for r in refs]
    return await imports.import_clusters(
        "agent-baseline", picks, spec_version="1.0.0", user=support.ALICE
    )


def addons(result: ImportResult) -> dict[str, AddonInstalls]:
    return {o.cluster.name: o.addons for o in result.opened}


async def test_each_opened_cluster_gets_its_day2_mr_linked_to_its_own_import_mr(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    result = await run(service(context, gitlab, day2, Clock()), context, support, LARK, HERZI)
    lark = next(o for o in result.opened if o.cluster == LARK)
    found = addons(result)
    assert [(r.team, r.charts) for r in found[LARK.name].opened] == [
        ("redbull", ("cluster-roles",))
    ]
    assert found[HERZI.name] == AddonInstalls()  # it has every add-on the flavor lists
    ((cluster, asked, message),) = day2.install_requests
    assert (cluster, [a.name for a in asked], day2.install_users) == (
        LARK,
        ["cluster-roles"],
        ["alice"],
    )
    mr = lark.merge_request
    assert f"!{mr.ref.iid} ({mr.web_url})" in message
    assert "Wingman asks day2 for its install MR right after opening this one" in mr.description


async def test_a_cluster_whose_import_mr_did_not_open_has_nothing_asked(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    imports = service(context, gitlab, day2, Clock(), refused=HERON)
    result = await run(imports, context, support, LARK, HERON)
    assert [f.cluster for f in result.failed] == [HERON]
    assert [ref.name for ref, _, _ in day2.install_requests] == [LARK.name]


async def test_once_day2_stops_answering_no_more_clusters_are_asked(
    context: Day1Context,
    support: Any,
    gitlab: InMemoryGitLab,
    day2: FakeDay2Addons,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(addon_installs, "MAX_ASK_CONCURRENCY", 1)  # one at a time: order known
    await context.drift.for_cluster(LARK)  # day2 listed what is installed
    day2.installs_down = True
    result = await run(service(context, gitlab, day2, Clock()), context, support, LARK, KARNIOL)
    found = addons(result)
    assert found[LARK.name].not_asked == (
        "day2 did not answer: day2 unreachable listing its open merge requests (fake)"
    )
    assert found[KARNIOL.name].not_asked == (
        "not asked: day2 did not answer for ocp4-prod-lark-site1, so no more were asked"
    )
    assert [a.name for a in found[KARNIOL.name].not_opened] == ["cluster-roles"]
    assert len(result.opened) == 2  # the import MRs stay open


async def test_day2_is_not_asked_once_the_import_has_run_its_budget(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    # GitLab took 31 s to open the import MR: day2 is not asked, so the request ends in time
    slow = service(context, gitlab, day2, Clock(), takes=timedelta(seconds=31))
    result = await run(slow, context, support, LARK)
    (lark,) = result.opened
    assert lark.addons.not_asked == "not asked: the import had run 30 s, so no more were asked"
    assert [a.name for a in lark.addons.not_opened] == ["cluster-roles"]
    assert day2.install_requests == []


async def test_a_team_day2_refuses_is_that_clusters_failed_line(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    day2.refuse = {"redbull": "redbull hasn't given Wingman write access to sigs/redbull"}
    result = await run(service(context, gitlab, day2, Clock()), context, support, LARK)
    (lark,) = result.opened
    assert lark.addons.failed == (
        "redbull: redbull hasn't given Wingman write access to sigs/redbull",
    )
    assert [a.name for a in lark.addons.not_opened] == ["cluster-roles"]


async def test_add_ons_day2_could_not_list_are_unknown_and_not_asked(
    context: Day1Context, support: Any, gitlab: InMemoryGitLab, day2: FakeDay2Addons
) -> None:
    day2.unavailable = True
    result = await run(service(context, gitlab, day2, Clock()), context, support, LARK)
    (lark,) = result.opened
    assert lark.addons.not_asked is not None
    assert lark.addons.not_asked.startswith("day2 did not answer")
    assert (lark.addons.missing, day2.install_requests) == ((), [])
