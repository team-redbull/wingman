"""An add-on's OCP-version pins: add, change, remove (ADR-0043's 2026-11-25 amendment).

``operators/<addon>/ocp-versions/<version>/`` in the team repo, one MR each,
as every authoring write: ``?dry_run=true`` plans and checks and opens
nothing (200 with the plan); without it the write opens the MR (201 for a
new pin, else 200). What the plan changes, the destinations at that version,
is confirmed by id in ``confirm_changes`` with the preview's ``digest`` as
``expected_digest``; a change or removal carries the ``last_commit_id`` the
pin was read at (a pin changed or deleted since answers 409). Admins only,
for a team that has given Wingman write access (else ``403 TEAM_READ_ONLY``,
before anything else is checked).
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from wingman_core.web.auth import AdminUser
from wingman_day2.api.v1.authoring import DryRun, answer
from wingman_day2.api.v1.authoring_schemas import AuthoringChangeOut, AuthoringPlanOut
from wingman_day2.api.v1.dependencies import Services
from wingman_day2.api.v1.ocp_pins_schemas import AddPinBody, ChangePinBody, RemovePinBody

router = APIRouter(prefix="/api/day2", tags=["authoring"])


@router.post("/addons/{team}/{addon}/ocp-versions", status_code=status.HTTP_201_CREATED)
async def add_pin(
    team: str,
    addon: str,
    body: AddPinBody,
    user: AdminUser,
    day2: Services,
    response: Response,
    dry_run: bool = DryRun,
) -> AuthoringPlanOut | AuthoringChangeOut:
    """Open an MR adding ``ocp-versions/<version>/``: its revision, and its values if any."""
    result = await day2.ocp_pins.add(
        team,
        addon,
        body.spec(),
        user,
        confirm_changes=body.confirm_changes,
        expected_digest=body.expected_digest,
        dry_run=dry_run,
        message=body.message,
    )
    return answer(result, response, created=True)


@router.put("/addons/{team}/{addon}/ocp-versions/{version}")
async def change_pin(
    team: str,
    addon: str,
    version: str,
    body: ChangePinBody,
    user: AdminUser,
    day2: Services,
    response: Response,
    dry_run: bool = DryRun,
) -> AuthoringPlanOut | AuthoringChangeOut:
    """Open an MR changing a pin's revision (edited in place) or its values ({} deletes them)."""
    result = await day2.ocp_pins.change(
        team,
        addon,
        version,
        body.change(),
        user,
        last_commit_id=body.last_commit_id,
        confirm_changes=body.confirm_changes,
        expected_digest=body.expected_digest,
        dry_run=dry_run,
        message=body.message,
    )
    return answer(result, response, created=False)


@router.delete("/addons/{team}/{addon}/ocp-versions/{version}")
async def remove_pin(
    team: str,
    addon: str,
    version: str,
    body: RemovePinBody,
    user: AdminUser,
    day2: Services,
    response: Response,
    dry_run: bool = DryRun,
) -> AuthoringPlanOut | AuthoringChangeOut:
    """Open an MR deleting the pin's folder: that version gets the add-on's revision again."""
    result = await day2.ocp_pins.remove(
        team,
        addon,
        version,
        user,
        last_commit_id=body.last_commit_id,
        confirm_changes=body.confirm_changes,
        expected_digest=body.expected_digest,
        dry_run=dry_run,
        message=body.message,
    )
    return answer(result, response, created=False)
