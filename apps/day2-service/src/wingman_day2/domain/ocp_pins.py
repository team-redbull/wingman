"""OCP-version pins, ``operators/<chart>/ocp-versions/<version>/``, as Wingman writes them.

A pin is layer 2 of both of an add-on's stacks on every destination whose
OCP version is exactly ``<version>``, the platform's (what comes before a
``mastertag``'s first ``-``, ``versions.ocp_version``): its ``<chart>.yaml``
pins the chart revision there (``targetRevision``, a branch of the chart
repo), and its ``values.yaml`` adds values for that version above the Sig
values. The folder is keyed by the **full** version, ``4.16.27`` and never
``4.16``: a destination even a z-stream away does not read it.

Wingman writes the two files the platform reads, in the platform's shape:
``<chart>.yaml`` is ``targetRevision: <revision>``, and ``values.yaml`` is
there only when the pin has values (both layers are optional to the
platform). A pin Wingman adds always pins a revision; a layer holding values
only, written by hand (a chart that tracks its default branch and needs
values per version), keeps its shape when only its values change
(ADR-0043's 2026-11-25 amendment).
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Final

from wingman_core.domain.git import FileChange
from wingman_day2.domain import layout
from wingman_day2.domain.deploy_config import TARGET_REVISION
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.yaml_text import dump_yaml
from wingman_day2.domain.yaml_values import dump_values

FULL_VERSION: Final = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
"""``<major>.<minor>.<patch>``: the only key an ``ocp-versions/`` folder may have."""


@dataclass(frozen=True, slots=True)
class PinSpec:
    """One pin as asked: the OCP version, the chart revision there, and its values."""

    version: str
    target_revision: str | None
    values: Mapping[str, object] = field(default_factory=dict)


def check_ocp_version(version: object) -> str:
    """``version`` as a pin's folder name, or the refusal of anything but a full version."""
    text = str(version).strip()
    if not FULL_VERSION.match(text):
        raise ChangeRefusedError(
            f"{text!r} is not a full OpenShift version: an ocp-versions/ folder is keyed by "
            "<major>.<minor>.<patch>, exactly as a cluster's mastertag gives it (4.16.27, "
            "never 4.16), so a destination even a z-stream away does not read it",
            details={"rule": "ocp-version-invalid", "version": text},
        )
    return text


def check_revision(revision: object) -> str:
    """The chart revision a pin sets, or the refusal of none."""
    text = "" if revision is None else str(revision).strip()
    if not text:
        raise ChangeRefusedError(
            "a pin pins a chart revision: give targetRevision, a branch of the chart repo "
            "(HEAD for its default branch)",
            details={"rule": "pin-revision-missing"},
        )
    return text


def check_values(values: object) -> dict[str, object]:
    """A pin's values as a mapping, or the refusal of anything else."""
    if not isinstance(values, Mapping):
        raise ChangeRefusedError(
            f"a pin's values.yaml is a mapping of values, not a {type(values).__name__}",
            details={"rule": "pin-values-invalid"},
        )
    return {str(key): value for key, value in values.items()}


def check_pin(pin: PinSpec) -> PinSpec:
    """``pin`` checked and trimmed: a full version, a revision, values that are a mapping."""
    return PinSpec(
        check_ocp_version(pin.version),
        check_revision(pin.target_revision),
        check_values(pin.values),
    )


def version_key(version: str) -> tuple[int, ...]:
    """A full version's sort key (``4.9.1`` before ``4.16.0``); anything else sorts first."""
    return tuple(int(part) for part in version.split(".")) if FULL_VERSION.match(version) else ()


def check_pins(pins: Iterable[PinSpec]) -> tuple[PinSpec, ...]:
    """Every pin checked, oldest version first; one version given twice is refused."""
    checked = [check_pin(pin) for pin in pins]
    twice = sorted(v for v, n in Counter(p.version for p in checked).items() if n > 1)
    if twice:
        raise ChangeRefusedError(
            f"OCP {twice[0]} is pinned twice: one ocp-versions/{twice[0]}/ folder holds one pin",
            details={"rule": "pin-duplicate", "versions": twice},
        )
    return tuple(sorted(checked, key=lambda p: version_key(p.version)))


def pin_deploy_config(revision: str) -> str:
    """``ocp-versions/<v>/<chart>.yaml`` of a new pin: its revision, nothing else."""
    return dump_yaml({TARGET_REVISION: revision})


def new_pin_files(chart: str, pin: PinSpec) -> list[FileChange]:
    """The files of a new pin: its deploy config, and its values when it has any."""
    folder = layout.ocp_version_dir(chart, pin.version)
    changes = []
    if pin.target_revision is not None:
        changes.append(
            FileChange.create(
                folder.child(layout.deploy_config_name(chart)),
                pin_deploy_config(pin.target_revision),
            )
        )
    if pin.values:
        changes.append(FileChange.create(folder.child(layout.VALUES_FILE), dump_values(pin.values)))
    return changes
