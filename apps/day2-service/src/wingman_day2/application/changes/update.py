"""Update: a chart's values on one cluster, guarded by the caller's read, and its pin when asked."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from wingman_core.domain.errors import RevisionConflictError
from wingman_core.domain.git import FileChange
from wingman_day2.application.apps import LoadedLayer, deploy_of
from wingman_day2.application.changes.plan import ChangePlan
from wingman_day2.application.installed import override_layer
from wingman_day2.domain.deploy_config import TARGET_REVISION
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.findings import Rule, warning
from wingman_day2.domain.platform import AppSource, PlannedApp
from wingman_day2.domain.yaml_values import dump_values, parse_values
from wingman_day2.ports import SigsRepository


async def plan_values(
    sigs: SigsRepository,
    plan: ChangePlan,
    app: PlannedApp,
    values: Mapping[str, object],
    last_commit_id: str | None,
) -> None:
    """Write ``values`` to the app's override file, guarded by ``last_commit_id`` (ADR-0006)."""
    path = override_layer(app).path
    current = await sigs.read(plan.state.team, path)
    content = dump_values(values)
    if current is None:
        if last_commit_id:
            raise RevisionConflictError(f"{path} was deleted since {last_commit_id[:8]}")
        if values or app.source is AppSource.CLUSTER:
            plan.changes.append(FileChange.create(path, content))
        return
    guard = last_commit_id or current.last_commit_id
    existing, problem = parse_values(current.content, path=str(path))
    if app.source is AppSource.FLEET_DEFAULT and not values:
        plan.changes.append(FileChange.delete(path, last_commit_id=guard))
    elif problem is not None or existing != dict(values):
        plan.changes.append(FileChange.update(path, content, last_commit_id=guard))


def plan_pin(
    plan: ChangePlan,
    app: PlannedApp,
    layers: Sequence[LoadedLayer],
    version: str,
    *,
    emergency_pin: bool,
) -> None:
    """Pin the app to ``version`` for this cluster only, or drop a pin it no longer needs."""
    tree = plan.state.repo.tree
    current = deploy_of(app, tuple(layers), tree).leaf.target_revision
    if version == current:
        return
    if app.source is AppSource.FLEET_DEFAULT:
        raise ChangeRefusedError(
            f"{app.chart} reaches {app.ref.name} as a fleet default, which cannot be pinned "
            "for one cluster: its revision comes from the default, the Sig values or an "
            "OCP-version pin",
            details={"rule": "fleet-default-pin"},
        )
    own = layers[-1]
    inherited = deploy_of(app, tuple(layers[:-1]), tree).leaf.target_revision
    doc = dict(own.values)
    if version == inherited:
        doc.pop(TARGET_REVISION, None)
    elif not emergency_pin:
        raise ChangeRefusedError(
            f"{version} differs from the inherited {inherited}: writing it is an emergency "
            "pin; ask for it explicitly with emergency_pin",
            details={
                "rule": "emergency-pin-required",
                "inherited": inherited,
                "requested": version,
            },
        )
    else:
        doc[TARGET_REVISION] = version
        plan.findings.append(
            warning(
                Rule.EMERGENCY_PIN,
                f"pins {app.chart} to {version} on {app.ref.name} only (an emergency pin)",
                team=app.team,
                cluster=app.ref.id,
                chart=app.chart,
            )
        )
    path = own.layer.path
    if own.file is None:
        plan.changes.append(FileChange.create(path, dump_values(doc)))
    elif doc:
        plan.changes.append(
            FileChange.update(path, dump_values(doc), last_commit_id=own.file.last_commit_id)
        )
    else:
        plan.changes.append(FileChange.delete(path, last_commit_id=own.file.last_commit_id))
