"""``ChangeService``: install, update and remove a cluster's charts, one MR each (ADR-0022)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from wingman_core.domain.errors import GitError
from wingman_core.domain.mr_conventions import Verb
from wingman_core.domain.users import User
from wingman_core.ports.clock import Clock
from wingman_core.ports.gitlab import GitLabPort
from wingman_day2.application.access import AccessService
from wingman_day2.application.apps import load_deploy
from wingman_day2.application.changes.install import BulkResult, InstallSpec, plan_install
from wingman_day2.application.changes.mces import MceInstalls, mce_ref, open_each, plan_on_mce
from wingman_day2.application.changes.opening import open_change
from wingman_day2.application.changes.plan import (
    ChangePlan,
    ChangeResult,
    check_chart_name,
    installed_app,
    require_writable,
    validate,
)
from wingman_day2.application.changes.remove import plan_remove, refuse_fleet_default
from wingman_day2.application.changes.update import plan_pin, plan_values
from wingman_day2.application.topology import TopologyService
from wingman_day2.domain import layout
from wingman_day2.domain.errors import (
    ChangeRefusedError,
    Day2Error,
    UnknownChartError,
    UnknownTeamError,
)
from wingman_day2.ports import SigsRepository


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

    async def install_on_mces(
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
        """Install ``chart`` in each chosen MCE hub's own folder: one MR per MCE (``mces``)."""
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
        spec = InstallSpec(team, chart, values=dict(values or {}))
        planned = [await plan_on_mce(self._sigs, topology, state, mce_ref(k), spec) for k in keys]
        if dry_run:
            return MceInstalls(team, chart, tuple(install for install, _ in planned))

        async def open_plan(plan: ChangePlan) -> ChangeResult:
            return await self._open(plan, user, Verb.INSTALL, message)

        opened = await open_each(planned, open_plan, user=user, team=team, chart=chart)
        return MceInstalls(team, chart, opened)

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
        refuse_fleet_default(app, summary)
        plan = await plan_remove(self._sigs, state, summary, app, last_commit_id)
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
