"""Zone labels over HTTP (ADR-0072's 2026-11-28 amendments): refused when given, never synced.

Each zone's NodePool labels its Nodes with its zone: a create writes it (the
logical nodepools' tests), a request or a flavor that gives the key is
refused, and an older file that lacks it is in sync, its NodePools listed as
missing the label apart from the flavor's drift; a sync never adds it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import yaml

from wingman_core.domain.users import User
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab

Auth = Callable[[User], dict[str, str]]
AZ = ["r760-mtl-az1", "r760-mtl-az2"]
ZONE = "topology.kubernetes.io/zone"
NAME = "ocp4-prod-osprey-site1"
FILE = f"sites/site1/mces/ocp4-prod-mce-site1-a/hostedClusters/{NAME}.yaml"


def flavor(pool: dict[str, Any], *locked: str) -> dict[str, Any]:
    return {
        "apiVersion": "wingman.io/v1",
        "kind": "ClusterSpec",
        "metadata": {"name": "agent-labelled", "version": "1.0.0"},
        "spec": {
            "day1": {"values": {"nodepools": [pool]}, "locked_paths": list(locked)},
            "day2": {"addons": []},
        },
    }


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


async def test_a_request_or_a_flavor_that_gives_the_zone_label_is_refused(
    client: httpx.AsyncClient, auth: Auth, support: Any
) -> None:
    alice = auth(support.ALICE)
    body = support.create_body()
    zones = [{"infra_env": z, "replicas": 1} for z in AZ]
    body["variables"]["nodepools"] = [
        {"node_type": "r760-mtl", "zones": zones, "node_labels": {ZONE: "az1"}}
    ]
    refused = problems(await client.post("/api/day1/clusters/preview", json=body, headers=alice))
    assert (
        f"nodepools[0].node_labels: {ZONE} is Wingman's, each NodePool's own zone "
        f"({AZ[0]}: az1, {AZ[1]}: az2); leave it out"
    ) in refused
    preset = flavor({"node_type": "r760-mtl", "node_labels": {ZONE: "az1"}})
    assert problems(await client.post("/api/day1/specs", json=preset, headers=alice)) == [
        f"nodepools[0].node_labels: {ZONE} is each zone's NodePool's own, which Wingman writes "
        "at create; a flavor does not set it"
    ]


def older_file(tiers: list[str]) -> str:
    return (
        '# specName: "agent-labelled"\n# specVersion: "1.0.0"\n'
        'owner:\n  merkaz: "1234"\n  anaf: "56"\n  mador: "7"\nmastertag: 4.18.56-x86_64\n'
        "nodepool:\n"
        + "".join(
            f"- infraEnvName: {z}\n  name: {z}\n  replicas: 1\n  nodeLabels:\n    tier: {tier}\n"
            for z, tier in zip(AZ, tiers, strict=True)
        )
    )


async def test_an_older_file_without_zone_labels_is_in_sync_and_a_sync_adds_none(
    client: httpx.AsyncClient, auth: Auth, support: Any, gitlab: InMemoryGitLab
) -> None:
    stored = flavor(
        {"node_type": "r760-mtl", "node_labels": {"tier": "gpu"}}, "nodepools[0].node_labels"
    )
    await push(client, support, gitlab, "specs/agent-labelled.yaml", yaml.safe_dump(stored))
    await push(client, support, gitlab, FILE, older_file(["gpu", "gpu"]))
    drift = (
        await client.get(f"/api/day1/clusters/{NAME}/drift", headers=auth(support.VIEWER))
    ).json()
    assert (drift["state"], drift["value_drift"]) == ("in_sync", []), "never drift"
    assert drift["missing_zone_labels"] == [
        {"nodepool": {"index": i, "name": z}, "zone": z[-3:]} for i, z in enumerate(AZ)
    ]
    assert "zone_labels" not in drift, "renamed in 3.72"
    preview = await client.post(
        f"/api/day1/clusters/{NAME}/sync/preview", json={}, headers=auth(support.ALICE)
    )
    assert preview.status_code == 200, preview.text
    plan = preview.json()
    assert (plan["diff"], plan["can_sync"]) == ("", False), "nothing to sync for a zone label"
    assert not any(ZONE in w for w in plan["warnings"])

    await push(client, support, gitlab, FILE, older_file(["cpu", "gpu"]))
    plan = (
        await client.post(
            f"/api/day1/clusters/{NAME}/sync/preview", json={}, headers=auth(support.ALICE)
        )
    ).json()
    added = [line[1:].strip() for line in plan["diff"].splitlines() if line.startswith("+ ")]
    assert added == ['nodeLabels: {"tier": "gpu"}'], "the flavor's labels, no zone added"
    assert not any(ZONE in w for w in plan["warnings"])
