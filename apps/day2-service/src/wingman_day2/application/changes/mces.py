"""Deploy on specific MCEs: an install on each chosen MCE hub, one MR per MCE (ADR-0053)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from wingman_core.domain.errors import GitError
from wingman_core.domain.git import FileChange
from wingman_day2.application.changes.plan import ChangeResult
from wingman_day2.domain.clusters import ClusterRef
from wingman_day2.domain.errors import Day2Error
from wingman_day2.domain.findings import Finding

MAX_INSTALL_CONCURRENCY: Final = 4
"""How many of a deploy-on-MCEs' merge requests are opened at once."""


@dataclass(frozen=True, slots=True)
class MceInstall:
    """One chosen MCE of a deploy on specific MCEs: its plan, its MR, or why not."""

    cluster: ClusterRef
    changes: tuple[FileChange, ...] = ()
    notes: tuple[str, ...] = ()
    findings: tuple[Finding, ...] = ()
    refused: Day2Error | None = None
    result: ChangeResult | None = None
    failed: GitError | None = None

    @property
    def status(self) -> str:
        """``refused``, ``failed``, ``opened`` or (a dry run) ``planned``."""
        if self.refused is not None:
            return "refused"
        if self.failed is not None:
            return "failed"
        return "opened" if self.result is not None else "planned"


@dataclass(frozen=True, slots=True)
class MceInstalls:
    """A deploy on specific MCEs: one entry per chosen MCE, in the order asked."""

    team: str
    chart: str
    installs: tuple[MceInstall, ...]
