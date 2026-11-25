"""The bodies of an add-on's OCP-version pin writes (ADR-0043's 2026-11-25 amendment).

A write answers like every authoring write: ``AuthoringPlanOut`` for a dry
run, ``AuthoringChangeOut`` for the MR it opened.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from wingman_day2.api.v1.schemas import ConfirmedIn, OcpPinIn
from wingman_day2.application.ocp_pins import PinChange


class AddPinBody(OcpPinIn):
    """A new pin of the add-on: ``ocp-versions/<version>/`` with its revision and values."""

    confirm_changes: list[str] = Field(default_factory=list)
    expected_digest: str | None = Field(default=None, description="The preview's digest.")
    message: str | None = None


class ChangePinBody(ConfirmedIn):
    """A change of one pin: absent or null fields are unchanged."""

    target_revision: str | None = Field(
        default=None, description="A branch of the chart repo. Absent or null: unchanged."
    )
    values: dict[str, Any] | None = Field(
        default=None, description="Its values.yaml, whole. Absent or null: unchanged; {}: deleted."
    )

    def change(self) -> PinChange:
        """The application's request."""
        return PinChange(target_revision=self.target_revision, values=self.values)


class RemovePinBody(ConfirmedIn):
    """The removal of one pin: every file of its folder, guarded by the read's commit."""
