"""``AuthoringService``: create add-ons and edit team and fleet defaults, one MR each."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from wingman_core.domain.git import FileChange
from wingman_core.domain.mr_conventions import Repo, ResourceType, Verb, mr_title
from wingman_core.domain.users import User
from wingman_day2.application.authoring.chart_repo import check_repourl
from wingman_day2.application.authoring.create import (
    NewAddon,
    check_ignore_differences,
    check_namespace,
    existing_note,
    new_deploy_config,
    sync_words,
)
from wingman_day2.application.authoring.fleet_default import UNSET, Unset, plan_default, reach
from wingman_day2.application.authoring.plan import (
    SCOPE_LABELS,
    Action,
    AuthoringPlan,
    AuthoringResult,
    Effect,
)
from wingman_day2.application.authoring.reads import (
    AddonTemplate,
    FleetDefault,
    addon_template,
    read_fleet_default,
)
from wingman_day2.application.authoring.team_default import TeamDefaultEdit, edited_deploy
from wingman_day2.application.authoring.writer import PlanWriter
from wingman_day2.application.changes.plan import check_chart_name
from wingman_day2.application.topology import TeamState
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import DefaultsScope
from wingman_day2.domain.deploy_config import (
    DEFAULT_REVISION,
    PATH,
    REPOURL,
    SYNC_POLICY,
    TARGET_REVISION,
    truthy,
)
from wingman_day2.domain.errors import (
    ChangeRefusedError,
    ChartAlreadyInstalledError,
    ChartNotInstalledError,
    UnknownChartError,
)
from wingman_day2.domain.findings import Rule
from wingman_day2.domain.sync_policy import AUTOMATED, SYNC_OPTIONS, SyncSettings, policy_override
from wingman_day2.domain.teams import TeamAccess
from wingman_day2.domain.yaml_text import dump_yaml, edit_mapping_text, same_value
from wingman_day2.domain.yaml_values import dump_values, parse_values


class AuthoringService(PlanWriter):
    """Plan and open the MRs that create add-ons and edit team and fleet defaults."""

    # ── reads ───────────────────────────────────────────────────────────────

    async def template(self, team: str) -> AddonTemplate:
        """What a new add-on of ``team`` starts from."""
        state = (await self._topology.load()).team(team)
        return await addon_template(self._sigs, self._charts, self._access, state)

    async def fleet_defaults(self, team: str | None = None) -> list[FleetDefault]:
        """Every ``defaults/<scope>/<chart>/`` (of one team, or all)."""
        topology = await self._topology.load()
        states = [topology.team(team)] if team else list(topology.teams)
        access = await self._access.of_all([s.team for s in states])
        return [
            await self.fleet_default(state, scope, chart, access[state.team.name])
            for state in states
            for scope in DefaultsScope
            for chart in state.repo.tree.subdirs(layout.defaults_dir(scope))
        ]

    async def fleet_default(
        self, state: TeamState, scope: DefaultsScope, chart: str, access: TeamAccess
    ) -> FleetDefault:
        """One fleet default of ``state``'s team, read."""
        return await read_fleet_default(self._sigs, state, scope, chart, access)

    # ── create ──────────────────────────────────────────────────────────────

    async def create(
        self,
        spec: NewAddon,
        user: User,
        *,
        dry_run: bool = False,
        message: str | None = None,
        expected_digest: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR adding ``spec`` to the team's catalog.

        Clusters that have the chart in their own folder already get the new
        team layer under it, so what they deploy may change: each such change
        is listed and must be confirmed (review of 3.8.0).
        """
        topology = await self._topology.load()
        state = topology.team(spec.team)
        await self._access.require_write(state.team)
        chart = check_chart_name(spec.chart)
        folder = layout.operators_dir(chart)
        if state.repo.tree.is_dir(folder):
            raise ChartAlreadyInstalledError(
                f"{state.team.name} has {folder}/ already; edit its Sig values instead",
                details={"rule": "addon-exists", "team": state.team.name, "path": str(folder)},
            )
        sync = spec.sync.checked()
        check_namespace(spec.project_namespace)
        check_ignore_differences(spec.ignore_differences)
        plan = AuthoringPlan(state, Action.CREATE, chart, spec.default_scope)
        deploy_path = folder.child(layout.deploy_config_name(chart))
        plan.findings += await check_repourl(
            self._charts,
            spec.repourl,
            spec.target_revision,
            spec.path,
            file=str(deploy_path),
            where={"team": state.team.name, "chart": chart},
        )
        plan.changes += [
            FileChange.create(deploy_path, dump_yaml(new_deploy_config(spec))),
            FileChange.create(folder.child(layout.VALUES_FILE), dump_values(spec.values)),
        ]
        label = SCOPE_LABELS[spec.default_scope] if spec.default_scope else ""
        if spec.default_scope is not None:
            await plan_default(
                self, plan, spec.default_scope, values=spec.default_values, sync=None
            )
        after = await self.validate(topology, plan)
        existing = existing_note(plan)
        plan.notes.append(
            f"After the merge, {chart} is in {state.team.project.path_with_namespace}'s catalog "
            f"(operators/{chart}/), with {sync_words(sync)}. "
            + (
                existing
                if existing
                else "Nothing is deployed by the catalog itself: install it on a cluster from "
                "Wingman, or make it a fleet default."
            )
        )
        if spec.default_scope is not None:
            await reach(self, plan, after, spec.default_scope)
        plan.title = mr_title(
            Repo.DAY2,
            Verb.CREATE,
            ResourceType.ADDON,
            f"{state.team.name}/{chart}",
            "in the team catalog" + (f" and as a fleet default on {label}" if label else ""),
        )
        self.confirm(plan, spec.confirm_changes, expected_digest, dry_run=dry_run)
        return await self.finish(plan, user, message, dry_run=dry_run)

    # ── team default ────────────────────────────────────────────────────────

    async def update_team_default(
        self,
        team: str,
        chart: str,
        edit: TeamDefaultEdit,
        user: User,
        *,
        dry_run: bool = False,
        message: str | None = None,
        confirm_changes: Sequence[str] = (),
        expected_digest: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR editing ``operators/<chart>/``."""
        topology = await self._topology.load()
        state = topology.team(team)
        await self._access.require_write(state.team)
        tree = state.repo.tree
        folder = layout.operators_dir(chart)
        if not tree.is_dir(folder):
            raise UnknownChartError(
                f"team {team} has no operators/{chart}/", details={"team": team, "chart": chart}
            )
        plan = AuthoringPlan(state, Action.UPDATE_DEFAULT, chart, None)
        deploy_path = folder.child(layout.deploy_config_name(chart))
        file = await self.read(plan, deploy_path) if tree.is_file(deploy_path) else None
        if file is None:
            await self.refuse_if_deleted(plan, deploy_path, edit.last_commit_id)
        old_text = file.content if file else ""
        doc, problem = parse_values(old_text, path=str(deploy_path))
        if problem is not None:
            raise ChangeRefusedError(
                f"{problem.message} ({deploy_path}): fix it by hand first",
                details={"rule": str(Rule.YAML_INVALID), "path": str(deploy_path)},
            )
        new, renames = edited_deploy(doc, edit)
        repo_keys = {REPOURL, TARGET_REVISION, PATH}
        if repo_keys & set(edit.keys) and truthy(new.get(REPOURL)):
            plan.findings += await check_repourl(
                self._charts,
                str(new[REPOURL]),
                new.get(TARGET_REVISION),
                new.get(PATH),
                file=str(deploy_path),
                where={"team": team, "chart": chart},
            )
        if not same_value(new, doc):
            text = (
                edit_mapping_text(old_text, new, path=str(deploy_path), renames=renames)
                if file
                else dump_yaml(new)
            )
            self.write(plan, deploy_path, text, file, edit.last_commit_id)
        if edit.values is not None:
            await self.plan_values(
                plan, folder.child(layout.VALUES_FILE), edit.values, edit.last_commit_id
            )
        if not plan.changes:
            raise ChangeRefusedError(
                f"nothing to change: operators/{chart}/ already holds this",
                details={"rule": "no-change"},
            )
        after = await self.validate(topology, plan)
        apps = [a for a in after.apps if a.chart == chart]
        plan.reach = sorted({a.ref for a in apps}, key=lambda r: r.id)
        changed = sum(1 for i in plan.impact if i.effect is Effect.CHANGED)
        plan.notes.append(
            f"Destinations that get {chart} from {team} inherit these Sig values and deploy config "
            "unless an OCP-version pin, a fleet default or their own folder sets the same key: "
            f"{len(plan.reach)} destination(s) get {chart} today, and what {changed} of them "
            "deploy changes (listed key by key). "
            + (
                f"targetRevision moves to {new.get(TARGET_REVISION) or DEFAULT_REVISION} on every "
                "one that does not pin it. "
                if TARGET_REVISION in edit.keys
                else ""
            )
            + "Leaves that are manual-sync deploy the change only when someone syncs them."
        )
        plan.title = mr_title(
            Repo.DAY2, Verb.UPDATE, ResourceType.ADDON, f"{team}/{chart}", "Sig values"
        )
        self.confirm(plan, confirm_changes, expected_digest, dry_run=dry_run)
        return await self.finish(plan, user, message, dry_run=dry_run)

    # ── fleet defaults ──────────────────────────────────────────────────────

    async def make_default(
        self,
        team: str,
        chart: str,
        scope: DefaultsScope,
        user: User,
        *,
        values: Mapping[str, object],
        sync: SyncSettings | None = None,
        confirm_changes: Sequence[str] = (),
        dry_run: bool = False,
        message: str | None = None,
        expected_digest: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR making ``chart`` a fleet default."""
        topology = await self._topology.load()
        state = topology.team(team)
        await self._access.require_write(state.team)
        if not state.repo.tree.is_dir(layout.operators_dir(chart)):
            raise UnknownChartError(
                f"team {team} has no operators/{chart}/", details={"team": team, "chart": chart}
            )
        plan = AuthoringPlan(state, Action.MAKE_DEFAULT, chart, scope)
        await plan_default(self, plan, scope, values=values, sync=sync)
        after = await self.validate(topology, plan)
        await reach(self, plan, after, scope)
        plan.title = mr_title(
            Repo.DAY2,
            Verb.PROMOTE,
            ResourceType.ADDON,
            f"{team}/{chart}",
            f"to a fleet default on {SCOPE_LABELS[scope]}",
        )
        self.confirm(plan, confirm_changes, expected_digest, dry_run=dry_run)
        return await self.finish(plan, user, message, dry_run=dry_run)

    async def update_fleet_default(
        self,
        team: str,
        chart: str,
        scope: DefaultsScope,
        user: User,
        *,
        values: Mapping[str, object] | None = None,
        sync: SyncSettings | None | Unset = UNSET,
        last_commit_id: str | None = None,
        dry_run: bool = False,
        message: str | None = None,
        confirm_changes: Sequence[str] = (),
        expected_digest: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR editing ``defaults/<scope>/<chart>/``.

        ``sync=None`` removes the fleet layer's sync settings (back to the team
        default's); ``UNSET`` leaves them.
        """
        topology = await self._topology.load()
        state = topology.team(team)
        await self._access.require_write(state.team)
        tree = state.repo.tree
        fleet = layout.defaults_dir(scope).child(chart)
        if not tree.is_dir(fleet):
            raise ChartNotInstalledError(
                f"{chart} is not a fleet default of {team} on {SCOPE_LABELS[scope]}",
                details={"team": team, "chart": chart, "scope": str(scope)},
            )
        plan = AuthoringPlan(state, Action.UPDATE_DEFAULT, chart, scope)
        name = layout.deploy_config_name(chart)
        if sync is not UNSET:
            path = fleet.child(name)
            file = await self.read(plan, path) if tree.is_file(path) else None
            old_text = file.content if file else ""
            doc, problem = parse_values(old_text, path=str(path))
            if problem is not None:
                raise ChangeRefusedError(
                    f"{problem.message} ({path}): fix it by hand first",
                    details={"rule": str(Rule.YAML_INVALID), "path": str(path)},
                )
            current = doc.get(SYNC_POLICY)
            if sync is None:
                policy = dict(current) if isinstance(current, Mapping) else {}
                policy.pop(AUTOMATED, None)
                policy.pop(SYNC_OPTIONS, None)
            else:
                team_doc = await self.doc(
                    plan, layout.operators_dir(chart).child(name), after=False
                )
                policy = policy_override([team_doc], sync.checked(), current)
            new = {k: v for k, v in doc.items() if k != SYNC_POLICY}
            if policy:
                new = {**doc, SYNC_POLICY: policy}
            if not same_value(new, doc):
                text = edit_mapping_text(old_text, new, path=str(path)) if file else dump_yaml(new)
                self.write(plan, path, text, file, last_commit_id)
        if values is not None:
            await self.plan_values(plan, fleet.child(layout.VALUES_FILE), values, last_commit_id)
        if not plan.changes:
            raise ChangeRefusedError(
                f"nothing to change: {fleet}/ already holds this", details={"rule": "no-change"}
            )
        after = await self.validate(topology, plan)
        await reach(self, plan, after, scope, new_default=False)
        plan.title = mr_title(
            Repo.DAY2,
            Verb.UPDATE,
            ResourceType.ADDON,
            f"{team}/{chart}",
            f"fleet default on {SCOPE_LABELS[scope]}",
        )
        self.confirm(plan, confirm_changes, expected_digest, dry_run=dry_run)
        return await self.finish(plan, user, message, dry_run=dry_run)
