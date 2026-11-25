"""A NodePool's name over HTTP (ADR-0071): the form, a create, a flavor, an edit.

A new NodePool is named ``<InfraEnv>`` or ``<InfraEnv>-<suffix>``: the form
offers the suffix, day1 composes the name and the fixture template writes it.
An existing NodePool keeps its name, derived (``<clusterName>-<infraEnvName>``,
as the fixtures' lark has) or written (heron's ``prod-heron-site1-dell-b``).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import yaml

from wingman_core.domain.users import User
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab
from wingman_core.testing.fixtures import default_fixture_root
from wingman_day1.domain.nodepool_names import GUIDE, NAME_INPUT, SUFFIX_INPUT
from wingman_day1.infrastructure.fakes.provision import FakeProvisionWorkflow

Auth = Callable[[User], dict[str, str]]
DELL, HP = "dell-r660-site1-128c-1024gb-5tb", "hp-gen11-site1-64c"
LARK = "/api/day1/clusters/ocp4-prod-lark-site1"
HERON = "/api/day1/clusters/ocp4-prod-heron-site1"
TEMPLATE = (default_fixture_root() / "wingman/cluster-specs/cluster-template.j2").read_text()
_START = TEMPLATE.index('{% if np.nodepool_name | default("") %}')
OLD_TEMPLATE = TEMPLATE[:_START] + TEMPLATE[TEMPLATE.index("{% endif %}", _START) + 12 :]


def create(support: Any, *suffixes: str | None, infra_envs: tuple[str, ...] = (DELL, HP)) -> dict:
    body = support.create_body()
    pools = support.nodepools(*infra_envs)
    for pool, suffix in zip(pools, suffixes, strict=False):
        if suffix is not None:
            pool[SUFFIX_INPUT] = suffix
    body["variables"]["nodepools"] = pools
    return body


def flavor(pool: dict[str, Any]) -> dict[str, Any]:
    return {
        "apiVersion": "wingman.io/v1",
        "kind": "ClusterSpec",
        "metadata": {"name": "agent-zoned", "version": "1.0.0"},
        "spec": {"day1": {"values": {"nodepools": [pool]}}, "day2": {"addons": []}},
    }


def problems(response: httpx.Response) -> list[str]:
    assert response.status_code == 422, response.text
    return response.json()["details"]["problems"]


async def modify(
    client: httpx.AsyncClient, headers: dict[str, str], path: str, edit: Callable[[str], str]
) -> httpx.Response:
    cluster = (await client.get(path, headers=headers)).json()
    return await client.patch(
        path,
        json={"updated_yaml": edit(cluster["yaml"]), "last_commit_id": cluster["last_commit_id"]},
        headers=headers,
    )


# ── The form and a create ────────────────────────────────────────────────────


async def test_the_form_offers_a_suffix_and_a_create_names_each_nodepool_after_its_infraenv(
    client: httpx.AsyncClient, auth: Auth, support: Any, provision: FakeProvisionWorkflow
) -> None:
    schema = (
        await client.get("/api/day1/specs/template/schema", headers=auth(support.VIEWER))
    ).json()
    fields = [f["name"] for f in next(f for f in schema if f["name"] == "nodepools")["fields"]]
    assert SUFFIX_INPUT in fields and NAME_INPUT not in fields
    body = create(support, None, "gpu", infra_envs=(DELL, DELL, HP))
    created = await client.post("/api/day1/clusters", json=body, headers=auth(support.ALICE))
    assert created.status_code == 202, created.text
    written = yaml.safe_load(provision.starts[-1]["content"])["nodepool"]
    assert [(p["infraEnvName"], p["name"]) for p in written] == [
        (DELL, DELL),
        (DELL, f"{DELL}-gpu"),
        (HP, HP),
    ]


async def test_names_that_break_the_rule_are_refused_at_their_field(
    client: httpx.AsyncClient, auth: Auth, support: Any
) -> None:
    alice = auth(support.ALICE)
    clash = create(support, None, None, infra_envs=(DELL, DELL))
    assert problems(await client.post("/api/day1/clusters/preview", json=clash, headers=alice)) == [
        f"nodepools[1].{SUFFIX_INPUT}: NodePool {DELL} is nodepools[0]'s already; nodepools on "
        "one InfraEnv need different suffixes, and at most one may have none"
    ]
    bad = create(support, "Zone_B")
    (problem,) = problems(await client.post("/api/day1/clusters/preview", json=bad, headers=alice))
    assert problem.startswith(f"nodepools[0].{SUFFIX_INPUT}: 'Zone_B' must be lowercase letters")
    long = create(support, "x" * 32)
    (too_long,) = problems(
        await client.post("/api/day1/clusters/preview", json=long, headers=alice)
    )
    assert too_long.endswith("is longer than 63 characters")
    whole = create(support)
    whole["variables"]["nodepools"][0][NAME_INPUT] = "falcon-workers"
    (not_rule,) = problems(
        await client.post("/api/day1/clusters/preview", json=whole, headers=alice)
    )
    assert not_rule.startswith(f"nodepools[0].{NAME_INPUT}: 'falcon-workers' is not <InfraEnv>")


async def test_a_template_that_does_not_write_the_name_refuses_a_create(
    client: httpx.AsyncClient, auth: Auth, support: Any, gitlab: InMemoryGitLab
) -> None:
    await support.push(
        gitlab, support.SPECS, branch="main", file="cluster-template.j2", content=OLD_TEMPLATE
    )
    pid = await support.project_id(gitlab, support.SPECS)
    await client.post(
        "/api/webhooks/gitlab",
        json={"project": {"id": pid}},
        headers={"X-Gitlab-Token": "test-webhook-secret", "X-Gitlab-Event": "Push Hook"},
    )
    alice = auth(support.ALICE)
    schema = (await client.get("/api/day1/specs/template/schema", headers=alice)).json()
    fields = [f["name"] for f in next(f for f in schema if f["name"] == "nodepools")["fields"]]
    assert SUFFIX_INPUT not in fields, "nothing to offer the suffix for"
    refused = await client.post("/api/day1/clusters/preview", json=create(support), headers=alice)
    first, second = problems(refused)
    assert first.startswith(f"nodepool[0].name: the template wrote None for '{DELL}'")
    assert GUIDE in first and second.startswith("nodepool[1].name:")


# ── Flavors ──────────────────────────────────────────────────────────────────


async def test_a_flavor_presets_a_suffix_and_never_a_whole_name(
    client: httpx.AsyncClient, auth: Auth, support: Any
) -> None:
    alice = auth(support.ALICE)
    saved = await client.post("/api/day1/specs", json=flavor({SUFFIX_INPUT: "gpu"}), headers=alice)
    assert saved.status_code == 201, saved.text
    whole = flavor({"infra_env": DELL, NAME_INPUT: "falcon-zone-a"})
    whole["metadata"]["name"] = "agent-named"
    assert problems(await client.post("/api/day1/specs", json=whole, headers=alice)) == [
        f"nodepools[0].{NAME_INPUT}: a NodePool is named after the cluster's InfraEnv "
        f"(<InfraEnv> or <InfraEnv>-<suffix>, ADR-0071); preset {SUFFIX_INPUT} instead"
    ]
    bad = flavor({SUFFIX_INPUT: "-gpu"})
    bad["metadata"]["name"] = "agent-dash"
    (problem,) = problems(await client.post("/api/day1/specs", json=bad, headers=alice))
    assert problem.startswith(f"nodepools[0].{SUFFIX_INPUT}: '-gpu' must be lowercase")


# ── Edits ────────────────────────────────────────────────────────────────────


async def test_an_edit_adds_a_nodepool_by_the_rule_beside_the_derived_one(
    client: httpx.AsyncClient, auth: Auth, support: Any
) -> None:
    alice = auth(support.ALICE)
    second = f"- infraEnvName: {DELL}\n  replicas: 1\n\nvlanId: 1412"
    unnamed = await modify(client, alice, LARK, lambda y: y.replace("vlanId: 1412", second))
    assert problems(unnamed) == [  # the chart's clusterName, as the MCE shows the NodePool
        f"nodepool[2]: nodepool name 'prod-lark-site1-{DELL}' is used twice; nodepools that "
        "share an InfraEnv need names of their own, <infraEnvName>-<suffix> (ADR-0071)"
    ]
    derived = second.replace("  replicas", f"  name: prod-lark-site1-{DELL}\n  replicas")
    taken = await modify(client, alice, LARK, lambda y: y.replace("vlanId: 1412", derived))
    (twice,) = problems(taken)
    assert twice.startswith(f"nodepool[2]: nodepool name 'prod-lark-site1-{DELL}' is used twice")
    named = second.replace("  replicas", f"  name: {DELL}-b\n  replicas")
    added = await modify(client, alice, LARK, lambda y: y.replace("vlanId: 1412", named))
    assert added.status_code == 200, added.text


async def test_an_edit_keeps_an_existing_name_that_does_not_follow_the_rule(
    client: httpx.AsyncClient, auth: Auth, support: Any
) -> None:
    alice = auth(support.ALICE)
    kept = await modify(client, alice, HERON, lambda y: y.replace("replicas: 1", "replicas: 2"))
    assert kept.status_code == 200, kept.text
    other = await modify(
        client, alice, HERON, lambda y: y.replace("prod-heron-site1-dell-b", "heron-dell-b")
    )
    (problem,) = problems(other)
    assert problem.startswith("nodepool[1].name: 'heron-dell-b' is not <InfraEnv> or")
