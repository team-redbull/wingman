"""OCP-version pins: the version they are keyed by, what a pin holds, the files (ADR-0043)."""

from __future__ import annotations

import pytest
import yaml
from hypothesis import given
from hypothesis import strategies as st

from wingman_core.domain.git import ChangeKind
from wingman_day2.domain.errors import ChangeRefusedError
from wingman_day2.domain.ocp_pins import (
    PinSpec,
    check_ocp_version,
    check_pin,
    check_pins,
    new_pin_files,
    pin_deploy_config,
    version_key,
)
from wingman_day2.domain.versions import ocp_version


def rule_of(raised: pytest.ExceptionInfo[ChangeRefusedError]) -> object:
    return raised.value.details["rule"]


@pytest.mark.parametrize("version", ["4.16.27", "4.20.9", "4.9.0", "10.0.100", " 4.18.22 "])
def test_a_full_version_is_a_pin_key(version: str) -> None:
    assert check_ocp_version(version) == version.strip()


@pytest.mark.parametrize(
    "version",
    ["4.16", "4", "", "4.16.27-x86_64", "v4.16.27", "4.16.x", "04.16.27", "4.16.27.1", "../4"],
)
def test_anything_but_a_full_version_is_refused(version: str) -> None:
    with pytest.raises(ChangeRefusedError) as raised:
        check_ocp_version(version)
    assert rule_of(raised) == "ocp-version-invalid"
    assert "4.16.27, never 4.16" in raised.value.detail


@given(st.integers(0, 99), st.integers(0, 99), st.integers(0, 999))
def test_every_version_a_mastertag_gives_is_a_pin_key(major: int, minor: int, patch: int) -> None:
    # The platform keys the folder by what comes before the mastertag's first '-'.
    version = ocp_version(f"{major}.{minor}.{patch}-x86_64")
    assert check_ocp_version(version) == version


def test_a_pin_needs_a_revision_and_its_values_are_a_mapping() -> None:
    with pytest.raises(ChangeRefusedError) as raised:
        check_pin(PinSpec("4.16.27", "  "))
    assert rule_of(raised) == "pin-revision-missing"
    with pytest.raises(ChangeRefusedError) as raised:
        check_pin(PinSpec("4.16.27", None))
    assert rule_of(raised) == "pin-revision-missing"
    with pytest.raises(ChangeRefusedError) as raised:
        check_pin(PinSpec("4.16.27", "2.1.4", ["a", "b"]))  # type: ignore
    assert rule_of(raised) == "pin-values-invalid"
    assert check_pin(PinSpec(" 4.16.27", " 2.1.4 ", {"a": 1})) == PinSpec(
        "4.16.27", "2.1.4", {"a": 1}
    )


def test_pins_are_one_per_version_and_sorted_by_version() -> None:
    pins = check_pins([PinSpec("4.16.27", "a"), PinSpec("4.9.1", "b"), PinSpec("4.16.3", "c")])
    assert [p.version for p in pins] == ["4.9.1", "4.16.3", "4.16.27"]
    with pytest.raises(ChangeRefusedError) as raised:
        check_pins([PinSpec("4.16.27", "a"), PinSpec(" 4.16.27", "b")])
    assert rule_of(raised) == "pin-duplicate"
    assert raised.value.details["versions"] == ["4.16.27"]
    assert check_pins([]) == ()


def test_version_order_is_numeric() -> None:
    assert sorted(["4.16.27", "4.9.0", "4.16.3"], key=version_key) == ["4.9.0", "4.16.3", "4.16.27"]
    assert version_key("4.16") == ()


def test_a_new_pin_writes_its_revision_and_only_values_it_has() -> None:
    (deploy,) = new_pin_files("cluster-roles", PinSpec("4.20.9", "2.1.5-hotfix"))
    assert (deploy.kind, str(deploy.path)) == (
        ChangeKind.CREATE,
        "operators/cluster-roles/ocp-versions/4.20.9/cluster-roles.yaml",
    )
    assert deploy.content == "targetRevision: 2.1.5-hotfix\n"
    files = new_pin_files("cluster-roles", PinSpec("4.20.9", "2.0.0", {"rbac": {"view": True}}))
    assert [str(f.path) for f in files] == [
        "operators/cluster-roles/ocp-versions/4.20.9/cluster-roles.yaml",
        "operators/cluster-roles/ocp-versions/4.20.9/values.yaml",
    ]
    assert yaml.safe_load(files[1].content or "") == {"rbac": {"view": True}}


@pytest.mark.parametrize("revision", ["3.3", "1.0", "2.1.4", "main", "HEAD", "true", "1e3"])
def test_a_revision_reads_back_as_the_same_string(revision: str) -> None:
    # A branch named 3.3 must not reach Helm as the number 3.3.
    assert yaml.safe_load(pin_deploy_config(revision)) == {"targetRevision": revision}
