"""An add-on's OCP-version pins: added, changed and removed by merge request (ADR-0043).

A pin is ``operators/<chart>/ocp-versions/<version>/`` in the team repo
(``domain.ocp_pins``): the chart revision and values of the add-on on every
destination that runs OCP ``<version>`` exactly. Each write is one MR of the
add-on's own folder, in the authoring conventions: label and footer action
``update-default``, titled ``[Wingman/Day2] Update addon <team>/<chart>
OCP-version pin <version>[ (new: <revision>)| (removed)]``. Like every
authoring write it is refused first for a team that has not given Wingman
write access, checked as the platform would render it, measured on every
app of the chart (the destinations at that version change), confirmed
against its preview's digest, and guarded by the commit the pin was read at
(ADR-0006). A new add-on's pins go in its create MR (:func:`plan_new_pins`).

Two things the platform does that the person must know (the footguns of
``gitops-day2-prod``'s ARCHITECTURE.md §4.4): a fleet default's deploy config
that sets ``targetRevision`` overrides every pin's revision on its scope, and
a pin is read only at its exact version, so a cluster moving to a new one,
z-streams included, falls back to the add-on's revision until that pin
exists. Both are said in the plan.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from wingman_core.domain.git import FileChange
from wingman_core.domain.mr_conventions import Repo, ResourceType, Verb, mr_title
from wingman_core.domain.users import User
from wingman_day2.application.plan_writer import (
    SCOPE_LABELS,
    Action,
    AuthoringPlan,
    AuthoringResult,
    PlanWriter,
)
from wingman_day2.application.topology import Topology
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import DefaultsScope
from wingman_day2.domain.deploy_config import (
    DEFAULT_REVISION,
    PATH,
    REPOURL,
    TARGET_REVISION,
    truthy,
)
from wingman_day2.domain.errors import (
    ChangeRefusedError,
    ChartAlreadyInstalledError,
    ChartNotInstalledError,
    UnknownChartError,
)
from wingman_day2.domain.findings import Rule, warning
from wingman_day2.domain.ocp_pins import (
    PinSpec,
    check_ocp_version,
    check_pin,
    check_revision,
    check_values,
    new_pin_files,
    pin_deploy_config,
    version_key,
)
from wingman_day2.domain.platform import AppSource, TeamPlan
from wingman_day2.domain.yaml_text import edit_mapping_text, same_value

PIN_SCOPES = (DefaultsScope.HOSTED_CLUSTERS, DefaultsScope.MCES, DefaultsScope.UPI)
"""The scopes whose destinations read pins: the hub is version-less."""


@dataclass(frozen=True, slots=True)
class PinChange:
    """A change of one pin: ``None`` leaves that part as it is; empty values delete the file."""

    target_revision: str | None = None
    values: Mapping[str, object] | None = None


@dataclass(frozen=True, slots=True)
class _Request:
    """How a write was asked: by whom, the preview it confirms, its note, and if a dry run."""

    user: User
    confirm_changes: Sequence[str]
    expected_digest: str | None
    message: str | None
    dry_run: bool


async def _check_revision(
    writer: PlanWriter, plan: AuthoringPlan, revision: str, *, repourl: object, chart_path: object
) -> None:
    """Refuse a revision the chart repo has no branch of (warn where it cannot be told)."""
    file = str(layout.ocp_versions_dir(plan.chart))
    where = {"team": plan.team, "chart": plan.chart}
    if not truthy(repourl):
        note = warning(
            Rule.REPOURL_MISSING,
            f"{plan.chart} has no lowercase repourl: Wingman cannot check that its chart repo "
            f"has a branch {revision!r}",
            path=file,
            **where,
        )
        found = [note]
    else:
        found = await writer.check_chart_repo(
            str(repourl), revision, chart_path, file=file, where=where
        )
    plan.findings += [f for f in found if f not in plan.findings]


async def plan_new_pins(
    writer: PlanWriter,
    plan: AuthoringPlan,
    pins: Sequence[PinSpec],
    *,
    repourl: str,
    chart_path: str | None,
) -> None:
    """Add a new add-on's ``pins`` to its create ``plan``, each revision checked."""
    for pin in pins:
        plan.changes += new_pin_files(plan.chart, pin)
        await _check_revision(
            writer, plan, str(pin.target_revision), repourl=repourl, chart_path=chart_path
        )
    if pins:
        plan.notes.append(
            f"operators/{plan.chart}/ocp-versions/ pins it per OCP version "
            f"({', '.join(f'{p.version}: {p.target_revision}' for p in pins)}): a destination "
            "at exactly that version gets that revision and values; every other one the "
            "add-on's own. Each new OCP version needs its pin before day1 moves a cluster "
            "to it, or the cluster falls back to the add-on's revision."
        )


class OcpPinService(PlanWriter):
    """Plan and open the MRs that add, change and remove an add-on's OCP-version pins."""

    async def add(
        self,
        team: str,
        chart: str,
        pin: PinSpec,
        user: User,
        *,
        confirm_changes: Sequence[str] = (),
        expected_digest: str | None = None,
        dry_run: bool = False,
        message: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR adding ``ocp-versions/<v>/`` to the add-on."""
        request = _Request(user, confirm_changes, expected_digest, message, dry_run)
        topology, plan = await self._start(team, chart)
        pin = check_pin(pin)
        folder = layout.ocp_version_dir(chart, pin.version)
        if plan.state.repo.tree.is_dir(folder):
            raise ChartAlreadyInstalledError(
                f"{chart} has a pin for OCP {pin.version} already ({folder}/): change it instead",
                details={"rule": "pin-exists", "path": str(folder), "version": pin.version},
            )
        plan.changes += new_pin_files(chart, pin)
        await self._check(plan, pin.version, str(pin.target_revision))
        return await self._finish(
            topology, plan, pin.version, f"(new: {pin.target_revision})", request
        )

    async def change(
        self,
        team: str,
        chart: str,
        version: str,
        change: PinChange,
        user: User,
        *,
        last_commit_id: str | None = None,
        confirm_changes: Sequence[str] = (),
        expected_digest: str | None = None,
        dry_run: bool = False,
        message: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR changing a pin's revision or values.

        The deploy config is edited in place (its comments and other keys
        kept); the values file is replaced whole, and deleted when emptied.
        """
        request = _Request(user, confirm_changes, expected_digest, message, dry_run)
        topology, plan = await self._start(team, chart)
        version = check_ocp_version(version)
        await self._require_pin(plan, version, last_commit_id)
        folder = layout.ocp_version_dir(chart, version)
        if change.target_revision is not None:
            revision = check_revision(change.target_revision)
            await self._set_revision(plan, version, revision, last_commit_id)
            await self._check(plan, version, revision)
        if change.values is not None:
            await self.plan_values(
                plan,
                folder.child(layout.VALUES_FILE),
                check_values(change.values),
                last_commit_id,
                delete_when_empty=True,
            )
        if not plan.changes:
            raise ChangeRefusedError(
                f"nothing to change: {folder}/ already holds this", details={"rule": "no-change"}
            )
        if not plan.tree.is_dir(folder):
            raise ChangeRefusedError(
                f"{folder}/ would hold neither a revision nor values, which is no pin: remove it "
                "instead",
                details={"rule": "pin-empty", "path": str(folder)},
            )
        return await self._finish(topology, plan, version, "", request)

    async def remove(
        self,
        team: str,
        chart: str,
        version: str,
        user: User,
        *,
        last_commit_id: str | None = None,
        confirm_changes: Sequence[str] = (),
        expected_digest: str | None = None,
        dry_run: bool = False,
        message: str | None = None,
    ) -> AuthoringResult:
        """Plan, and unless ``dry_run`` open, the MR deleting ``ocp-versions/<v>/``, guarded."""
        request = _Request(user, confirm_changes, expected_digest, message, dry_run)
        topology, plan = await self._start(team, chart)
        version = check_ocp_version(version)
        await self._require_pin(plan, version, last_commit_id)
        for path in plan.state.repo.tree.files_under(layout.ocp_version_dir(chart, version)):
            file = await self._sigs.read(plan.state.team, path)
            plan.previous[str(path)] = file.content if file else ""
            plan.changes.append(
                FileChange.delete(
                    path, last_commit_id=last_commit_id or (file.last_commit_id if file else None)
                )
            )
        return await self._finish(topology, plan, version, "(removed)", request)

    # ── shared ──────────────────────────────────────────────────────────────

    async def _start(self, team: str, chart: str) -> tuple[Topology, AuthoringPlan]:
        topology = await self._topology.load()
        state = topology.team(team)
        await self._access.require_write(state.team)
        if not state.repo.tree.is_dir(layout.operators_dir(chart)):
            raise UnknownChartError(
                f"team {team} has no operators/{chart}/: a pin belongs to an add-on of the "
                "team's catalog",
                details={"team": team, "chart": chart},
            )
        return topology, AuthoringPlan(state, Action.UPDATE_DEFAULT, chart, None)

    async def _require_pin(
        self, plan: AuthoringPlan, version: str, last_commit_id: str | None
    ) -> None:
        """404 for a pin that is not there; 409 for one deleted since the caller's read."""
        folder = layout.ocp_version_dir(plan.chart, version)
        if plan.state.repo.tree.is_dir(folder):
            return
        for name in (layout.deploy_config_name(plan.chart), layout.VALUES_FILE):
            await self.refuse_if_deleted(plan, folder.child(name), last_commit_id)
        raise ChartNotInstalledError(
            f"{plan.chart} has no pin for OCP {version} ({folder}/)",
            details={"rule": "pin-unknown", "team": plan.team, "version": version},
        )

    async def _set_revision(
        self, plan: AuthoringPlan, version: str, revision: str, last_commit_id: str | None
    ) -> None:
        """Set the pin's ``targetRevision`` in place, or write its deploy config."""
        path = layout.ocp_version_dir(plan.chart, version).child(
            layout.deploy_config_name(plan.chart)
        )
        tree = plan.state.repo.tree
        file = await self._sigs.read(plan.state.team, path) if tree.is_file(path) else None
        if file is None:
            await self.refuse_if_deleted(plan, path, last_commit_id)
            plan.changes.append(FileChange.create(path, pin_deploy_config(revision)))
            return
        doc = await self.doc(plan, path, after=False)
        new = {**doc, TARGET_REVISION: revision}
        if not same_value(new, doc):
            text = edit_mapping_text(file.content, new, path=str(path))
            self.write(plan, path, text, file, last_commit_id)

    async def _check(self, plan: AuthoringPlan, version: str, revision: str) -> None:
        """Check ``revision`` against the chart repo the pin's own or the add-on's config names."""
        name = layout.deploy_config_name(plan.chart)
        team_doc = await self.doc(plan, layout.operators_dir(plan.chart).child(name), after=False)
        pin_path = layout.ocp_version_dir(plan.chart, version).child(name)
        pin_doc = await self.doc(plan, pin_path, after=True)
        repourl = pin_doc.get(REPOURL) or team_doc.get(REPOURL)
        chart_path = pin_doc.get(PATH) or team_doc.get(PATH)
        await _check_revision(self, plan, revision, repourl=repourl, chart_path=chart_path)

    async def _finish(
        self, topology: Topology, plan: AuthoringPlan, version: str, extra: str, request: _Request
    ) -> AuthoringResult:
        after = await self.validate(topology, plan)
        await self._fleet_overrides(plan)
        plan.reach = sorted(
            {a.ref for a in after.apps if a.chart == plan.chart and a.ocp_version == version},
            key=lambda r: r.id,
        )
        plan.notes += await self._notes(plan, after, version, removed=extra == "(removed)")
        plan.title = mr_title(
            Repo.DAY2,
            Verb.UPDATE,
            ResourceType.ADDON,
            f"{plan.team}/{plan.chart}",
            f"OCP-version pin {version}" + (f" {extra}" if extra else ""),
        )
        self.confirm(
            plan, request.confirm_changes, request.expected_digest, dry_run=request.dry_run
        )
        return await self.finish(plan, request.user, request.message, dry_run=request.dry_run)

    async def _fleet_overrides(self, plan: AuthoringPlan) -> None:
        """Warn of each fleet default whose deploy config sets a revision over every pin."""
        name = layout.deploy_config_name(plan.chart)
        for scope in PIN_SCOPES:
            path = layout.defaults_dir(scope).child(plan.chart, name)
            doc = await self.doc(plan, path, after=True, strict=False)
            if truthy(doc.get(TARGET_REVISION)):
                plan.findings.append(
                    warning(
                        Rule.FLEET_PIN_OVERRIDES_OCP_VERSIONS,
                        f"{path} sets targetRevision {doc[TARGET_REVISION]!r}, which overrides "
                        f"every ocp-versions/ pin: on {SCOPE_LABELS[scope]} a pin's revision "
                        "does nothing (its values still apply). Remove targetRevision from "
                        "the fleet default for the pins to take effect there",
                        team=plan.team,
                        chart=plan.chart,
                        path=str(path),
                    )
                )

    async def _notes(
        self, plan: AuthoringPlan, after: TeamPlan, version: str, *, removed: bool
    ) -> list[str]:
        """Who reads the pin, who does not, and what a cluster moving to a new version gets."""
        chart, team = plan.chart, plan.team
        names = ", ".join(r.name for r in plan.reach)
        team_doc = await self.doc(
            plan, layout.operators_dir(chart).child(layout.deploy_config_name(chart)), after=True
        )
        revision = team_doc.get(TARGET_REVISION) or DEFAULT_REVISION
        if removed:
            notes = [
                f"The {len(plan.reach)} destination(s) of {team} at OCP {version} that get "
                f"{chart} ({names or 'none today'}) go back to the add-on's revision "
                f"({revision}) and its Sig values."
            ]
        elif plan.reach:
            notes = [
                f"operators/{chart}/ocp-versions/{version}/ is read by every destination of "
                f"{team} that gets {chart} and runs OCP {version} exactly: {len(plan.reach)} "
                f"today ({names}). Its targetRevision wins over the add-on's unless a fleet "
                "default's deploy config or a cluster's own folder sets one; its values sit "
                "above the Sig values, below every other layer."
            ]
        else:
            notes = [
                f"No destination that gets {chart} runs OCP {version} today: the pin applies "
                f"to each one that moves to {version}. Merge it before day1 moves a "
                "cluster's mastertag there, or the cluster falls back to the add-on's revision "
                "until it exists."
            ]
        pinned = set(plan.tree.subdirs(layout.ocp_versions_dir(chart)))
        unpinned = sorted(
            {
                a.ocp_version
                for a in after.apps
                if a.chart == chart and a.ocp_version and a.ocp_version not in pinned
            },
            key=version_key,
        )
        if pinned and unpinned:
            notes.append(
                f"{chart} also runs on OCP {', '.join(unpinned)}, with no pin: there it gets "
                f"the add-on's revision ({revision}), and the lints warn about each such "
                "destination (ocp-version-pin-missing)."
            )
        own = await self._emergency_pins(plan, after, version)
        if own and not removed:
            notes.append(
                f"{', '.join(own)} pin their own targetRevision (an emergency pin): this pin's "
                "revision does not reach them, its values do."
            )
        notes.append("Leaves that are manual-sync deploy the change only when someone syncs them.")
        return notes

    async def _emergency_pins(
        self, plan: AuthoringPlan, after: TeamPlan, version: str
    ) -> list[str]:
        """The destinations at ``version`` whose own folder pins the chart's revision."""
        found = []
        for app in after.apps:
            if app.chart != plan.chart or app.ocp_version != version:
                continue
            if app.source is not AppSource.CLUSTER:
                continue
            path = app.folder.child(layout.deploy_config_name(plan.chart))
            if truthy((await self.doc(plan, path, after=True, strict=False)).get(TARGET_REVISION)):
                found.append(app.ref.name)
        return sorted(found)
