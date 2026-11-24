"""What every workflow adapter shares: a start's answers, the orchestrator's words, the readers."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from wingman_day1.domain.add_server import ListedRun
from wingman_day1.domain.errors import (
    AmbiguousStartError,
    WorkflowRefusedError,
    WorkflowsUnavailableError,
)
from wingman_day1.infrastructure.workflows.orchestrator import (
    MAX_DETAIL,
    MAX_PROBLEMS,
    Start,
    detail,
    get_run,
    list_runs,
    parsed,
    post_start,
    problems,
    start_refused,
    started_id,
    words,
)
from wingman_day1.infrastructure.workflows.parse import (
    integer,
    listed_runs,
    mapping,
    text,
    timestamp,
)

START = Start("upgrade", "ocp4-prod-falcon-site1", "Look first.")


def answer(status: int, body: object = None, *, content: bytes | None = None) -> httpx.Response:
    if content is not None:
        return httpx.Response(status, content=content)
    return httpx.Response(status, json=body)


def client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url="http://orchestrator", transport=handler)


def test_a_start_names_its_subject() -> None:
    assert START.subject == "the upgrade of ocp4-prod-falcon-site1"


@pytest.mark.parametrize(
    ("status", "error", "words_"),
    [
        (504, AmbiguousStartError, "a gateway timed out waiting for the orchestrator to start"),
        (418, WorkflowRefusedError, "the orchestrator refused the upgrade of"),
        (500, WorkflowsUnavailableError, "the orchestrator answered 500 to the upgrade of"),
    ],
)
def test_the_answers_no_workflow_reads_its_own_way(
    status: int, error: type[Exception], words_: str
) -> None:
    refused = start_refused(answer(status, {"detail": "why"}), START)
    assert isinstance(refused, error)
    assert words_ in str(refused)


def test_a_refusal_keeps_the_orchestrators_detail() -> None:
    assert str(start_refused(answer(418, {"detail": " why "}), START)).endswith("(418): why")


async def test_a_start_that_never_left_is_unavailable_and_one_unanswered_ambiguous() -> None:
    def refuse(error: type[httpx.TransportError]) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            raise error("boom", request=request)

        return httpx.MockTransport(handler)

    with pytest.raises(WorkflowsUnavailableError, match="nothing was started"):
        await post_start(client(refuse(httpx.ConnectError)), "/start", START, json={})
    with pytest.raises(AmbiguousStartError, match=r"it may have started\. Look first\."):
        await post_start(client(refuse(httpx.ReadTimeout)), "/start", START, json={})


def test_a_202_without_a_workflow_id_is_ambiguous() -> None:
    assert started_id(answer(202, {"workflow_id": "wf-1"}), START) == "wf-1"
    for body in ({}, {"workflow_id": ""}, [], "text"):
        with pytest.raises(AmbiguousStartError, match=r"\(202\) but its answer could not"):
            started_id(answer(202, body), START)


async def test_a_run_reads_404_as_none_and_any_other_status_as_unavailable() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer({"gone": 404, "bad": 500}.get(request.url.path.rsplit("/", 1)[-1], 200), {})

    orchestrator = client(httpx.MockTransport(handler))
    assert await get_run(orchestrator, "gone") is None
    assert (await get_run(orchestrator, "a/b")) is not None
    assert seen[-1].url.raw_path == b"/workflows/runs/a%2Fb"
    with pytest.raises(WorkflowsUnavailableError, match="answered 500 reading run bad"):
        await get_run(orchestrator, "bad")


async def test_a_run_list_asks_for_one_workflow_and_the_most_it_returns() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(200, [])

    await list_runs(client(httpx.MockTransport(handler)), "UpgradeClusterWorkflow", what="x")
    assert dict(seen[0].url.params) == {"workflow_type": "UpgradeClusterWorkflow", "limit": "200"}


def test_a_body_that_cannot_be_read_is_unavailable_in_the_callers_words() -> None:
    assert parsed(answer(200, [1]), list, malformed="no") == [1]
    with pytest.raises(WorkflowsUnavailableError, match=r"^a malformed run$"):
        parsed(answer(200, content=b"<html>"), list, malformed="a malformed run")


def test_the_orchestrators_words() -> None:
    long = "x" * (MAX_DETAIL + 50)
    assert detail(answer(409, {"detail": " busy "})) == ": busy"
    assert detail(answer(409, {"detail": long})) == f": {'x' * MAX_DETAIL}"
    assert detail(answer(409, {"detail": ["a list"]})) == ""
    assert detail(answer(502, content=b"<html>")) == ""
    assert words(answer(409, {"detail": " the run waits for a decision "})) == (
        "the run waits for a decision"
    )
    assert words(answer(409, [])) == ""


def test_a_422s_findings_are_one_line_each() -> None:
    findings = [{"loc": ["body", "nodepool"], "msg": "unknown"}, {"loc": ["query"], "msg": "q"}]
    assert problems(answer(422, {"detail": findings})) == ["nodepool: unknown", "q"]
    assert problems(answer(422, {"detail": " in words "})) == ["in words"]
    many = [{"loc": [], "msg": str(i)} for i in range(MAX_PROBLEMS + 5)]
    assert len(problems(answer(422, {"detail": many}))) == MAX_PROBLEMS
    assert problems(answer(422, {"detail": [1, {"msg": ""}]})) == []
    assert problems(answer(422, content=b"<html>")) == []


def test_the_lenient_readers_leave_out_a_field_of_the_wrong_type() -> None:
    raw = {"name": "n", "empty": "", "count": 2, "flag": True, "at": "2026-11-24T09:00:00+00:00"}
    assert (text(raw, "name"), text(raw, "empty"), text(raw, "count")) == ("n", None, None)
    assert (integer(raw, "count"), integer(raw, "flag"), integer(raw, "name")) == (2, None, None)
    assert (mapping({"a": 1}), mapping([1])) == ({"a": 1}, {})
    assert timestamp(raw, "at") == datetime(2026, 11, 24, 9, tzinfo=UTC)
    assert (timestamp(raw, "name"), timestamp(raw, "missing")) == (None, None)


def test_the_run_list_needs_each_runs_id_and_status() -> None:
    runs = listed_runs([{"workflow_id": "wf", "status": "RUNNING", "start_time": "bad"}])
    assert runs == [ListedRun("wf", "running", started_at=None, closed_at=None)]
    for raw in ({}, [1], [{"workflow_id": "wf"}]):
        with pytest.raises((TypeError, ValueError)):
            listed_runs(raw)
