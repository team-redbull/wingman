"""An add-on's OCP-version pins through HTTP (ADR-0043's 2026-11-25 amendment).

``POST /addons/{team}/{addon}/ocp-versions`` adds a pin, ``PUT`` and
``DELETE .../ocp-versions/{version}`` change and remove one; every one is
previewed with ``?dry_run=true`` and sent again confirming that preview.
"""

from __future__ import annotations

from typing import Any

import httpx
import yaml

from wingman_core.domain.git import FileChange, RepoPath
from wingman_core.infrastructure.fake_gitlab import InMemoryGitLab

PINS = "/api/day2/addons/redbull/cluster-roles/ocp-versions"
FOLDER = "operators/cluster-roles/ocp-versions/4.20.9"
EYAL = "hosted:site1:prep:ocp4-prep-mce-site1-a:ocp4-prep-eyal-site1"
ITAY = "hosted:site1:prep:ocp4-prep-mce-site1-a:ocp4-prep-itay-site1"
PROBLEM_KEYS = {"type", "title", "status", "detail", "instance", "code", "request_id", "details"}


def ok(response: httpx.Response, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


def problem(response: httpx.Response, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == PROBLEM_KEYS and (body["status"], body["code"]) == (status, code)
    return body


async def confirmed(
    client: httpx.AsyncClient, method: str, url: str, body: dict[str, Any], status: int = 200
) -> Any:
    """Preview a write, then send the same body confirming what the preview showed."""
    plan = ok(await client.request(method, url, params={"dry_run": "true"}, json=body))
    confirm = {"confirm_changes": plan["needs_confirmation"], "expected_digest": plan["digest"]}
    return ok(await client.request(method, url, json={**body, **confirm}), status)


async def by_hand(gitlab: InMemoryGitLab, *changes: FileChange) -> None:
    project = await gitlab.get_project("sigs/redbull")
    await gitlab.commit(project.id, branch="main", message="by hand", changes=list(changes))


async def branch_files(gitlab: InMemoryGitLab, change: dict[str, Any]) -> dict[str, str]:
    project = await gitlab.get_project("sigs/redbull")
    return gitlab.snapshot(project.id, change["source_branch"])


async def test_a_pin_is_added_previewed_and_confirmed(
    jane: httpx.AsyncClient, gitlab: InMemoryGitLab
) -> None:
    body = {"version": "4.20.9", "target_revision": "2.1.5-hotfix", "values": {"extra": 1}}
    plan = ok(await jane.post(PINS, params={"dry_run": "true"}, json=body))
    assert plan["title"] == (
        "[Wingman/Day2] Update addon redbull/cluster-roles OCP-version pin 4.20.9 "
        "(new: 2.1.5-hotfix)"
    )
    assert plan["action"] == "update-default"
    assert [(f["action"], f["path"]) for f in plan["files"]] == [
        ("create", f"{FOLDER}/cluster-roles.yaml"),
        ("create", f"{FOLDER}/values.yaml"),
    ]
    assert plan["needs_confirmation"] == [EYAL, ITAY]
    assert plan["reach"] == [EYAL, ITAY]
    unconfirmed = problem(await jane.post(PINS, json=body), 422, "VALIDATION_ERROR")
    assert unconfirmed["details"]["rule"] == "confirm-changes"

    change = await confirmed(jane, "POST", PINS, body, 201)
    assert set(change["labels"]) == {"wingman", "day2", "update-default"}
    files = await branch_files(gitlab, change)
    assert files[f"{FOLDER}/cluster-roles.yaml"] == "targetRevision: 2.1.5-hotfix\n"
    assert yaml.safe_load(files[f"{FOLDER}/values.yaml"]) == {"extra": 1}


async def test_a_pin_read_on_the_addons_page_is_changed_and_removed_guarded(
    jane: httpx.AsyncClient, gitlab: InMemoryGitLab
) -> None:
    await by_hand(
        gitlab,
        FileChange.create(RepoPath(f"{FOLDER}/cluster-roles.yaml"), "targetRevision: 2.0.0\n"),
    )
    detail = ok(await jane.get("/api/day2/teams/redbull/addons/cluster-roles"))
    (pin,) = detail["ocp_versions"]
    assert (pin["version"], pin["target_revision"]) == ("4.20.9", "2.0.0")
    read_at = pin["last_commit_id"]
    assert read_at and read_at == pin["deploy_config"]["last_commit_id"]

    body = {"target_revision": "2.1.5-hotfix", "values": {"extra": 2}, "last_commit_id": read_at}
    change = await confirmed(jane, "PUT", f"{PINS}/4.20.9", body)
    assert [(f["action"], f["path"]) for f in change["files"]] == [
        ("update", f"{FOLDER}/cluster-roles.yaml"),
        ("create", f"{FOLDER}/values.yaml"),
    ]
    files = await branch_files(gitlab, change)
    assert files[f"{FOLDER}/cluster-roles.yaml"] == "targetRevision: 2.1.5-hotfix\n"

    removed = await confirmed(jane, "DELETE", f"{PINS}/4.20.9", {"last_commit_id": read_at})
    assert removed["title"].endswith("OCP-version pin 4.20.9 (removed)")
    assert [(f["action"], f["path"]) for f in removed["files"]] == [
        ("delete", f"{FOLDER}/cluster-roles.yaml")
    ]
    assert f"{FOLDER}/cluster-roles.yaml" not in await branch_files(gitlab, removed)


async def test_a_pin_changed_since_the_read_is_a_409(
    jane: httpx.AsyncClient, gitlab: InMemoryGitLab
) -> None:
    path = RepoPath(f"{FOLDER}/cluster-roles.yaml")
    await by_hand(gitlab, FileChange.create(path, "targetRevision: 2.0.0\n"))
    detail = ok(await jane.get("/api/day2/teams/redbull/addons/cluster-roles"))
    stale = detail["ocp_versions"][0]["last_commit_id"]
    await by_hand(gitlab, FileChange.update(path, "targetRevision: main\n", last_commit_id=None))
    body = {"target_revision": "2.1.5-hotfix", "last_commit_id": stale}
    plan = ok(await jane.put(f"{PINS}/4.20.9", params={"dry_run": "true"}, json=body))
    confirm = {"confirm_changes": plan["needs_confirmation"], "expected_digest": plan["digest"]}
    problem(await jane.put(f"{PINS}/4.20.9", json={**body, **confirm}), 409, "REVISION_CONFLICT")


async def test_pin_writes_are_an_admins_for_a_writable_team(
    jane: httpx.AsyncClient, vic: httpx.AsyncClient
) -> None:
    pin = {"version": "4.16.27", "target_revision": "2.0.0"}
    problem(await vic.post(PINS, json=pin), 403, "FORBIDDEN")
    problem(await vic.put(f"{PINS}/4.16.27", json={"target_revision": "x"}), 403, "FORBIDDEN")
    problem(await vic.request("DELETE", f"{PINS}/4.16.27", json={}), 403, "FORBIDDEN")
    orca = "/api/day2/addons/orca/metrics/ocp-versions"
    for write in (
        jane.post(orca, json={"version": "4.16", "target_revision": ""}),
        jane.put(f"{orca}/4.16.27", json={"target_revision": "x"}),
        jane.request("DELETE", f"{orca}/4.16.27", json={}),
    ):
        assert problem(await write, 403, "TEAM_READ_ONLY")["details"]["team"] == "orca"


async def test_a_pins_version_revision_and_existence_are_checked(
    jane: httpx.AsyncClient, gitlab: InMemoryGitLab
) -> None:
    await by_hand(
        gitlab,
        FileChange.create(RepoPath(f"{FOLDER}/cluster-roles.yaml"), "targetRevision: 2.0.0\n"),
    )
    dry = {"dry_run": "true"}
    for body, rule in [
        ({"version": "4.20", "target_revision": "2.0.0"}, "ocp-version-invalid"),
        ({"version": "4.21.0", "target_revision": " "}, "pin-revision-missing"),
        ({"version": "4.21.0", "target_revision": "9.9.9"}, "revision-unknown"),
    ]:
        refused = problem(await jane.post(PINS, params=dry, json=body), 422, "VALIDATION_ERROR")
        assert refused["details"]["rule"] == rule
    # A pin's revision is required; a typo'd field is a 422, not ignored.
    problem(await jane.post(PINS, params=dry, json={"version": "4.21.0"}), 422, "VALIDATION_ERROR")
    exists = {"version": "4.20.9", "target_revision": "2.0.0"}
    problem(await jane.post(PINS, params=dry, json=exists), 409, "ALREADY_EXISTS")
    missing = await jane.put(f"{PINS}/4.16.27", params=dry, json={"target_revision": "2.0.0"})
    assert problem(missing, 404, "NOT_FOUND")["details"]["rule"] == "pin-unknown"
    problem(await jane.put(f"{PINS}/4.20", params=dry, json={}), 422, "VALIDATION_ERROR")
