"""A cluster's missing add-ons asked of day2 (ADR-0044; ADR-0037's 2026-11-25 amendment).

``install_missing`` against the day2 fake: day2 answers ok, in part, not at
all, or without confirming; an install MR already open is not asked again.
"""

from __future__ import annotations

from wingman_core.domain.users import Role, User
from wingman_day1.application.addon_installs import NO_INSTALLS, AddonInstalls, install_missing
from wingman_day1.domain.addons import AddonDrift, AddonDriftReason, RequestedAddon
from wingman_day1.domain.paths import ClusterRef
from wingman_day1.infrastructure.fakes.day2 import FakeDay2Addons

CLUSTER = ClusterRef("site1", "ocp4-prod-mce-site1-a", "ocp4-prod-lark-site1")
ALICE = User(username="alice", role=Role.ADMIN)
ROLES = AddonDrift("redbull", "cluster-roles", AddonDriftReason.MISSING, "main", {"replicas": 2})
BMH = AddonDrift("redbull", "bmhgen", AddonDriftReason.MISSING, "1.2.0")
METRICS = AddonDrift("orca", "metrics", AddonDriftReason.MISSING, "")
MESSAGE = "Day1 MR !61 syncs ocp4-prod-lark-site1; merge this with it"


async def ask(day2: FakeDay2Addons | None, *missing: AddonDrift) -> AddonInstalls:
    return await install_missing(day2, CLUSTER, missing, as_user=ALICE, message=MESSAGE)


async def test_nothing_missing_asks_nothing() -> None:
    day2 = FakeDay2Addons()
    assert await ask(day2) == AddonInstalls()
    assert day2.install_requests == []


async def test_one_mr_per_team_in_the_session_of_whoever_asked() -> None:
    day2 = FakeDay2Addons()
    found = await ask(day2, ROLES, BMH, METRICS)
    assert [(r.team, r.charts) for r in found.opened] == [
        ("redbull", ("cluster-roles", "bmhgen")),
        ("orca", ("metrics",)),
    ]
    assert (found.failed, found.not_asked, found.not_opened) == ((), None, ())
    # The values requested at create travel with the ask, and the MRs name alice
    ((_, asked, message),) = day2.install_requests
    assert asked[0] == RequestedAddon("redbull", "cluster-roles", "main", {"replicas": 2})
    assert (message, day2.install_users) == (MESSAGE, ["alice"])


async def test_an_install_mr_already_open_is_listed_and_not_asked_again() -> None:
    day2 = FakeDay2Addons()
    first = await ask(day2, ROLES)
    again = await ask(day2, ROLES, METRICS)
    assert again.already_open == first.opened
    assert [r.team for r in again.opened] == ["orca"]
    assert [[a.name for a in addons] for _, addons, _ in day2.install_requests] == [
        ["cluster-roles"],
        ["metrics"],
    ]
    assert again.not_opened == ()


async def test_a_team_day2_refuses_is_its_own_line_and_left_to_install_by_hand() -> None:
    day2 = FakeDay2Addons(refuse={"orca": "orca hasn't given Wingman write access to sigs/orca"})
    found = await ask(day2, ROLES, METRICS)
    assert [r.team for r in found.opened] == ["redbull"]
    assert found.failed == ("orca: orca hasn't given Wingman write access to sigs/orca",)
    assert found.not_opened == (METRICS,)


async def test_an_unconfirmed_install_says_it_may_have_opened_and_is_not_resent() -> None:
    day2 = FakeDay2Addons(unconfirmed=True)
    found = await ask(day2, ROLES)
    assert found.opened == ()
    (line,) = found.failed
    assert "may have opened" in line
    assert len(day2.install_requests) == 1


async def test_day2_unreachable_asks_nothing_and_says_so() -> None:
    day2 = FakeDay2Addons()
    day2.installs_down = True
    found = await ask(day2, ROLES)
    assert found.not_asked == (
        "day2 did not answer: day2 unreachable listing its open merge requests (fake)"
    )
    assert (found.opened, found.missing, found.not_opened) == ((), (ROLES,), (ROLES,))
    assert day2.install_requests == []


async def test_without_an_install_client_day2_is_not_asked() -> None:
    assert await ask(None, ROLES) == AddonInstalls((ROLES,), not_asked=NO_INSTALLS)
