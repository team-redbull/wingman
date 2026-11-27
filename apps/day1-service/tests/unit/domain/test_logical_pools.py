"""A cluster file's NodePools as logical nodepools, and a flavor's drift on them (ADR-0072)."""

from __future__ import annotations

from typing import Any

from wingman_core.domain.git import RepoPath
from wingman_core.testing.fixtures import default_fixture_root
from wingman_day1.domain.locks import InputPath, Lock
from wingman_day1.domain.logical_pools import (
    LogicalPool,
    flavor_positions,
    logical_key,
    logical_pools,
)
from wingman_day1.domain.machine_configs import MachineConfigCatalog
from wingman_day1.domain.value_drift import ValueDrift, value_drift

MC_FILES = default_fixture_root() / "gitops-day1" / "platform-config" / "mc-files"
CATALOG = MachineConfigCatalog.from_files(
    RepoPath(f"mc-files/{p.relative_to(MC_FILES).as_posix()}")
    for p in MC_FILES.rglob("*")
    if p.is_file()
)
AZ = ["r760-mtl-az1", "r760-mtl-az2", "r760-mtl-az3"]
KUBELET = [{"name": "worker-kubeletconfig-reserved"}]


def entry(infra_env: str, name: str | None = None, **keys: Any) -> dict[str, Any]:
    found: dict[str, Any] = {"infraEnvName": infra_env, "replicas": 2, **keys}
    if name is not None:
        found["name"] = name
    return found


def spread(suffix: str = "", **keys: Any) -> list[dict[str, Any]]:
    return [entry(z, f"{z}-{suffix}" if suffix else z, **keys) for z in AZ]


def test_a_nodepool_is_its_node_type_and_suffix() -> None:
    assert logical_key(entry(AZ[0], AZ[0])) == ("r760-mtl", "")
    assert logical_key(entry(AZ[1], f"{AZ[1]}-gpu")) == ("r760-mtl", "gpu")
    assert logical_key(entry(AZ[2])) == ("r760-mtl", ""), "a derived name has no suffix"
    assert logical_key(entry(AZ[0], "prod-heron-site1-dell-b")) is None, "named off the rule"
    assert logical_key({"replicas": 2}) is None, "draws from no InfraEnv"


def test_the_zones_of_one_node_type_and_suffix_are_one_logical_nodepool_in_first_seen_order() -> (
    None
):
    entries = [*spread("gpu"), entry("g12-mtl-az1"), *spread(), entry(AZ[0], "odd-name"), "x"]
    assert logical_pools(entries) == (
        LogicalPool("r760-mtl", "gpu", (0, 1, 2)),
        LogicalPool("g12-mtl", "", (3,)),
        LogicalPool("r760-mtl", "", (4, 5, 6)),
        LogicalPool(None, "", (7,)),
        LogicalPool(None, "", (8,)),
    )


def test_a_flavors_positions_are_logical_unless_the_file_has_fewer_groups() -> None:
    zoned = [*spread(), entry("g12-mtl-az1")]
    assert flavor_positions(zoned, 2) == {0: (0, 1, 2), 1: (3,)}
    assert flavor_positions(zoned, 1) == {0: (0, 1, 2), 1: (3,)}
    old = spread()  # one InfraEnv per position, from a flavor that preset each zone
    assert flavor_positions(old, 3) == {0: (0,), 1: (1,), 2: (2,)}
    assert flavor_positions(old, None) == {0: (0,), 1: (1,), 2: (2,)}


def drift(locks: list[Lock], pools: list[dict[str, Any]], flavor: int) -> tuple[ValueDrift, ...]:
    values = {"nodepool": pools}
    return value_drift(
        locks, values, cluster_name="prod-x-site1", catalog=CATALOG, flavor_nodepools=flavor
    )


def lock(path: str, value: object) -> Lock:
    return Lock(InputPath.parse(path), value)


def test_a_zone_spread_cluster_holding_its_flavor_has_no_drift() -> None:
    locks = [lock("nodepools[0].configs", KUBELET), lock("nodepools[1].replicas", 3)]
    pools = [*spread(configs=KUBELET), entry("g12-mtl-az1", "g12-mtl-az1", replicas=3)]
    assert drift(locks, pools, 2) == ()


def test_a_lock_holds_on_every_zone_and_a_sync_sets_the_one_that_differs() -> None:
    locks = [lock("nodepools[0].configs", KUBELET), lock("nodepools[0].node_labels", {"a": "b"})]
    pools = spread(configs=KUBELET, nodeLabels={"a": "b"})
    pools[1]["configs"] = []
    del pools[2]["nodeLabels"]
    found = drift(locks, pools, 1)
    assert [(str(d.file_key), d.nodepool.name if d.nodepool else None) for d in found] == [
        ("nodepool[1].configs", AZ[1]),
        ("nodepool[2].nodeLabels", AZ[2]),
    ]


def test_a_cluster_made_before_logical_nodepools_keeps_one_entry_per_position() -> None:
    locks = [lock(f"nodepools[{i}].replicas", 2 + i) for i in range(3)]
    pools = [entry(z, z, replicas=2 + i) for i, z in enumerate(AZ)]
    assert drift(locks, pools, 3) == ()
    missing = drift([lock("nodepools[3].replicas", 1)], pools, 4)
    assert [d.needs_decision for d in missing] == [
        "the cluster has no nodepool[3]; sync does not add nodepools"
    ]
