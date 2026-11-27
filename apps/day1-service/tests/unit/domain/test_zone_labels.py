"""Each zone's NodePool labels its Nodes with its zone (ADR-0072's 2026-11-28 amendments).

A create labels every NodePool of a convention InfraEnv; an existing NodePool's
label is never added, changed or dropped by a sync, and one without it is listed.
"""

from __future__ import annotations

from typing import Any, cast

from wingman_core.domain.git import RepoPath
from wingman_core.testing.fixtures import default_fixture_root
from wingman_day1.domain.cluster_edits import SetValue
from wingman_day1.domain.locks import InputPath, Lock
from wingman_day1.domain.machine_configs import MachineConfigCatalog
from wingman_day1.domain.node_types import ZONE_LABEL
from wingman_day1.domain.sync_effects import sync_edits
from wingman_day1.domain.value_drift import value_drift
from wingman_day1.domain.zone_labels import (
    ZoneLabelMissing,
    flavor_problems,
    input_problems,
    rendered_problems,
    with_own_zone,
    with_zone_labels,
    zone_labels_missing,
)

LEGACY = "dell-r660-site1-128c-1024gb-5tb"
AZ = ["r760-mtl-az1", "r760-mtl-az2", "r760-mtl-az3"]
MC_FILES = default_fixture_root() / "gitops-day1" / "platform-config" / "mc-files"
CATALOG = MachineConfigCatalog.from_files(
    RepoPath(f"mc-files/{p.relative_to(MC_FILES).as_posix()}")
    for p in MC_FILES.rglob("*")
    if p.is_file()
)


def pools(*items: dict[str, Any]) -> dict[str, Any]:
    return {"nodepools": list(items)}


def test_each_convention_nodepool_gets_its_zone_beside_the_persons_labels() -> None:
    spread = with_zone_labels(
        pools(
            {"infra_env": AZ[1], "node_labels": {"tier": "gpu"}},
            {"infra_env": LEGACY, "node_labels": {"tier": "gpu"}},
            {"infra_env": "c200-mtl-az1", "node_labels": {ZONE_LABEL: "az1"}},
        )
    )
    assert [p["node_labels"] for p in cast("list[dict[str, Any]]", spread["nodepools"])] == [
        {"tier": "gpu", ZONE_LABEL: "az2"},
        {"tier": "gpu"},
        {ZONE_LABEL: "az1"},
    ], "an InfraEnv off the convention names no zone Wingman writes"


def test_a_zone_label_the_request_gives_is_refused_unless_it_is_each_nodepools_own() -> None:
    zones = [{"infra_env": z, "replicas": 1} for z in AZ]
    logical = {"node_type": "r760-mtl", "zones": zones, "node_labels": {ZONE_LABEL: "az1"}}
    assert input_problems(
        pools(
            logical,
            {"infra_env": AZ[1], "node_labels": {ZONE_LABEL: "az1"}},
            {"infra_env": AZ[2], "node_labels": {ZONE_LABEL: "az3"}},
            {"infra_env": LEGACY, "node_labels": {ZONE_LABEL: "east"}},
        )
    ) == [
        f"nodepools[0].node_labels: {ZONE_LABEL} is Wingman's, each NodePool's own zone "
        f"({AZ[0]}: az1, {AZ[1]}: az2, {AZ[2]}: az3); leave it out",
        f"nodepools[1].node_labels: {ZONE_LABEL} is Wingman's, each NodePool's own zone "
        f"({AZ[1]}: az2); leave it out",
    ]


def test_a_flavor_never_sets_the_zone_label() -> None:
    assert flavor_problems(
        pools({"node_type": "r760-mtl", "node_labels": {ZONE_LABEL: "az1"}})
    ) == [
        f"nodepools[0].node_labels: {ZONE_LABEL} is each zone's NodePool's own, which Wingman "
        "writes at create; a flavor does not set it"
    ]
    assert flavor_problems(pools({"node_labels": {"tier": "gpu"}})) == []


def test_the_rendered_file_must_label_each_nodepool_with_its_zone() -> None:
    inputs = with_zone_labels(pools({"infra_env": AZ[0]}, {"infra_env": LEGACY}))
    assert rendered_problems(inputs, {"nodepool": [{"nodeLabels": {ZONE_LABEL: "az1"}}, {}]}) == []
    (problem,) = rendered_problems(inputs, {"nodepool": [{"infraEnvName": AZ[0]}, {}]})
    assert problem.startswith(f"nodepool[0].nodeLabels: the template wrote no {ZONE_LABEL}: az1")


def entry(infra_env: str, labels: dict[str, str] | None = None, name: str | None = None) -> dict:
    found: dict[str, Any] = {"infraEnvName": infra_env, "name": name or infra_env, "replicas": 1}
    if labels is not None:
        found["nodeLabels"] = labels
    return found


def drift(locks: list[Lock], file: list[dict[str, Any]], flavor: int = 1) -> tuple:
    return value_drift(
        locks, {"nodepool": file}, cluster_name="x", catalog=CATALOG, flavor_nodepools=flavor
    )


LOCK = Lock(InputPath.parse("nodepools[0].node_labels"), {"tier": "gpu"})


def test_the_zone_label_is_never_a_flavors_drift() -> None:
    held = [entry(z, {"tier": "gpu", ZONE_LABEL: z[-3:]}) for z in AZ]
    assert drift([LOCK], held) == ()
    older = [entry(z, {"tier": "gpu"}) for z in AZ]
    assert drift([LOCK], older) == (), "a cluster made before: no false drift"


def test_a_sync_of_drifted_labels_keeps_each_zone_label_the_file_has_and_adds_none() -> None:
    file = [entry(AZ[0], {"tier": "cpu", ZONE_LABEL: "az1"}), entry(AZ[1], {"tier": "cpu"})]
    found = drift([LOCK], file)
    assert [(str(d.file_key), d.flavor_value) for d in found] == [
        ("nodepool[0].nodeLabels", {"tier": "gpu", ZONE_LABEL: "az1"}),
        ("nodepool[1].nodeLabels", {"tier": "gpu"}),
    ], "an existing NodePool's zone label is never added"
    legacy = drift([LOCK], [entry(LEGACY, {"tier": "cpu", ZONE_LABEL: "east"})])
    assert [d.flavor_value for d in legacy] == [{"tier": "gpu", ZONE_LABEL: "east"}], "nor dropped"
    assert drift([LOCK], [entry(LEGACY, {"tier": "gpu", ZONE_LABEL: "east"})]) == (), "nor drift"
    wrong = drift([LOCK], [entry(AZ[1], {"tier": "cpu", ZONE_LABEL: "az1"})])
    assert [d.flavor_value for d in wrong] == [{"tier": "gpu", ZONE_LABEL: "az1"}], "nor changed"


def test_with_own_zone_never_adds_a_zone_label() -> None:
    assert with_own_zone({"tier": "gpu"}, {"tier": "cpu"}) == {"tier": "gpu"}
    assert with_own_zone({"tier": "gpu"}, None) == {"tier": "gpu"}
    assert with_own_zone({}, {ZONE_LABEL: "az2"}) == {ZONE_LABEL: "az2"}


def test_a_sync_adds_no_zone_label_and_the_missing_ones_are_listed() -> None:
    values = {
        "nodepool": [
            entry(AZ[0], {"tier": "gpu"}),
            entry(AZ[1], name=f"{AZ[1]}-b"),
            {"infraEnvName": AZ[2], "replicas": 1},
            entry(AZ[2], {ZONE_LABEL: "az3"}),
            entry(LEGACY),
        ]
    }
    assert sync_edits([]) == [], "a sync never changes an existing NodePool for its zone"
    assert zone_labels_missing(values, cluster_name="x") == (
        ZoneLabelMissing(0, AZ[0], "az1"),
        ZoneLabelMissing(1, f"{AZ[1]}-b", "az2"),
        ZoneLabelMissing(2, f"x-{AZ[2]}", "az3"),
    ), "a convention InfraEnv's NodePool without its zone, by its rendered name"


def test_a_nodepool_whose_labels_a_sync_sets_gets_no_zone_from_that_edit() -> None:
    values = {"nodepool": [entry(AZ[0], {"tier": "cpu"})]}
    assert sync_edits(drift([LOCK], values["nodepool"])) == [
        SetValue(InputPath(("nodepool", 0, "nodeLabels")), {"tier": "gpu"})
    ]
