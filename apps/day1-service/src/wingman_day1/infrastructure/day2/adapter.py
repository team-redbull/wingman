"""The day2 service as day1 reaches it: its addon list, and its install MRs.

The only place day1 knows day2 exists. Day1 never writes a day2 repo
itself (ADR-0016): ``HttpDay2Addons`` reads what is installed, and
``HttpDay2Installs`` asks day2's own API to open install MRs for a
flavor's rollout (ADR-0044), a sync or an import (ADR-0037's 2026-11-25
amendment), which day2 opens as for any request, one per team. Each
authenticates with a short-lived session token of day1's own (the services
share the session secret), issued by the injected ``token`` callable:
``HttpDay2Addons`` as day1 itself, ``HttpDay2Installs`` as the user it asks
for, so day2's MRs name the person who synced or imported.

``Day2UnavailableError`` means day2 did not answer usefully: addon state
is then *unknown*, never "nothing installed" (ADR-0004). An install day2
may have acted on but did not confirm says so, and is never resent here
(ADR-0006): the caller reads ``open_installs`` before asking again. Its answers
are read in ``parse.py``.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from typing import Final
from urllib.parse import quote

import httpx

from wingman_core.domain.users import User
from wingman_core.observability.metrics import Dependency, WingmanMetrics
from wingman_day1.domain.addons import (
    Day2InstallRequest,
    Day2InstallResult,
    InstalledAddon,
    RequestedAddon,
)
from wingman_day1.domain.errors import Day2UnavailableError
from wingman_day1.domain.paths import ClusterRef
from wingman_day1.infrastructure.day2.parse import (
    bulk_result,
    installed,
    open_installs,
    problem_code,
    refusal,
)
from wingman_day1.infrastructure.http import NOT_SENT, json_client
from wingman_day1.infrastructure.observed import Day2Operation, Observer, Timer

APPROVALS_PATH: Final = "/api/day2/approvals"
"""Day2's open Wingman MRs across every team repo (``list[MRDetailOut]``)."""

REFUSALS: Final = frozenset({404, 409, 422})
"""Statuses with which day2 refuses an install it did not act on (its RFC 9457 problems)."""

CHECK_FIRST: Final = "Read its open installs on the cluster before asking again."
TEAM_READ_ONLY: Final = "TEAM_READ_ONLY"
"""Day2's 403 for a team that gave Wingman no write access (ADR-0043): that team's refusal."""


def _addons_path(cluster: ClusterRef, suffix: str = "") -> str:
    return f"/api/day2/clusters/{quote(cluster.name, safe='')}/addons{suffix}"


class HttpDay2Addons:
    """A ``Day2Addons`` over day2's ``GET /api/day2/clusters/{name}/addons``."""

    def __init__(
        self,
        *,
        base_url: str,
        token: Callable[[], str],
        timeout_seconds: float = 5.0,
        metrics: WingmanMetrics | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timer: Timer = time.perf_counter,
    ) -> None:
        """Call day2 at ``base_url`` (e.g. ``http://wingman-day2:8002``) as ``token()``."""
        self._token = token
        self._observer = Observer(Dependency.DAY2, metrics, timer=timer)
        self._client = json_client(
            base_url=base_url, timeout_seconds=timeout_seconds, transport=transport
        )

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    async def installed(self, cluster: ClusterRef) -> list[InstalledAddon]:
        """See Day2Addons.installed."""
        return await self._observer.call(
            Day2Operation.LIST_INSTALLED_ADDONS, self._installed(cluster)
        )

    async def _installed(self, cluster: ClusterRef) -> list[InstalledAddon]:
        try:
            response = await self._client.get(
                _addons_path(cluster),
                params={"mce": cluster.mce},
                headers={"Authorization": f"Bearer {self._token()}"},
            )
        except httpx.TransportError as exc:
            raise Day2UnavailableError(
                f"day2 unreachable listing addons of {cluster.name}: {type(exc).__name__}"
            ) from exc
        if response.status_code != 200:
            raise Day2UnavailableError(
                f"day2 answered {response.status_code} listing addons of {cluster.name}"
            )
        try:
            return installed(response.json())
        except (ValueError, KeyError, TypeError) as exc:
            raise Day2UnavailableError(
                f"day2 returned a malformed addon list for {cluster.name}"
            ) from exc


class HttpDay2Installs:
    """A ``Day2Installs`` over day2's approvals list and its bulk install.

    ``token`` issues a session for the user it is given, who must be an
    admin (day2's bulk install is an admin write); the MRs' footers then
    name that user as the requester.
    A version is never sent: a missing add-on is installed at its team's
    default revision, and any other version would be an emergency pin
    that day2 refuses unless asked for (ADR-0025, ADR-0022).
    """

    def __init__(
        self,
        *,
        base_url: str,
        token: Callable[[User], str],
        timeout_seconds: float = 30.0,
        metrics: WingmanMetrics | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timer: Timer = time.perf_counter,
    ) -> None:
        """Call day2 at ``base_url`` as ``token(user)``; an install commits per team: allow time."""
        self._token = token
        self._observer = Observer(Dependency.DAY2, metrics, timer=timer)
        self._client = json_client(
            base_url=base_url, timeout_seconds=timeout_seconds, transport=transport
        )

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._client.aclose()

    def _auth(self, user: User) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token(user)}"}

    async def open_installs(
        self, cluster: ClusterRef, *, as_user: User
    ) -> list[Day2InstallRequest]:
        """See Day2Installs.open_installs."""
        return await self._observer.call(
            Day2Operation.LIST_OPEN_INSTALLS, self._open_installs(cluster, as_user)
        )

    async def _open_installs(self, cluster: ClusterRef, user: User) -> list[Day2InstallRequest]:
        try:
            response = await self._client.get(APPROVALS_PATH, headers=self._auth(user))
        except httpx.TransportError as exc:
            raise Day2UnavailableError(
                f"day2 unreachable listing its open merge requests: {type(exc).__name__}"
            ) from exc
        if response.status_code != 200:
            raise Day2UnavailableError(
                f"day2 answered {response.status_code} listing its open merge requests"
            )
        try:
            return open_installs(response.json(), cluster.name)
        except (ValueError, KeyError, TypeError) as exc:
            raise Day2UnavailableError("day2 returned a malformed merge request list") from exc

    async def install(
        self,
        cluster: ClusterRef,
        addons: Sequence[RequestedAddon],
        *,
        message: str,
        as_user: User,
    ) -> Day2InstallResult:
        """See Day2Installs.install. Nothing to install asks nothing.

        Day2 is asked once per team: day2 validates a whole request before it
        opens anything, so one team that refuses (``TEAM_READ_ONLY``: it gave
        Wingman no write access, ADR-0043) must not hold back the others. A
        team day2 did not answer for is a ``failed`` line saying whether its
        MR may have opened; nothing is retried.
        """
        if not addons:
            return Day2InstallResult(opened=(), failed=())
        teams: dict[str, list[RequestedAddon]] = {}
        for addon in addons:
            teams.setdefault(addon.team, []).append(addon)
        opened: list[Day2InstallRequest] = []
        failed: list[str] = []
        for team, asked in teams.items():
            try:
                result = await self._observer.call(
                    Day2Operation.INSTALL_ADDONS, self._install(cluster, asked, message, as_user)
                )
            except Day2UnavailableError as exc:
                failed.append(f"{team}: {exc}")
                continue
            opened += result.opened
            failed += result.failed
        return Day2InstallResult(opened=tuple(opened), failed=tuple(failed))

    async def _install(
        self, cluster: ClusterRef, addons: Sequence[RequestedAddon], message: str, user: User
    ) -> Day2InstallResult:
        what = f"the install of {len(addons)} add-on(s) on {cluster.name}"
        body = {
            "addons": [
                {"team": a.team, "addon": a.name, "override_values": dict(a.override_values)}
                for a in addons
            ],
            "custom_message": message,
        }
        try:
            response = await self._client.post(
                _addons_path(cluster, "/bulk"),
                params={"mce": cluster.mce},
                json=body,
                headers=self._auth(user),
            )
        except NOT_SENT as exc:
            raise Day2UnavailableError(
                f"day2 could not be reached for {what} ({type(exc).__name__}); nothing was opened"
            ) from exc
        except httpx.TransportError as exc:
            raise Day2UnavailableError(
                f"{what} was sent to day2 but no answer came back ({type(exc).__name__}): day2 "
                f"did not confirm it, so its merge requests may have opened. {CHECK_FIRST}"
            ) from exc
        status = response.status_code
        if status == 201:
            try:
                return bulk_result(response.json(), cluster.name, addons)
            except (ValueError, KeyError, TypeError) as exc:
                raise Day2UnavailableError(
                    f"day2 accepted {what} (201) but its answer could not be read: its merge "
                    f"requests may have opened. {CHECK_FIRST}"
                ) from exc
        if status in REFUSALS or problem_code(response) == TEAM_READ_ONLY:
            return Day2InstallResult(opened=(), failed=refusal(response, team=addons[0].team))
        if status in (401, 403):
            raise Day2UnavailableError(
                f"day2 refused day1's service session ({status}) for {what}: a deployment "
                "problem; nothing was opened"
            )
        if 400 <= status < 500:
            raise Day2UnavailableError(f"day2 answered {status} to {what}; nothing was opened")
        raise Day2UnavailableError(
            f"day2 answered {status} to {what} and did not confirm it: its merge requests may "
            f"have opened. {CHECK_FIRST}"
        )
