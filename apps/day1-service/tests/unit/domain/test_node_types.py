"""Node types: an InfraEnv without its zone, the zone from the hub's label or name (ADR-0072)."""

from __future__ import annotations

import pytest

from wingman_day1.domain.infra_env_pools import InfraEnvObservation
from wingman_day1.domain.kv_clusters import ZONE_LABEL
from wingman_day1.domain.node_types import (
    InfraEnvName,
    NodeType,
    Placed,
    Zone,
    node_type_of,
    node_types,
    parse,
    split,
    zone_of,
)

LEGACY = "dell-r660-site1-128c-1024gb-5tb"


@pytest.mark.parametrize(
    ("name", "parsed"),
    [
        ("r760-mtl-az1", InfraEnvName("r760", "mtl", "az1")),
        ("c200-kv32-az2", InfraEnvName("c200", "kv32", "az2")),
        (LEGACY, None),
        ("r760-mtl", None),
        ("r760-gpu-az1", None),
        ("R760-mtl-az1", None),
    ],
)
def test_the_convention_is_flavor_size_zone(name: str, parsed: InfraEnvName | None) -> None:
    assert parse(name) == parsed


def test_the_node_type_is_the_name_without_its_zone() -> None:
    assert split("r760-mtl-az1") == Placed("r760-mtl", "az1")
    assert node_type_of("c200-kv32-az2") == "c200-kv32"


def test_a_name_off_the_convention_is_its_own_node_type_in_an_unnamed_zone() -> None:
    assert split(LEGACY) == Placed(LEGACY, None)


def test_the_zone_is_the_hubs_label_else_the_names() -> None:
    assert zone_of("r760-mtl-az1") == "az1"
    assert zone_of("r760-mtl-az1", {ZONE_LABEL: "az1"}) == "az1"
    assert zone_of(LEGACY, {ZONE_LABEL: "az2"}) == "az2", "the label names a legacy InfraEnv's zone"
    assert zone_of(LEGACY, {"redbull.io/flavor": "dell"}) is None
    assert zone_of("r760-mtl-az1", {ZONE_LABEL: ""}) == "az1", "an empty label names nothing"


def test_an_mces_infra_envs_make_node_types_each_with_its_zones_in_order() -> None:
    found = node_types(
        [
            InfraEnvObservation("r760-mtl-az10"),
            InfraEnvObservation("r760-mtl-az2", {ZONE_LABEL: "az2"}),
            InfraEnvObservation("r760-mtl-az1"),
            InfraEnvObservation(LEGACY, {ZONE_LABEL: "az1"}),
            InfraEnvObservation("g12-mtl-az1"),
        ]
    )
    assert found == (
        NodeType(LEGACY, (Zone("az1", LEGACY),)),
        NodeType("g12-mtl", (Zone("az1", "g12-mtl-az1"),)),
        NodeType(
            "r760-mtl",
            (
                Zone("az1", "r760-mtl-az1"),
                Zone("az2", "r760-mtl-az2"),
                Zone("az10", "r760-mtl-az10"),
            ),
        ),
    )


def test_no_infra_envs_make_no_node_types() -> None:
    assert node_types([]) == ()
