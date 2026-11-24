"""What every authoring MR shares: its plan, impact, digest, confirmation (ADR-0043, ADR-0053).

- **Impact.** Every app of the plan's chart, on every destination of every
  kind, before and after: its effective deploy config and workload values
  (chart defaults aside, Helm's ``null`` kept as a value, because a ``null``
  deletes a chart default), and whether it is generated at all. An app that
  goes is ``removed`` (the workload is orphaned, ``prune: false``), one that
  comes is ``added``, one whose config or values move is ``changed``.
- **Confirmation.** Every ``removed`` or ``changed`` destination, and every
  adopted cluster whose move changes something, must be confirmed by id,
  together with the preview's **digest**: a sha256 of what the MR writes
  (each file's path, kind and text), its title and its impact. A request
  whose digest is not the plan's any more is refused (``PlanChangedError``,
  409): the repo moved between the preview and the submit, and the person
  never saw what would now be opened (ADR-0006).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from wingman_core.domain.errors import NotFoundError, RevisionConflictError
from wingman_core.domain.git import ChangeKind, FileChange, FileContent, RepoPath
from wingman_core.domain.mr_conventions import (
    MRMetadata,
    Repo,
    ResourceType,
    branch_name,
    mr_description,
)
from wingman_core.domain.users import User
from wingman_core.ports.clock import Clock
from wingman_core.ports.gitlab import GitLabPort
from wingman_day2.application.access import AccessService
from wingman_day2.application.authoring.describe import describe
from wingman_day2.application.authoring.plan import (
    AuthoringPlan,
    AuthoringResult,
    DestinationImpact,
    Effect,
    KeyChange,
    key_changes,
)
from wingman_day2.application.changes.opening import open_team_mr
from wingman_day2.application.changes.plan import refuse_new_errors
from wingman_day2.application.topology import Topology, TopologyService
from wingman_day2.domain.clusters import DefaultsScope
from wingman_day2.domain.deploy_config import leaf_application
from wingman_day2.domain.errors import ChangeRefusedError, PlanChangedError
from wingman_day2.domain.findings import Rule, warning
from wingman_day2.domain.merge import merge_layers, merge_values
from wingman_day2.domain.platform import PlannedApp, TeamPlan
from wingman_day2.domain.stacks import Layer
from wingman_day2.domain.yaml_text import same_value
from wingman_day2.domain.yaml_values import dump_values, parse_values
from wingman_day2.ports import ChartRepository, SigsRepository


class PlanWriter:
    """Reads a plan's files before and after, measures its impact, and opens its MR."""

    def __init__(
        self,
        gitlab: GitLabPort,
        topology: TopologyService,
        sigs: SigsRepository,
        charts: ChartRepository,
        access: AccessService,
        clock: Clock,
    ) -> None:
        """Write through ``gitlab``; read through the rest; ask ``access`` before any write."""
        self._gitlab = gitlab
        self._topology = topology
        self._sigs = sigs
        self._charts = charts
        self._access = access
        self._clock = clock

    # ── files before and after ──────────────────────────────────────────────

    async def read(self, plan: AuthoringPlan, path: RepoPath) -> FileContent | None:
        """``path`` in the plan's team repo, as it is before the MR."""
        return await self._sigs.read(plan.state.team, path)

    async def text(self, plan: AuthoringPlan, path: RepoPath, *, after: bool) -> str | None:
        """``path``'s text before the MR, or after it."""
        if after:
            change = plan.pending(path)
            if change is not None:
                return None if change.kind is ChangeKind.DELETE else change.content
        if not plan.state.repo.tree.is_file(path):
            return None
        file = await self.read(plan, path)
        return file.content if file else None

    async def doc(
        self, plan: AuthoringPlan, path: RepoPath, *, after: bool, strict: bool = True
    ) -> dict[str, object]:
        """``path`` parsed (``{}`` when absent).

        Invalid YAML refuses, or with ``strict=False`` reads as ``{}`` with a warning.
        """
        pending = plan.pending(path) if after else None
        if pending is None and str(path) in plan.docs:
            values, problem = plan.docs[str(path)]
        else:
            text = await self.text(plan, path, after=after)
            values, problem = parse_values(text, path=str(path)) if text is not None else ({}, None)
            if pending is None:
                # Only today's files are kept: a later change of the plan moves "after".
                plan.docs[str(path)] = (values, problem)
        if problem is not None:
            if strict:
                raise ChangeRefusedError(
                    f"{problem.message} ({path}): Wingman cannot tell what the change does; fix "
                    "it by hand first",
                    details={"rule": str(Rule.YAML_INVALID), "path": str(path)},
                )
            note = warning(
                Rule.YAML_INVALID,
                f"{problem.message}: Wingman reads {path} as empty to say what changes",
                team=plan.team,
                path=str(path),
                chart=plan.chart,
            )
            if note not in plan.findings:
                plan.findings.append(note)
        return values

    async def merged(
        self, plan: AuthoringPlan, layers: Sequence[Layer], *, after: bool, strict: bool = True
    ) -> dict[str, object]:
        """``layers`` merged as Helm's ``-f`` files are, ``null`` kept (chart defaults aside)."""
        docs = [
            (str(x.path), await self.doc(plan, x.path, after=after, strict=strict)) for x in layers
        ]
        return merge_layers(docs).values

    async def app_state(
        self, plan: AuthoringPlan, app: PlannedApp, *, after: bool
    ) -> tuple[dict[str, object], dict[str, object], str]:
        """The app's effective deploy config, its workload values and its name, before or after."""
        deploy_docs = [
            (str(x.path), await self.doc(plan, x.path, after=after, strict=False))
            for x in app.deploy_config_layers
        ]
        values = await self.merged(plan, app.workload_layers, after=after, strict=False)
        name = leaf_application(
            merge_values({}, deploy_docs).values, team=plan.team, chart=app.chart, ref=app.ref
        ).name
        return merge_layers(deploy_docs).values, values, name

    async def compare(
        self, plan: AuthoringPlan, before: PlannedApp, after: PlannedApp
    ) -> list[KeyChange]:
        """What changes for one app between ``before`` (read as today) and ``after`` (the MR)."""
        deploy_before, values_before, _ = await self.app_state(plan, before, after=False)
        deploy_after, values_after, _ = await self.app_state(plan, after, after=True)
        return [
            *key_changes("deploy", deploy_before, deploy_after),
            *key_changes("values", values_before, values_after),
        ]

    # ── writing ─────────────────────────────────────────────────────────────

    @staticmethod
    def write(
        plan: AuthoringPlan,
        path: RepoPath,
        text: str,
        file: FileContent | None,
        last_commit_id: str | None,
    ) -> None:
        """Update ``file`` (guarded by the caller's read, else this one) or create ``path``."""
        if file is not None:
            plan.previous[str(path)] = file.content
            plan.changes.append(
                FileChange.update(path, text, last_commit_id=last_commit_id or file.last_commit_id)
            )
        else:
            plan.changes.append(FileChange.create(path, text))

    async def refuse_if_deleted(
        self, plan: AuthoringPlan, path: RepoPath, last_commit_id: str | None
    ) -> None:
        """409 when ``path`` is gone now but existed at the commit the caller read."""
        if not last_commit_id:
            return
        try:
            await self._gitlab.read_file(plan.state.team.project.id, path, ref=last_commit_id)
        except NotFoundError:
            return
        raise RevisionConflictError(
            f"{path} was deleted since {last_commit_id[:8]}, which the change was based on: "
            "read it again"
        )

    async def plan_values(
        self,
        plan: AuthoringPlan,
        path: RepoPath,
        values: Mapping[str, object],
        last_commit_id: str | None,
        *,
        delete_when_empty: bool = False,
    ) -> None:
        """Replace a values file whole, guarded; never re-create one deleted since the read."""
        tree = plan.state.repo.tree
        file = await self.read(plan, path) if tree.is_file(path) else None
        if file is None:
            await self.refuse_if_deleted(plan, path, last_commit_id)
            if values or (not delete_when_empty and not tree.files_under(path.parent)):
                plan.changes.append(FileChange.create(path, dump_values(values)))
            return
        existing, problem = parse_values(file.content, path=str(path))
        if delete_when_empty and not values:
            plan.previous[str(path)] = file.content
            plan.changes.append(
                FileChange.delete(path, last_commit_id=last_commit_id or file.last_commit_id)
            )
            return
        if problem is None and same_value(existing, dict(values)):
            return
        self.write(plan, path, dump_values(values), file, last_commit_id)

    # ── checking ────────────────────────────────────────────────────────────

    async def validate(self, topology: Topology, plan: AuthoringPlan) -> TeamPlan:
        """Refuse new platform errors (ADR-0023); fill the plan's impact and exclusions."""
        after = refuse_new_errors(topology, plan.state, plan.changes)
        before = {a.ref: a for a in plan.state.plan.apps if a.chart == plan.chart}
        later = {a.ref: a for a in after.apps if a.chart == plan.chart}
        impact: list[DestinationImpact] = []
        for ref in sorted({*before, *later}, key=lambda r: r.id):
            old, new = before.get(ref), later.get(ref)
            if new is None and old is not None:
                _, _, name = await self.app_state(plan, old, after=False)
                impact.append(DestinationImpact(ref, Effect.REMOVED, name))
            elif old is None and new is not None:
                _, _, name = await self.app_state(plan, new, after=True)
                impact.append(DestinationImpact(ref, Effect.ADDED, name))
            elif old is not None and new is not None:
                changes = await self.compare(plan, old, new)
                if changes:
                    _, _, name = await self.app_state(plan, new, after=True)
                    impact.append(DestinationImpact(ref, Effect.CHANGED, name, tuple(changes)))
        plan.impact = impact
        if plan.scope is not None and plan.scope is not DefaultsScope.HUB:
            plan.excluded = sorted(
                {
                    e.ref
                    for e in after.excluded
                    if e.chart == plan.chart and e.ref.defaults_scope is plan.scope
                },
                key=lambda r: r.id,
            )
        return after

    @staticmethod
    def confirm(
        plan: AuthoringPlan,
        confirm_changes: Sequence[str],
        expected_digest: str | None,
        *,
        dry_run: bool,
    ) -> None:
        """Refuse a request that did not confirm exactly what the plan changes, as previewed."""
        if dry_run:
            return
        digest = plan.digest
        if expected_digest is not None and expected_digest != digest:
            raise PlanChangedError(
                f"{plan.state.team.project.path_with_namespace} changed since the preview: this "
                "change would now write or do something else. Preview it again.",
                details={"rule": "plan-changed", "digest": digest, "expected": expected_digest},
            )
        needs = plan.needs_confirmation
        if sorted(set(confirm_changes)) != needs:
            raise ChangeRefusedError(
                (
                    f"this change deletes or changes what {len(needs)} destination(s) deploy: "
                    f"confirm each of them in confirm_changes ({', '.join(needs)})"
                )
                if needs
                else "confirm_changes names destinations this change does not touch; send it empty",
                details={
                    "rule": "confirm-changes",
                    "needs_confirmation": needs,
                    "impact": [i.details() for i in plan.impact if i.needs_confirmation],
                    "adopted": [
                        a.details() for a in plan.adopted if a.changes or a.exclusion_removed
                    ],
                },
            )
        if needs and expected_digest is None:
            raise ChangeRefusedError(
                "a change that deletes or changes what destinations deploy is confirmed against "
                "its preview: send the preview's digest as expected_digest",
                details={"rule": "confirm-against-preview", "needs_confirmation": needs},
            )

    # ── opening ─────────────────────────────────────────────────────────────

    async def finish(
        self, plan: AuthoringPlan, user: User, message: str | None, *, dry_run: bool
    ) -> AuthoringResult:
        """Open the plan's MR (one commit on a new branch), unless ``dry_run``."""
        if dry_run:
            return AuthoringResult(plan, None)
        team = plan.state.team
        action = str(plan.action)
        resource = f"{team.name}/{plan.chart}"
        branch = branch_name(
            username=user.username,
            action=action,
            resource=f"{plan.chart}-{plan.scope}" if plan.scope else plan.chart,
            at=self._clock(),
        )
        metadata = MRMetadata(user.username, action, ResourceType.ADDON, resource, Repo.DAY2)
        commit_message = (
            f"{plan.title.removeprefix(f'[Wingman/{Repo.DAY2}] ')}\n\n"
            f"Team: {team.name}\nRequested by {user.username} via Wingman"
        )
        merge_request = await open_team_mr(
            self._gitlab,
            self._sigs,
            team,
            user,
            branch=branch,
            action=action,
            message=commit_message,
            changes=plan.changes,
            title=plan.title,
            description=mr_description(describe(plan, message), metadata),
        )
        return AuthoringResult(plan, merge_request)
