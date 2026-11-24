"""What the authoring pages read: a new add-on's template, and a team's fleet defaults."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from wingman_core.domain.git import RepoPath
from wingman_day2.application.access import AccessService
from wingman_day2.application.apps import LoadedLayer, load_layers
from wingman_day2.application.authoring.plan import (
    SCOPE_LABELS,
    SCOPE_ORDER,
    fleet_apps,
    scope_destinations,
)
from wingman_day2.application.topology import TeamState
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ClusterRef, DefaultsScope
from wingman_day2.domain.deploy_config import SYNC_POLICY
from wingman_day2.domain.findings import Finding, Rule, warning
from wingman_day2.domain.stacks import Layer, LayerRole
from wingman_day2.domain.sync_policy import (
    PLATFORM_DEFAULT,
    SyncSettings,
    effective_policy,
    sync_settings,
)
from wingman_day2.domain.teams import TeamAccess, charts_group
from wingman_day2.ports import ChartRepository, SigsRepository


@dataclass(frozen=True, slots=True)
class ScopeReach:
    """A fleet scope and the destinations a default there reaches today."""

    scope: DefaultsScope
    destinations: tuple[ClusterRef, ...]

    @property
    def label(self) -> str:
        """``every hosted cluster``, ``the hub``, ..."""
        return SCOPE_LABELS[self.scope]


@dataclass(frozen=True, slots=True)
class AddonTemplate:
    """What a new add-on form starts from: its team's usual sync options and charts group."""

    team: str
    access: TeamAccess
    sync: SyncSettings
    sync_source: str
    repourl_prefix: str
    """``<GITLAB_URL>/<team>/helm-charts/``, whatever the team's add-ons use (ADR-0060)."""
    scopes: tuple[ScopeReach, ...]


@dataclass(frozen=True, slots=True)
class FleetDefault:
    """One ``defaults/<scope>/<chart>/`` of a team."""

    team: str
    chart: str
    scope: DefaultsScope
    folder: RepoPath
    in_catalog: bool
    values: LoadedLayer
    deploy: LoadedLayer
    sync: SyncSettings
    sync_overridden: bool
    reach: tuple[ClusterRef, ...]
    excluded: tuple[ClusterRef, ...]
    tweaks: tuple[RepoPath, ...]
    access: TeamAccess
    findings: tuple[Finding, ...]

    @property
    def last_commit_id(self) -> str | None:
        """The commit the folder was read at (send it back on edit)."""
        file = self.values.file or self.deploy.file
        return file.last_commit_id if file else None


async def addon_template(
    sigs: SigsRepository, charts: ChartRepository, access: AccessService, state: TeamState
) -> AddonTemplate:
    """What a new add-on of ``state``'s team starts from."""
    tree = state.repo.tree
    names = tree.subdirs(RepoPath.of(layout.OPERATORS))
    layers = [
        Layer(LayerRole.TEAM, layout.operators_dir(c).child(layout.deploy_config_name(c)))
        for c in names
    ]
    loaded = [x for x in await load_layers(sigs, state.team, tree, layers) if x.exists]
    settings = Counter(sync_settings(x.values.get(SYNC_POLICY)) for x in loaded)
    project = state.team.project.path_with_namespace
    if settings:
        (sync, count), *_ = settings.most_common()
        # A tie among the leaders goes to the platform's default, when it is one of them.
        if settings[PLATFORM_DEFAULT] == count:
            sync = PLATFORM_DEFAULT
        source = (
            f"the sync options most of {project}'s add-ons use ({settings[sync]} of {len(loaded)})"
        )
    else:
        sync = PLATFORM_DEFAULT
        source = f"the platform's default: {project} has no add-on in operators/ to copy from"
    return AddonTemplate(
        team=state.team.name,
        access=await access.of(state.team),
        sync=sync,
        sync_source=source,
        repourl_prefix=charts.group_url(charts_group(state.team.name)),
        scopes=tuple(
            ScopeReach(scope, scope_destinations(state.plan, scope)) for scope in SCOPE_ORDER
        ),
    )


async def read_fleet_default(
    sigs: SigsRepository,
    state: TeamState,
    scope: DefaultsScope,
    chart: str,
    access: TeamAccess,
) -> FleetDefault:
    """One fleet default of ``state``'s team, read."""
    tree = state.repo.tree
    folder = layout.defaults_dir(scope).child(chart)
    name = layout.deploy_config_name(chart)
    team_deploy, values, deploy = await load_layers(
        sigs,
        state.team,
        tree,
        [
            Layer(LayerRole.TEAM, layout.operators_dir(chart).child(name)),
            Layer(LayerRole.FLEET, folder.child(layout.VALUES_FILE)),
            Layer(LayerRole.FLEET, folder.child(name)),
        ],
    )
    policy = effective_policy([team_deploy.values, deploy.values])
    apps = fleet_apps(state.plan, chart, scope)
    findings = [
        warning(
            Rule.YAML_INVALID,
            x.problem.message,
            team=state.team.name,
            path=x.problem.path,
            chart=chart,
        )
        for x in (team_deploy, values, deploy)
        if x.problem is not None
    ]
    return FleetDefault(
        team=state.team.name,
        chart=chart,
        scope=scope,
        folder=folder,
        in_catalog=tree.is_dir(layout.operators_dir(chart)),
        values=values,
        deploy=deploy,
        sync=sync_settings(policy),
        sync_overridden=SYNC_POLICY in deploy.values,
        reach=tuple(a.ref for a in apps),
        excluded=tuple(
            e.ref for e in state.plan.excluded if e.chart == chart and e.ref.defaults_scope is scope
        ),
        tweaks=tuple(
            p
            for p in tree.files_under(folder)
            if p.parent == folder and p.name.startswith("values-") and p.name.endswith(".yaml")
        ),
        access=access,
        findings=tuple(findings),
    )
