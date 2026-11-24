"""Deploy on specific MCEs: an install on each chosen MCE hub, one MR per MCE (ADR-0053).

Each MCE is planned and checked on its own (an MCE default of the chart is
refused, the XOR rule; so is one with the chart in its folder already, or one
the platform renders nothing for). The rest are opened a few at a time; a
write that fails fails that MCE only, and once GitLab does not answer, no more
are started. Nothing is retried.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from typing import Final

from wingman_core.domain.errors import AmbiguousWriteError, GitError, GitUnavailableError
from wingman_core.domain.git import FileChange
from wingman_core.domain.users import User
from wingman_day2.application.changes.install import InstallSpec, plan_install
from wingman_day2.application.changes.plan import (
    ChangePlan,
    ChangeResult,
    require_writable,
    sync_note,
    validate,
)
from wingman_day2.application.topology import TeamState, Topology
from wingman_day2.domain.clusters import ClusterKind, ClusterRef
from wingman_day2.domain.errors import ChangeRefusedError, Day2Error
from wingman_day2.domain.findings import Finding
from wingman_day2.ports import SigsRepository

logger = logging.getLogger(__package__)
"""The area's logger, ``wingman_day2.application.changes``, whichever module of it logs."""

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


type Planned = tuple[MceInstall, ChangePlan | None]
"""One MCE's install, and its plan unless it was refused."""


def mce_ref(key: str) -> ClusterRef:
    """The MCE ``key`` names, or the refusal of the whole request."""
    try:
        ref = ClusterRef.parse(key)
    except Day2Error as exc:
        raise ChangeRefusedError(
            f"{key!r} is not an MCE id (mce:<site>:<env>:<mce>)",
            details={"rule": "not-an-mce", "cluster": key},
        ) from exc
    if ref.kind is not ClusterKind.MCE:
        raise ChangeRefusedError(
            f"{key} is not an MCE: deploy on specific MCEs installs on MCE hubs only",
            details={"rule": "not-an-mce", "cluster": key},
        )
    return ref


async def plan_on_mce(
    sigs: SigsRepository, topology: Topology, state: TeamState, ref: ClusterRef, spec: InstallSpec
) -> Planned:
    """``spec`` planned and checked on the MCE ``ref``; refused for that MCE only."""
    try:
        summary = topology.cluster(ref)
        require_writable(topology, summary)
        plan = ChangePlan(state, summary)
        await plan_install(sigs, plan, spec)
        validate(topology, plan)
    except Day2Error as exc:
        return MceInstall(ref, refused=exc), None
    notes = (*plan.notes, *(sync_note(leaf) for leaf in plan.leaves))
    return MceInstall(ref, tuple(plan.changes), notes, tuple(plan.findings)), plan


async def open_each(
    planned: Sequence[Planned],
    open_plan: Callable[[ChangePlan], Awaitable[ChangeResult]],
    *,
    user: User,
    team: str,
    chart: str,
) -> tuple[MceInstall, ...]:
    """Open each planned MR, a few at a time; once GitLab does not answer, start no more."""
    limit = asyncio.Semaphore(MAX_INSTALL_CONCURRENCY)
    unanswered: list[str] = []

    async def one(install: MceInstall, plan: ChangePlan | None) -> MceInstall:
        if plan is None:
            return install
        async with limit:
            if unanswered:
                return replace(
                    install,
                    failed=GitUnavailableError(
                        f"not sent: GitLab did not answer for {unanswered[0]}, so no more "
                        "merge requests were started; deploy on this MCE again"
                    ),
                )
            try:
                result = await open_plan(plan)
            except GitError as exc:
                if isinstance(exc, GitUnavailableError | AmbiguousWriteError):
                    unanswered.append(install.cluster.name)
                logger.warning(
                    "install merge request not opened: user=%s team=%s chart=%s cluster=%s "
                    "error=%s",
                    user.username,
                    team,
                    chart,
                    install.cluster.id,
                    type(exc).__name__,
                    extra={"event": "mce_install_not_opened"},
                )
                return replace(install, failed=exc)
        return replace(install, result=result)

    return tuple(await asyncio.gather(*(one(i, p) for i, p in planned)))
