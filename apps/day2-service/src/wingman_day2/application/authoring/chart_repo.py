"""The chart repo a deploy config names: refused when it cannot work, warned when unchecked."""

from __future__ import annotations

from collections.abc import Mapping
from urllib.parse import urlsplit

from wingman_day2.application.catalog import (
    chart_repo_findings,
    chart_values,
    check_chart_repo,
    version_order,
)
from wingman_day2.domain.deploy_config import DEFAULT_PATH, DEFAULT_REVISION, truthy
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.findings import Finding, Rule, warning
from wingman_day2.ports import ChartRepository


async def check_repourl(
    charts: ChartRepository,
    repourl: str,
    revision: object,
    chart_path: object,
    *,
    file: str,
    where: Mapping[str, str],
) -> list[Finding]:
    """Refuse a chart repo URL that cannot work; warn about one Wingman cannot check.

    ``file`` is the deploy config that sets it, for the findings.
    """
    url = urlsplit(repourl.strip())
    if url.scheme not in ("http", "https") or not url.netloc or not url.path.strip("/"):
        raise ChangeRefusedError(
            f"{repourl!r} is not a chart repo URL (https://<gitlab>/<group>/<chart>.git)",
            details={"rule": "repourl-invalid", "repourl": repourl},
        )
    if not charts.on_this_gitlab(repourl):
        return [
            warning(
                Rule.CHART_REPO_ELSEWHERE,
                f"{repourl} is not on this GitLab: Wingman cannot list its versions or show "
                "its default values (ArgoCD reads it as written)",
                path=file,
                **where,
            )
        ]
    check = await check_chart_repo(charts, repourl)
    project = check.project
    if project is None:
        raise ChangeRefusedError(
            check.problem or f"{repourl} names no project on this GitLab that Wingman can read",
            details={"rule": "chart-repo-missing", "repourl": repourl},
        )
    found = chart_repo_findings(check, path=file, **where)
    wanted = str(revision) if truthy(revision) else DEFAULT_REVISION
    if wanted != DEFAULT_REVISION:
        branches = await charts.branches(project)
        if wanted not in branches:
            raise ChangeRefusedError(
                f"{project.path_with_namespace} has no branch {wanted!r}; a chart version is "
                "one of its branches (or HEAD, its default branch)",
                details={
                    "rule": "revision-unknown",
                    "revision": wanted,
                    "versions": version_order(project.default_branch, branches),
                },
            )
    chart = await chart_values(
        charts, repourl, wanted, str(chart_path) if truthy(chart_path) else DEFAULT_PATH
    )
    if chart.problem is not None:
        found.append(warning(Rule.CHART_VALUES_MISSING, chart.problem, path=file, **where))
    return found
