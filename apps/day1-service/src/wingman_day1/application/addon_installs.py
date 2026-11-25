"""A cluster's missing add-ons, asked of day2 for the flavor that lists them.

Day1 never writes a day2 repo (ADR-0016): it asks day2's own API, which opens
one install MR per team as for any request (``Day2Installs``), in a session of
the user day1 asks for. A flavor's rollout asks before it opens each
cluster's MR, so the MR can link them (ADR-0044).

Install MRs already open on the cluster for an add-on are not asked again.
Day2's answer is kept as it came: each MR it opened, each team it refused or
did not confirm (``failed``, in its words), or why it was not asked at all
(``not_asked``). Nothing is retried (ADR-0006): an install day2 may have
acted on says so, and the next ask reads the open installs first.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final

from wingman_core.domain.users import User
from wingman_day1.domain.addons import AddonDrift, Day2InstallRequest, RequestedAddon
from wingman_day1.domain.errors import Day2UnavailableError
from wingman_day1.domain.paths import ClusterRef
from wingman_day1.ports import Day2Installs

NO_INSTALLS: Final = "day1 has no client for day2's installs here, so day2 was not asked"


@dataclass(frozen=True, slots=True)
class AddonInstalls:
    """What day2 answered for one cluster's missing add-ons."""

    missing: tuple[AddonDrift, ...] = ()
    """What the flavor lists and day2 does not report installed (with the values asked for)."""
    opened: tuple[Day2InstallRequest, ...] = ()
    """The install MRs day2 opened now, one per team."""
    already_open: tuple[Day2InstallRequest, ...] = ()
    """Install MRs already open on the cluster for some of them: not asked again."""
    failed: tuple[str, ...] = ()
    """One line per team whose MR did not open (or may have, unconfirmed), in day2's words."""
    not_asked: str | None = None
    """Why day2 was not asked at all, or why what is missing is unknown; nothing opened."""

    @property
    def not_opened(self) -> tuple[AddonDrift, ...]:
        """The missing add-ons no install MR covers: what a person installs by hand."""
        covered = {(r.team, c) for r in (*self.opened, *self.already_open) for c in r.charts}
        return tuple(a for a in self.missing if (a.team, a.name) not in covered)


async def install_missing(
    day2: Day2Installs | None,
    cluster: ClusterRef,
    missing: Sequence[AddonDrift],
    *,
    as_user: User,
    message: str,
) -> AddonInstalls:
    """Ask day2 for the install MRs of ``missing`` on ``cluster`` that are not open already.

    Day2's MRs name ``as_user`` as their requester, and their descriptions
    carry ``message``.
    """
    missing = tuple(missing)
    if not missing:
        return AddonInstalls()
    if day2 is None:
        return AddonInstalls(missing, not_asked=NO_INSTALLS)
    wanted = {(a.team, a.name) for a in missing}
    try:
        pending = await day2.open_installs(cluster, as_user=as_user)
        have = {(r.team, chart) for r in pending for chart in r.charts}
        asked = [
            RequestedAddon(a.team, a.name, a.expected_version, a.override_values)
            for a in missing
            if (a.team, a.name) not in have
        ]
        result = (
            await day2.install(cluster, asked, message=message, as_user=as_user) if asked else None
        )
    except Day2UnavailableError as exc:
        return AddonInstalls(missing, not_asked=f"day2 did not answer: {exc}")
    return AddonInstalls(
        missing,
        opened=result.opened if result else (),
        already_open=tuple(r for r in pending if any((r.team, c) in wanted for c in r.charts)),
        failed=result.failed if result else (),
    )
