"""A logical nodepool on the create form: a node type, one config, a NodePool per zone."""

from __future__ import annotations

from typing import Any, cast

from wingman_day1.domain.locks import InputPath
from wingman_day1.domain.nodepool_names import input_problems as name_problems
from wingman_day1.domain.nodepool_names import with_names
from wingman_day1.domain.sizing import sizing_problems
from wingman_day1.domain.zone_inputs import (
    flavor_problems,
    input_problems,
    lock_conflicts,
    locked_replicas,
    spread,
    zone_infra_envs,
    zone_replicas,
)

AZ = ["r760-mtl-az1", "r760-mtl-az2", "r760-mtl-az3"]
CONFIGS = [{"name": "worker-kubeletconfig-reserved"}]


def logical(*replicas: int | None, node_type: str = "r760-mtl", **more: Any) -> dict[str, Any]:
    zones = [
        {"infra_env": name} if count is None else {"infra_env": name, "replicas": count}
        for name, count in zip(AZ, replicas, strict=False)
    ]
    return {"node_type": node_type, "zones": zones, "configs": CONFIGS, **more}


def inputs(*pools: dict[str, Any]) -> dict[str, Any]:
    return {"nodepools": list(pools)}


def test_a_logical_nodepool_is_one_physical_nodepool_per_zone_with_the_same_config() -> None:
    spread_out = spread(inputs(logical(2, 0, 1, name_suffix="gpu", replicas=5)))
    assert spread_out["nodepools"] == [
        {"configs": CONFIGS, "name_suffix": "gpu", "replicas": 2, "infra_env": AZ[0]},
        {"configs": CONFIGS, "name_suffix": "gpu", "replicas": 0, "infra_env": AZ[1]},
        {"configs": CONFIGS, "name_suffix": "gpu", "replicas": 1, "infra_env": AZ[2]},
    ]
    named = cast("list[dict[str, Any]]", with_names(spread_out)["nodepools"])
    assert [p["nodepool_name"] for p in named] == [f"{z}-gpu" for z in AZ]


def test_a_zone_without_replicas_takes_the_nodepools_and_a_physical_one_drops_its_node_type() -> (
    None
):
    spread_out = spread(
        inputs(logical(None, 4, replicas=3), {"infra_env": AZ[0], "node_type": "x"})
    )
    pools = cast("list[dict[str, Any]]", spread_out["nodepools"])
    assert [(p["infra_env"], p.get("replicas")) for p in pools] == [
        (AZ[0], 3),
        (AZ[1], 4),
        (AZ[0], None),
    ]
    assert "node_type" not in pools[2]
    assert zone_replicas(logical(None, 4, replicas=3)) == [3, 4]
    assert zone_infra_envs(logical(1, 1)) == AZ[:2]
    assert zone_infra_envs({"infra_env": AZ[0]}) is None


def test_good_zones_pass() -> None:
    assert input_problems(inputs(logical(2, 0, 2))) == []
    assert input_problems(inputs({"infra_env": AZ[0], "node_type": "r760-mtl"})) == []


def test_zones_of_another_node_type_twice_or_bad_are_refused_at_their_place() -> None:
    pool = logical(2, 2, 2)
    pool["zones"][1] = {"infra_env": "r650-mtl-az2", "replicas": -1}
    pool["zones"][2] = {"infra_env": AZ[0], "replicas": 1, "extra": True}
    assert input_problems(inputs(pool)) == [
        "nodepools[0].zones[1].infra_env: r650-mtl-az2 is node type r650-mtl, not r760-mtl; "
        "every zone of a nodepool is one node type",
        "nodepools[0].zones[1].replicas: must be a whole number of at least 0",
        "nodepools[0].zones[2]: has extra; a zone gives only infra_env and replicas",
        "nodepools[0].zones: r760-mtl-az1 listed twice",
    ]


def test_a_nodepool_with_no_replica_in_any_zone_or_no_zone_is_refused() -> None:
    assert input_problems(inputs(logical(0, 0, 0))) == [
        "nodepools[0].zones: every zone has 0 replicas; a nodepool needs one at least"
    ]
    assert input_problems(inputs({"node_type": "r760-mtl", "zones": []})) == [
        "nodepools[0].zones: a nodepool spread over zones needs one at least"
    ]


def test_a_logical_nodepool_names_no_infraenv_of_its_own_and_draws_from_its_zones_only() -> None:
    pool = logical(1, infra_env=AZ[0], additional_infra_envs=["g12-mtl-az1"])
    assert input_problems(inputs(pool)) == [
        "nodepools[0].infra_env: a nodepool spread over zones names each zone's InfraEnv in "
        "zones, not infra_env",
        "nodepools[0].additional_infra_envs: a nodepool spread over zones draws from its zones "
        "only",
    ]


def test_a_node_type_needs_its_zones_or_an_infraenv_of_it() -> None:
    assert input_problems(inputs({"node_type": "r760-mtl"})) == [
        "nodepools[0].zones: node type r760-mtl needs its zones, one InfraEnv each "
        "(zones: [{infra_env, replicas}])"
    ]
    assert input_problems(inputs({"node_type": "r760-mtl", "infra_env": "g12-mtl-az1"})) == [
        "nodepools[0].infra_env: g12-mtl-az1 is node type g12-mtl, not r760-mtl"
    ]


def test_every_zone_is_held_to_a_locked_replicas() -> None:
    locked = locked_replicas([(InputPath.parse("nodepools[0].replicas"), 3)])
    assert locked == {0: 3}
    assert lock_conflicts(inputs(logical(3, None, 2)), locked, flavor="zoned") == [
        "nodepools[0].zones[2].replicas: locked by flavor zoned to 3 in every zone; the request "
        "sends 2"
    ]
    assert lock_conflicts(inputs(logical(3, 3)), locked, flavor="zoned") == []


def test_a_ratio_sizes_every_zone_of_a_sized_nodepool() -> None:
    sized = inputs(logical(2, 2, 2), logical(4, 4, node_type="g12-mtl"))
    sized["nodepools"][1]["zones"] = [{"infra_env": "g12-mtl-az1", "replicas": 4}]
    assert sizing_problems(sized, [1, 2], flavor="zoned") == []
    uneven = inputs(logical(2, 1, 2), {"infra_env": "g12-mtl-az1", "replicas": 4})
    assert sizing_problems(uneven, [1, 2], flavor="zoned") == [
        "nodepools[0].replicas: the flavor zoned sizes its nodepools 1:2, so the replicas must "
        "be 1 and 2 times one size (e.g. 2, 4); got 2+1+2, 4"
    ]


def test_each_zones_nodepool_is_named_and_a_clash_across_nodepools_is_found() -> None:
    clash = inputs(logical(1, 1, 1), {"infra_env": AZ[1], "replicas": 1})
    assert name_problems(clash) == [
        "nodepools[1].name_suffix: NodePool r760-mtl-az2 is nodepools[0]'s already; nodepools on "
        "one InfraEnv need different suffixes, and at most one may have none"
    ]
    assert name_problems(inputs(logical(1, 1, 1), logical(1, 1, 1, name_suffix="b"))) == []
    whole = name_problems(inputs(logical(1, nodepool_name="x")))
    assert whole == [
        "nodepools[0].nodepool_name: a nodepool spread over zones is named per zone from its "
        "name_suffix"
    ]
    (long,) = name_problems(inputs(logical(1, name_suffix="x" * 60)))
    assert long.startswith("nodepools[0].name_suffix: NodePool name") and long.endswith(
        "is longer than 63 characters"
    )


def test_a_flavor_presets_a_node_type_never_zones_nor_an_infraenv_beside_it() -> None:
    assert flavor_problems(inputs({"node_type": "r760-mtl"})) == []
    assert flavor_problems(
        inputs(
            {"node_type": "r760-mtl-az1"},
            {"node_type": "R760", "zones": []},
            {"node_type": "g12-mtl", "infra_env": "g12-mtl-az1"},
        )
    ) == [
        "nodepools[0].node_type: r760-mtl-az1 is an InfraEnv, node type r760-mtl in one zone; "
        "preset the node type",
        "nodepools[1].zones: a flavor presets the node type; its zones are the MCE's, given at "
        "create",
        "nodepools[1].node_type: node type 'R760' must be lowercase letters, digits and '-', "
        "starting and ending with a letter or digit",
        "nodepools[2].infra_env: a nodepool presets a node type or an InfraEnv, not both",
    ]
