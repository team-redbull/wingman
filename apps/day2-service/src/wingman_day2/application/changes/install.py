"""Install: a chart's files in a cluster's own folder, and the deploy-config keys it must set."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from wingman_core.domain.errors import GitError
from wingman_core.domain.git import FileChange, FileContent, RepoPath
from wingman_day2.application.apps import LoadedLayer, deploy_of, load_layers
from wingman_day2.application.changes.plan import ChangePlan, ChangeResult, check_chart_name
from wingman_day2.application.preview import team_version
from wingman_day2.application.topology import TeamState
from wingman_day2.domain import layout
from wingman_day2.domain.clusters import ClusterKind, ClusterRef
from wingman_day2.domain.deploy_config import (
    PROJECT_NAMESPACE,
    REPOURL,
    TARGET_REVISION,
    LeafApplication,
)
from wingman_day2.domain.errors import (
    ChangeRefusedError,
    ChartAlreadyInstalledError,
    UnknownChartError,
)
from wingman_day2.domain.findings import Rule, warning
from wingman_day2.domain.platform import AppSource, PlannedApp, scope_exclusions
from wingman_day2.domain.stacks import Layer, LayerRole
from wingman_day2.domain.tree import RepoTree
from wingman_day2.domain.yaml_values import dump_values
from wingman_day2.ports import SigsRepository

_PENDING = "(this change)"


@dataclass(frozen=True, slots=True)
class InstallSpec:
    """One chart to install. ``version`` other than the inherited one needs ``emergency_pin``."""

    team: str
    chart: str
    values: Mapping[str, object] = field(default_factory=dict)
    version: str | None = None
    emergency_pin: bool = False
    repourl: str | None = None
    project_namespace: str | None = None


@dataclass(frozen=True, slots=True)
class BulkResult:
    """One MR per team; ``failed`` holds the teams whose MR could not be opened."""

    results: tuple[ChangeResult, ...]
    failed: tuple[tuple[str, GitError], ...]


async def plan_install(sigs: SigsRepository, plan: ChangePlan, spec: InstallSpec) -> None:
    """Add one chart's files to ``plan``, or raise why it cannot be installed."""
    state, ref = plan.state, plan.summary.ref
    tree = plan.tree
    chart = check_chart_name(spec.chart)
    folder = layout.chart_dir(ref, chart)
    if tree.is_dir(folder):
        raise ChartAlreadyInstalledError(
            f"{folder}/ exists already in {state.team.name}; update it instead",
            details={"rule": "installed", "team": state.team.name, "path": str(folder)},
        )
    if not tree.is_dir(layout.operators_dir(chart)) and not spec.repourl:
        raise UnknownChartError(
            f"{state.team.name} has no operators/{chart}/; give a repourl to install a chart "
            "that has no Sig values",
            details={"team": state.team.name, "chart": chart},
        )
    _check_xor(state, ref, chart, tree)
    app = PlannedApp(
        state.team.name, ref, chart, AppSource.CLUSTER, team_version(state, plan.summary)
    )
    inherited_layers = await load_layers(sigs, state.team, tree, app.deploy_config_layers[:-1])
    inherited = deploy_of(app, inherited_layers, tree).leaf
    overrides = _install_overrides(app, inherited, spec, plan)
    own = app.deploy_config_layers[-1].path
    new_layers = [*inherited_layers]
    if overrides:
        plan.changes.append(FileChange.create(own, dump_values(overrides)))
        new_layers.append(_pending(own, overrides, LayerRole.CLUSTER))
    plan.changes.append(
        FileChange.create(folder.child(layout.VALUES_FILE), dump_values(spec.values))
    )
    leaf = deploy_of(app, tuple(new_layers), tree).leaf
    plan.charts.append(chart)
    plan.leaves.append(leaf)


def _check_xor(state: TeamState, ref: ClusterRef, chart: str, tree: RepoTree) -> None:
    if ref.kind is ClusterKind.HUB:
        return
    fleet = layout.defaults_dir(ref.defaults_scope).child(chart)
    if not tree.is_dir(fleet):
        return
    exclusions = scope_exclusions(state.repo, ref.defaults_scope)
    if exclusions is not None and chart in exclusions.excluded_charts(ref.exclusion_key or ""):
        return
    tweak = fleet.child(f"values-{ref.exclusion_key}.yaml")
    raise ChartAlreadyInstalledError(
        f"{chart} is a fleet default of {state.team.name} ({fleet}/), so it is deployed to "
        f"{ref.name} already; a chart folder for it would generate the same app twice (the "
        f"XOR rule). Its values for this cluster go in {tweak}.",
        details={
            "rule": "xor",
            "team": state.team.name,
            "fleet_default": str(fleet),
            "tweak": str(tweak),
        },
    )


def _install_overrides(
    app: PlannedApp, inherited: LeafApplication, spec: InstallSpec, plan: ChangePlan
) -> dict[str, object]:
    """The deploy-config keys the cluster folder must set; empty when it needs no file."""
    overrides: dict[str, object] = {}
    if spec.repourl and spec.repourl != inherited.repo_url:
        overrides[REPOURL] = spec.repourl
    elif not inherited.repo_url:
        raise ChangeRefusedError(
            f"no layer of {app.chart}'s deploy config sets a lowercase repourl (check "
            f"operators/{app.chart}/{app.chart}.yaml for `repoUrl`), so the app would render "
            "with an empty repoURL; give repourl to set it for this cluster",
            details={"rule": str(Rule.REPOURL_MISSING), "chart": app.chart},
        )
    if spec.project_namespace and spec.project_namespace != (inherited.destination_namespace or ""):
        overrides[PROJECT_NAMESPACE] = spec.project_namespace
    if spec.version and spec.version != inherited.target_revision:
        if not spec.emergency_pin:
            raise ChangeRefusedError(
                f"{app.ref.name} would get {app.chart} at {inherited.target_revision} (its "
                f"Sig values or their OCP-version pin). Writing {spec.version} into the "
                "cluster folder is an emergency pin that detaches it from every future "
                "upgrade; ask for it explicitly with emergency_pin, or change the pin in "
                f"operators/{app.chart}/",
                details={
                    "rule": "emergency-pin-required",
                    "inherited": inherited.target_revision,
                    "requested": spec.version,
                },
            )
        overrides[TARGET_REVISION] = spec.version
        plan.findings.append(
            warning(
                Rule.EMERGENCY_PIN,
                f"pins {app.chart} to {spec.version} on {app.ref.name} only: an emergency pin; "
                "remove it once the add-on's own version or an ocp-versions/ pin catches up",
                team=app.team,
                cluster=app.ref.id,
                chart=app.chart,
            )
        )
    return overrides


def _pending(path: RepoPath, values: Mapping[str, object], role: LayerRole) -> LoadedLayer:
    return LoadedLayer(
        Layer(role, path), FileContent(path, _PENDING, dump_values(values), ""), dict(values)
    )
