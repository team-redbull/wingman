"""Day2's answer for a cluster's missing add-ons, asked with a sync or an import (ADR-0037)."""

from __future__ import annotations

from pydantic import BaseModel

from wingman_day1.api.v1.schemas import AddonDriftOut
from wingman_day1.application.addon_installs import AddonInstalls
from wingman_day1.domain.addons import Day2InstallRequest


class Day2InstallOut(BaseModel):
    """One team's day2 install MR on the cluster; review it at ``/approvals/day2-<team>-<iid>``."""

    team: str
    iid: int
    title: str
    web_url: str
    charts: list[str]
    """The charts it installs."""

    @classmethod
    def of(cls, request: Day2InstallRequest) -> Day2InstallOut:
        """From a day2 install MR."""
        return cls(
            team=request.team,
            iid=request.iid,
            title=request.title,
            web_url=request.web_url,
            charts=list(request.charts),
        )


class AddonInstallsOut(BaseModel):
    """The flavor's add-ons the cluster lacks, and what day2 answered when asked to install them.

    Day1 asks only after its own MR opened, never twice for an install MR
    already open, and never again on its own (ADR-0006): whatever is in
    ``failed`` or ``not_opened`` is for a person to install from the
    cluster's Add-ons tab.
    """

    missing: list[AddonDriftOut]
    """What the flavor lists and day2 does not report installed, with the values asked for."""
    opened: list[Day2InstallOut]
    """The install MRs day2 opened now, one per team."""
    already_open: list[Day2InstallOut]
    """Install MRs already open on the cluster for some of them: not asked again."""
    failed: list[str]
    """One line per team whose MR did not open, in day2's words; one that says it may have
    opened was not confirmed (check day2's approvals before installing it again)."""
    not_asked: str | None
    """Why day2 was not asked at all (it did not answer, the import ran long), or why what is
    missing is unknown; nothing was opened."""
    not_opened: list[AddonDriftOut]
    """The missing add-ons no install MR covers: what a person installs by hand."""

    @classmethod
    def of(cls, installs: AddonInstalls) -> AddonInstallsOut:
        """From what day2 answered."""
        return cls(
            missing=[AddonDriftOut.of(a) for a in installs.missing],
            opened=[Day2InstallOut.of(r) for r in installs.opened],
            already_open=[Day2InstallOut.of(r) for r in installs.already_open],
            failed=list(installs.failed),
            not_asked=installs.not_asked,
            not_opened=[AddonDriftOut.of(a) for a in installs.not_opened],
        )
