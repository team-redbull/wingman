"""Day2's answers, read into ``wingman_day1.domain.addons``.

Its addon list and its approvals list must be what they say; anything else
raises ``TypeError``/``KeyError``/``ValueError``, which the adapter turns into
``Day2UnavailableError``. A refusal is read leniently into one line per item
day2 refused (``refusal``), whatever shape its problem has.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import httpx

from wingman_core.domain.mr_conventions import Repo, ResourceType, Verb, mr_title, parse_mr_title
from wingman_day1.domain.addons import (
    Day2InstallRequest,
    Day2InstallResult,
    InstalledAddon,
    RequestedAddon,
)
from wingman_day1.infrastructure.http import JSON


def installed(raw: JSON) -> list[InstalledAddon]:
    """``GET /api/day2/clusters/{name}/addons``: the team, name and version of each."""
    if not isinstance(raw, dict):
        raise TypeError("the response is not an object")
    items = raw["installed"]
    if not isinstance(items, list):
        raise TypeError("installed is not a list")
    addons: list[InstalledAddon] = []
    for item in items:
        if not isinstance(item, dict):
            raise TypeError("an installed addon is not an object")
        team, name, version = item["team"], item["name"], item.get("version") or ""
        if not (isinstance(team, str) and team and isinstance(name, str) and name):
            raise ValueError("an installed addon has no team or name")
        if not isinstance(version, str):
            raise TypeError("an installed addon's version is not a string")
        addons.append(InstalledAddon(team=team, name=name, version=version))
    return addons


def install_title_charts(title: str, cluster_name: str) -> tuple[str, ...] | None:
    """The charts a day2 install MR's title names on ``cluster_name``; ``None`` if it is not one.

    Day2 titles an install ``[Wingman/Day2] Install addon <team>/<chart>[,<chart>...]
    on <cluster>`` (ADR-0007), ``<cluster>`` being the day1 cluster file's name.
    """
    parsed = parse_mr_title(title)
    if parsed is None or (parsed.repo, parsed.verb, parsed.resource_type) != (
        Repo.DAY2,
        Verb.INSTALL,
        ResourceType.ADDON,
    ):
        return None
    base = mr_title(parsed.repo, parsed.verb, parsed.resource_type, parsed.resource_name)
    if title.removeprefix(base).split()[:2] != ["on", cluster_name]:
        return None
    team, slash, charts = parsed.resource_name.partition("/")
    names = tuple(c for c in charts.split(",") if c)
    return names if team and slash and names else None


def open_installs(raw: JSON, cluster_name: str) -> list[Day2InstallRequest]:
    """The approvals list's open install MRs on ``cluster_name``."""
    if not isinstance(raw, list):
        raise TypeError("the merge request list is not a list")
    found: list[Day2InstallRequest] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TypeError("a merge request is not an object")
        title = item["title"]
        if not isinstance(title, str):
            raise TypeError("a merge request's title is not a string")
        charts = install_title_charts(title, cluster_name)
        if charts is not None and item.get("state", "opened") == "opened":
            found.append(_request(item, charts))
    return found


def _request(item: Mapping[str, JSON], charts: tuple[str, ...]) -> Day2InstallRequest:
    team, iid, title, web_url = item["team"], item["iid"], item["title"], item["web_url"]
    if not (isinstance(team, str) and team):
        raise ValueError("a merge request has no team")
    if not isinstance(iid, int) or isinstance(iid, bool) or iid < 1:
        raise TypeError("a merge request's iid is not a positive integer")
    if not (isinstance(title, str) and isinstance(web_url, str)):
        raise TypeError("a merge request's title or web_url is not a string")
    return Day2InstallRequest(team=team, iid=iid, title=title, web_url=web_url, charts=charts)


def bulk_result(
    raw: JSON, cluster_name: str, addons: Sequence[RequestedAddon]
) -> Day2InstallResult:
    """Day2's ``BulkOut``: an MR per team that opened, and the teams whose MR did not.

    An MR's charts come from its title; one whose title does not read as an
    install keeps the charts day1 asked that team for.
    """
    if not isinstance(raw, dict):
        raise TypeError("the bulk result is not an object")
    merge_requests, failures = raw["merge_requests"], raw["failed"]
    if not (isinstance(merge_requests, list) and isinstance(failures, list)):
        raise TypeError("merge_requests or failed is not a list")
    opened: list[Day2InstallRequest] = []
    for item in merge_requests:
        if not isinstance(item, dict):
            raise TypeError("a merge request is not an object")
        title = item["title"]
        charts = install_title_charts(title, cluster_name) if isinstance(title, str) else None
        requested = tuple(a.name for a in addons if a.team == item["team"])
        opened.append(_request(item, charts or requested))
    failed: list[str] = []
    for failure in failures:
        if not isinstance(failure, dict):
            raise TypeError("a failure is not an object")
        failed.append(
            _line(failure.get("team"), None, failure.get("detail") or failure.get("error"))
        )
    return Day2InstallResult(opened=tuple(opened), failed=tuple(failed))


def problem_code(response: httpx.Response) -> str | None:
    """A problem answer's ``code``; ``None`` for any other body."""
    try:
        raw = response.json()
    except ValueError:
        return None
    code = raw.get("code") if isinstance(raw, dict) else None
    return code if isinstance(code, str) else None


def refusal(response: httpx.Response, *, team: str) -> tuple[str, ...]:
    """One line per item day2 refused, from its problem's ``details.problems``; else its detail."""
    status = response.status_code
    try:
        raw = response.json()
    except ValueError:
        return (f"{team}: day2 refused the install ({status})",)
    if not isinstance(raw, dict):
        return (f"{team}: day2 refused the install ({status})",)
    details = raw.get("details")
    details = details if isinstance(details, dict) else {}
    problems = details.get("problems")
    if isinstance(problems, list) and problems:
        lines = [
            _line(p.get("team"), p.get("chart"), p.get("detail"))
            if isinstance(p, dict)
            else _line(None, None, p)
            for p in problems
        ]
        return tuple(lines)
    detail = _one_line(raw.get("detail")) or "no reason given"
    errors = details.get("errors")
    if isinstance(errors, list) and errors:
        detail = f"{detail.rstrip('.')}: " + "; ".join(_validation_error(e) for e in errors)
    return (f"{team}: day2 refused the install ({status}): {detail}",)


def _validation_error(error: JSON) -> str:
    if not isinstance(error, dict):
        return _one_line(error)
    loc = error.get("loc")
    where = ".".join(str(part) for part in loc) if isinstance(loc, list) else ""
    message = _one_line(error.get("msg"))
    return f"{where}: {message}" if where else message


def _line(team: JSON, chart: JSON, detail: JSON) -> str:
    """``<team>[/<chart>]: <detail>``, on one line."""
    who = _one_line(team) or "day2"
    if chart:
        who = f"{who}/{_one_line(chart)}"
    return f"{who}: {_one_line(detail) or 'refused, no reason given'}"


def _one_line(value: JSON) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())
