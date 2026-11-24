"""``ChangeService``: install, update and remove a cluster's charts, one MR each (ADR-0022)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence

from wingman_core.domain.errors import AmbiguousWriteError, GitError, GitUnavailableError
from wingman_core.domain.git import FileChange
from wingman_core.domain.mr_conventions import Verb
from wingman_core.domain.users import User
from wingman_core.ports.clock import Clock
from wingman_core.ports.gitlab import GitLabPort
from wingman_day2.application.access import AccessService
from wingman_day2.application.apps import load_deploy
from wingman_day2.application.changes.install import BulkResult, InstallSpec, plan_install
from wingman_day2.application.changes.mces import MAX_INSTALL_CONCURRENCY, MceInstall, MceInstalls
from wingman_day2.application.changes.opening import open_change
from wingman_day2.application.changes.plan import (
    ChangePlan,
    ChangeResult,
    check_chart_name,
    installed_app,
    require_writable,
    sync_note,
    validate,
)
from wingman_day2.application.changes.update import plan_pin, plan_values
from wingman_day2.application.topology import TopologyService
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ClusterKind, ClusterRef
from wingman_day2.domain.errors import (
    ChangeRefusedError,
    Day2Error,
    UnknownChartError,
    UnknownTeamError,
)
from wingman_day2.domain.platform import AppSource
from wingman_day2.ports import SigsRepository

logger = logging.getLogger(__package__)
"""The area's logger, ``wingman_day2.application.changes``, whichever module of it logs."""


class ChangeService:
    """Open the MRs that install, update and remove charts."""

    def __init__(
        self,
        gitlab: GitLabPort,
        topology: TopologyService,
        sigs: SigsRepository,
        access: AccessService,
        clock: Clock,
    ) -> None:
        """Write through ``gitlab``; read through ``topology`` and ``sigs``; check ``access``."""
        self._gitlab = gitlab
        self._topology = topology
        self._sigs = sigs
        self._access = access
        self._clock = clock

    # ── install ─────────────────────────────────────────────────────────────

    async def install(
        self,
        key: str,
        spec: InstallSpec,
        user: User,
        *,
        mce: str | None = None,
        message: str | None = None,
    ) -> ChangeResult:
        """Open an MR installing ``spec`` on cluster ``key``."""
        topology = await self._topology.load()
        summary = topology.resolve(key, mce=mce)
        state = topology.team(spec.team)
        await self._access.require_write(state.team)
        require_writable(topology, summary)
        plan = ChangePlan(state, summary)
        await plan_install(self._sigs, plan, spec)
        validate(topology, plan)
        return await self._open(plan, user, Verb.INSTALL, message)

    async def bulk_install(
        self,
        key: str,
        specs: Sequence[InstallSpec],
        user: User,
        *,
        mce: str | None = None,
        message: str | None = None,
    ) -> BulkResult:
        """Install several charts on one cluster: one MR per team, all validated first."""
        topology = await self._topology.load()
        summary = topology.resolve(key, mce=mce)
        for team in dict.fromkeys(spec.team for spec in specs):
            try:
                state = topology.team(team)
            except UnknownTeamError:
                continue  # listed with the other problems below
            await self._access.require_write(state.team)
        require_writable(topology, summary)
        plans: dict[str, ChangePlan] = {}
        problems: list[dict[str, object]] = []
        for spec in specs:
            plan = plans.get(spec.team)
            try:
                if plan is None:
                    plan = plans[spec.team] = ChangePlan(topology.team(spec.team), summary)
                await plan_install(self._sigs, plan, spec)
            except Day2Error as exc:
                problems.append(
                    {"team": spec.team, "chart": spec.chart, "detail": exc.detail, **exc.details}
                )
        for plan in plans.values():
            try:
                validate(topology, plan)
            except ChangeRefusedError as exc:
                problems.append({"team": plan.state.team.name, "detail": exc.detail, **exc.details})
        if problems:
            raise ChangeRefusedError(
                f"{len(problems)} of the requested charts cannot be installed; nothing was opened",
                details={"rule": "bulk", "problems": problems},
            )
        results: list[ChangeResult] = []
        failed: list[tuple[str, GitError]] = []
        for plan in plans.values():
            try:
                results.append(await self._open(plan, user, Verb.INSTALL, message))
            except GitError as exc:
                failed.append((plan.state.team.name, exc))
        if failed and not results:
            raise failed[0][1]
        return BulkResult(tuple(results), tuple(failed))

    async def install_on_mces(  # noqa: C901 - baseline: plan, check and open per MCE
        self,
        team: str,
        chart: str,
        clusters: Sequence[str],
        user: User,
        *,
        values: Mapping[str, object] | None = None,
        dry_run: bool = False,
        message: str | None = None,
    ) -> MceInstalls:
        """Install ``chart`` in each chosen MCE hub's own folder: one MR per MCE.

        Each MCE is planned and checked on its own (an MCE default of the chart
        is refused, the XOR rule; so is one with the chart in its folder
        already, or one the platform renders nothing for). The rest are opened
        a few at a time; a write that fails fails that MCE only, and once
        GitLab does not answer, no more are started. Nothing is retried.
        """
        topology = await self._topology.load()
        state = topology.team(team)
        await self._access.require_write(state.team)
        chart = check_chart_name(chart)
        if not state.repo.tree.is_dir(layout.operators_dir(chart)):
            raise UnknownChartError(
                f"team {team} has no operators/{chart}/ to install",
                details={"team": team, "chart": chart},
            )
        keys = list(dict.fromkeys(clusters))
        if not keys:
            raise ChangeRefusedError("choose at least one MCE", details={"rule": "no-mce"})
        planned: list[tuple[MceInstall, ChangePlan | None]] = []
        for key in keys:
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
            try:
                summary = topology.cluster(ref)
                require_writable(topology, summary)
                plan = ChangePlan(state, summary)
                await plan_install(
                    self._sigs, plan, InstallSpec(team, chart, values=dict(values or {}))
                )
                validate(topology, plan)
            except Day2Error as exc:
                planned.append((MceInstall(ref, refused=exc), None))
                continue
            notes = (*plan.notes, *(sync_note(leaf) for leaf in plan.leaves))
            install = MceInstall(ref, tuple(plan.changes), notes, tuple(plan.findings))
            planned.append((install, plan))
        if dry_run:
            return MceInstalls(team, chart, tuple(i for i, _ in planned))
        limit = asyncio.Semaphore(MAX_INSTALL_CONCURRENCY)
        unanswered: list[str] = []

        async def one(install: MceInstall, plan: ChangePlan | None) -> MceInstall:
            if plan is None:
                return install
            async with limit:
                if unanswered:
                    return MceInstall(
                        install.cluster,
                        install.changes,
                        install.notes,
                        install.findings,
                        failed=GitUnavailableError(
                            f"not sent: GitLab did not answer for {unanswered[0]}, so no more "
                            "merge requests were started; deploy on this MCE again"
                        ),
                    )
                try:
                    result = await self._open(plan, user, Verb.INSTALL, message)
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
                    return MceInstall(
                        install.cluster,
                        install.changes,
                        install.notes,
                        install.findings,
                        failed=exc,
                    )
            return MceInstall(
                install.cluster, install.changes, install.notes, install.findings, result=result
            )

        done = await asyncio.gather(*(one(i, p) for i, p in planned))
        return MceInstalls(team, chart, tuple(done))

    # ── update ──────────────────────────────────────────────────────────────

    async def update(
        self,
        key: str,
        team: str,
        chart: str,
        values: Mapping[str, object],
        user: User,
        *,
        version: str | None = None,
        emergency_pin: bool = False,
        last_commit_id: str | None = None,
        mce: str | None = None,
        message: str | None = None,
    ) -> ChangeResult:
        """Open an MR changing the chart's values on the cluster (and its pin, when asked).

        ``last_commit_id`` is the commit the caller read the values file at;
        if the file changed since, the commit is refused (409) instead of
        overwriting the other change (ADR-0006).
        """
        topology = await self._topology.load()
        summary = topology.resolve(key, mce=mce)
        state = topology.team(team)
        await self._access.require_write(state.team)
        app = installed_app(state, summary, chart)
        plan = ChangePlan(state, summary, charts=[chart])
        await plan_values(self._sigs, plan, app, values, last_commit_id)
        deploy = await load_deploy(self._sigs, state.team, state.repo.tree, app)
        if version is not None:
            plan_pin(plan, app, deploy.layers, version, emergency_pin=emergency_pin)
        if not plan.changes:
            raise ChangeRefusedError(
                f"nothing to change: {chart} on {summary.ref.name} already has these values",
                details={"rule": "no-change"},
            )
        plan.leaves.append(deploy.leaf)
        validate(topology, plan)
        return await self._open(plan, user, Verb.UPDATE, message)

    # ── remove ──────────────────────────────────────────────────────────────

    async def remove(
        self,
        key: str,
        team: str,
        chart: str,
        user: User,
        *,
        last_commit_id: str | None = None,
        mce: str | None = None,
        message: str | None = None,
    ) -> ChangeResult:
        """Open an MR deleting the chart's folder from the cluster (the workload is orphaned)."""
        topology = await self._topology.load()
        summary = topology.resolve(key, mce=mce)
        state = topology.team(team)
        await self._access.require_write(state.team)
        app = installed_app(state, summary, chart)
        if app.source is AppSource.FLEET_DEFAULT:
            scope = app.ref.defaults_scope
            raise ChangeRefusedError(
                f"{chart} reaches {summary.ref.name} as a fleet default of {team} ({app.folder}/): "
                f"it is on every destination of {scope}, and is not removed from one. Its values "
                "for this cluster are set here, or on the add-on's page on Addons "
                f"({team}/{chart}). An add-on wanted on some MCEs only is not a default: it is "
                "deployed on those MCEs (ADR-0053).",
                details={
                    "rule": "fleet-default-remove",
                    "path": str(app.folder),
                    "addon": f"/addons/{team}/{chart}",
                    # 3.12.0's key; that page now redirects to the add-on's.
                    "operator": f"/teams/{team}/operators/{chart}",
                },
            )
        deploy = await load_deploy(self._sigs, state.team, state.repo.tree, app)
        plan = ChangePlan(state, summary, charts=[chart], leaves=[deploy.leaf])
        values_path = app.folder.child(layout.VALUES_FILE)
        for path in state.repo.tree.files_under(app.folder):
            file = await self._sigs.read(state.team, path)
            guard = last_commit_id if (last_commit_id and path == values_path) else None
            plan.changes.append(
                FileChange.delete(
                    path, last_commit_id=guard or (file.last_commit_id if file else None)
                )
            )
        registration = layout.registration_dir(summary.ref)
        if registration is not None and not plan.tree.is_dir(registration):
            keep = registration.child(layout.GITKEEP)
            plan.changes.append(FileChange.create(keep, ""))
            plan.notes.append(
                f"{chart} was the last chart folder of {summary.ref.name} in {team}: {keep} keeps "
                f"the cluster registered, so {team}'s fleet defaults on it stay managed."
            )
        plan.notes.append(
            f"Deleting {app.folder}/ deletes the ArgoCD Application {deploy.leaf.name}, but ArgoCD "
            f"orphans the workload: {chart} keeps running on {summary.ref.name}. A full teardown "
            f"needs `argocd app delete {deploy.leaf.name} --cascade` on {deploy.leaf.argo}'s "
            "ArgoCD after the merge (runbook R8). Wingman has no ArgoCD access yet."
        )
        validate(topology, plan)
        return await self._open(plan, user, Verb.REMOVE, message, sync_notes=False)

    # ── shared ──────────────────────────────────────────────────────────────

    async def _open(
        self,
        plan: ChangePlan,
        user: User,
        verb: Verb,
        message: str | None,
        *,
        sync_notes: bool = True,
    ) -> ChangeResult:
        return await open_change(
            self._gitlab,
            self._sigs,
            self._clock,
            plan,
            user,
            verb,
            message,
            sync_notes=sync_notes,
        )
