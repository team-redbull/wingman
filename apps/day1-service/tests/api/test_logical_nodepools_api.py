"""Logical nodepools over HTTP (ADR-0072): a flavor's node type, a create per zone, drift, sync.

A flavor presets a node type; a create sends the nodepool's zones, each with
its replicas, and day1 writes one NodePool per zone with the same config. The
file then measures against the flavor by its logical nodepools: no drift
while every zone holds the lock, one zone's difference when one does not.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import yaml

from wingman_core.domain.git import RepoPath
from wingman_core.domain.users import User
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab
from wingman_day1.infrastructure.fakes.provision import FakeProvisionWorkflow

Auth = Callable[[User], dict[str, str]]
AZ = ["r760-mtl-az1", "r760-mtl-az2", "r760-mtl-az3"]
KUBELET = [{"name": "worker-kubeletconfig-reserved"}]
NAME = "ocp4-prod-falcon-site1"


def flavor(pool: dict[str, Any], *locked: str, name: str = "agent-zoned") -> dict[str, Any]:
    return {
        "apiVersion": "wingman.io/v1",
        "kind": "ClusterSpec",
        "metadata": {"name": name, "version": "1.0.0"},
        "spec": {
            "day1": {"values": {"nodepools": [pool]}, "locked_paths": list(locked)},
            "day2": {"addons": []},
        },
    }


def zoned(support: Any, *replicas: int, spec: str = "agent-zoned", **more: Any) -> dict[str, Any]:
    body = support.create_body(spec_name=spec, spec_version="1.0.0")
    zones = [{"infra_env": z, "replicas": r} for z, r in zip(AZ, replicas, strict=False)]
    pool = {"node_type": "r760-mtl", "zones": zones, "configs": KUBELET, **more}
    body["variables"]["nodepools"] = [pool]
    return body


def problems(response: httpx.Response) -> list[str]:
    assert response.status_code == 422, response.text
    return response.json()["details"]["problems"]


async def push(
    client: httpx.AsyncClient, support: Any, gitlab: InMemoryGitLab, file: str, text: str
) -> None:
    """Commit outside Wingman, then tell it, as GitLab's push webhook does."""
    project = support.SPECS if file.startswith("specs/") else support.DAY1
    await support.push(gitlab, project, branch="main", file=file, content=text)
    await client.post(
        "/api/webhooks/gitlab",
        json={"project": {"id": await support.project_id(gitlab, project)}},
        headers={"X-Gitlab-Token": "test-webhook-secret", "X-Gitlab-Event": "Push Hook"},
    )


async def test_a_flavor_presets_a_node_type_and_never_its_zones(
    client: httpx.AsyncClient, auth: Auth, support: Any
) -> None:
    alice = auth(support.ALICE)
    saved = await client.post(
        "/api/day1/specs", json=flavor({"node_type": "r760-mtl"}), headers=alice
    )
    assert saved.status_code == 201, saved.text
    zones = flavor({"node_type": "r760-mtl", "zones": [{"infra_env": AZ[0]}]}, name="agent-z")
    assert problems(await client.post("/api/day1/specs", json=zones, headers=alice)) == [
        "nodepools[0].zones: a flavor presets the node type; its zones are the MCE's, given at "
        "create"
    ]


async def test_a_create_writes_one_nodepool_per_zone_with_one_config_and_each_zones_replicas(
    client: httpx.AsyncClient,
    auth: Auth,
    support: Any,
    provision: FakeProvisionWorkflow,
    gitlab: InMemoryGitLab,
) -> None:
    alice = auth(support.ALICE)
    stored = flavor({"node_type": "r760-mtl", "configs": KUBELET}, "nodepools[0].configs")
    await push(client, support, gitlab, "specs/agent-zoned.yaml", yaml.safe_dump(stored))
    body = zoned(support, 2, 0, 1, name_suffix="gpu", node_labels={"tier": "gpu"})
    created = await client.post("/api/day1/clusters", json=body, headers=alice)
    assert created.status_code == 202, created.text
    written = yaml.safe_load(provision.starts[-1]["content"])["nodepool"]
    assert [(p["infraEnvName"], p["name"], p["replicas"]) for p in written] == [
        (AZ[0], f"{AZ[0]}-gpu", 2),
        (AZ[1], f"{AZ[1]}-gpu", 0),
        (AZ[2], f"{AZ[2]}-gpu", 1),
    ]
    assert all(p["configs"] == KUBELET and p["nodeLabels"] == {"tier": "gpu"} for p in written)
    assert not any("zones" in p or "node_type" in p for p in written)

    file = await support.provisioned(gitlab, provision.starts[-1])
    text = (
        await gitlab.read_file(
            await support.project_id(gitlab, support.DAY1), RepoPath(file), "main"
        )
    ).content
    await push(client, support, gitlab, file, text)  # the merge, as the webhook tells it
    viewer = auth(support.VIEWER)
    drift = (await client.get(f"/api/day1/clusters/{NAME}/drift", headers=viewer)).json()
    assert (drift["state"], drift["value_drift"]) == ("in_sync", []), "three zones, one lock"

    edited = text.replace(
        f"name: {AZ[1]}-gpu", f"name: {AZ[1]}-gpu\n    tuningConfig: x", 1
    ).replace("worker-kubeletconfig-reserved", "nic-ring-buffer", 2)
    await push(client, support, gitlab, file, edited)
    drift = (await client.get(f"/api/day1/clusters/{NAME}/drift", headers=viewer)).json()
    assert [(d["file_key"], d["nodepool"]["name"]) for d in drift["value_drift"]] == [
        ("nodepool[0].configs", f"{AZ[0]}-gpu"),
        ("nodepool[1].configs", f"{AZ[1]}-gpu"),
    ], "the zones that left the lock, each by its NodePool"
    preview = await client.post(f"/api/day1/clusters/{NAME}/sync/preview", json={}, headers=alice)
    assert preview.status_code == 200, preview.text
    assert preview.json()["can_sync"] is True


async def test_every_zone_holds_a_locked_replicas_and_a_zone_set_cluster_needs_a_replica(
    client: httpx.AsyncClient, auth: Auth, support: Any, gitlab: InMemoryGitLab
) -> None:
    alice = auth(support.ALICE)
    stored = flavor({"node_type": "r760-mtl", "replicas": 3}, "nodepools[0].replicas")
    await push(client, support, gitlab, "specs/agent-zoned.yaml", yaml.safe_dump(stored))
    uneven = zoned(support, 3, 2, 3)
    assert problems(
        await client.post("/api/day1/clusters/preview", json=uneven, headers=alice)
    ) == [
        "nodepools[0].zones[1].replicas: locked by flavor agent-zoned to 3 in every zone; the "
        "request sends 2"
    ]
    none = zoned(support, 0, 0, 0, spec="agent-standard")
    assert "nodepools[0].zones: every zone has 0 replicas; a nodepool needs one at least" in (
        problems(await client.post("/api/day1/clusters/preview", json=none, headers=alice))
    )
