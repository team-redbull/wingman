"""The day2 MRs a sync opens with its day1 MR, over HTTP (ADR-0037's 2026-11-25 amendment).

The answer's ``addons`` is what day2 answered (``AddonInstallsOut``), the
shape the web's ``AddonInstalls`` type reads.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from wingman_core.domain.git import RepoPath
from wingman_core.domain.users import User
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab
from wingman_day1.infrastructure.fakes.day2 import FakeDay2Addons

Auth = Callable[[User], dict[str, str]]
HOSTED = "sites/site1/mces/ocp4-prod-mce-site1-a/hostedClusters"
LARK = "ocp4-prod-lark-site1"
ROLES = {
    "addon_name": "cluster-roles",
    "team": "redbull",
    "reason": "missing",
    "expected_version": "main",
    "override_values": {},
}


async def link(client: httpx.AsyncClient, support: Any, gitlab: InMemoryGitLab) -> None:
    """Lark on agent-baseline v1.0.0 on main, as a merged import leaves it."""
    pid = await support.project_id(gitlab, support.DAY1)
    path = f"{HOSTED}/{LARK}.yaml"
    current = await gitlab.read_file(pid, RepoPath(path), "main")
    await support.push(
        gitlab,
        support.DAY1,
        branch="main",
        file=path,
        content=f'# specName: "agent-baseline"\n# specVersion: "1.0.0"\n{current.content}',
    )
    await client.post(
        "/api/webhooks/gitlab",
        json={"project": {"id": pid}},
        headers={"X-Gitlab-Token": "test-webhook-secret", "X-Gitlab-Event": "Push Hook"},
    )


async def sync(client: httpx.AsyncClient, headers: dict[str, str]) -> httpx.Response:
    preview = (
        await client.post(f"/api/day1/clusters/{LARK}/sync/preview", json={}, headers=headers)
    ).json()
    body = {
        "last_commit_id": preview["last_commit_id"],
        "spec_version": preview["spec_version"],
        "confirm_removals": [
            {"nodepool": r["nodepool"]["index"], "name": r["name"]} for r in preview["removals"]
        ],
    }
    return await client.post(f"/api/day1/clusters/{LARK}/sync", json=body, headers=headers)


async def test_the_sync_answers_with_its_mr_and_the_day2_mrs_it_opened(
    client: httpx.AsyncClient, auth: Auth, support: Any, gitlab: InMemoryGitLab
) -> None:
    await link(client, support, gitlab)
    response = await sync(client, auth(support.ALICE))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["title"] == f"[Wingman/Day1] Sync cluster {LARK} to spec agent-baseline v1.0.0"
    assert body["addons"] == {
        "missing": [ROLES],
        "opened": [
            {
                "team": "redbull",
                "iid": 1,
                "title": f"[Wingman/Day2] Install addon redbull/cluster-roles on {LARK}",
                "web_url": "https://gitlab.example.com/sigs/redbull/-/merge_requests/1",
                "charts": ["cluster-roles"],
            }
        ],
        "already_open": [],
        "failed": [],
        "not_asked": None,
        "not_opened": [],
    }


async def test_a_day2_refusal_is_in_the_answer_and_the_day1_mr_still_opened(
    client: httpx.AsyncClient,
    auth: Auth,
    support: Any,
    gitlab: InMemoryGitLab,
    day2: FakeDay2Addons,
) -> None:
    await link(client, support, gitlab)
    day2.refuse = {"redbull": "redbull hasn't given Wingman write access to sigs/redbull"}
    response = await sync(client, auth(support.ALICE))
    assert response.status_code == 201, response.text
    addons = response.json()["addons"]
    assert (addons["opened"], addons["not_asked"]) == ([], None)
    assert addons["failed"] == [
        "redbull: redbull hasn't given Wingman write access to sigs/redbull"
    ]
    assert addons["not_opened"] == [ROLES]


async def test_day2_not_answering_is_not_asked_with_its_reason(
    client: httpx.AsyncClient,
    auth: Auth,
    support: Any,
    gitlab: InMemoryGitLab,
    day2: FakeDay2Addons,
) -> None:
    await link(client, support, gitlab)
    headers = auth(support.ALICE)
    await client.post(f"/api/day1/clusters/{LARK}/sync/preview", json={}, headers=headers)
    day2.installs_down = True
    response = await sync(client, headers)
    assert response.status_code == 201, response.text
    addons = response.json()["addons"]
    assert addons["not_asked"] == (
        "day2 did not answer: day2 unreachable listing its open merge requests (fake)"
    )
    assert (addons["opened"], addons["not_opened"]) == ([], [ROLES])
