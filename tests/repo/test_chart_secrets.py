"""Where day1 and day2 get their secrets: the chart's own Secret, or an existing one (ADR-0070).

By default the chart renders ``wingman-secrets`` from five values and the
``OAuthClient`` with its secret inline, exactly as before 3.62. With
``secrets.existingSecret`` it renders no Secret and both services read the named
one; a secret value set beside it fails the render naming it, and so does an
``OAuthClient`` the chart would render without its secret
(``auth.oauthClient.create: false`` has it made by hand). A Git repository that
deploys the chart (redbull-platform's ApplicationSet) then holds no secret.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from chart_render import CHART, render, require_helm, template
from service_settings import read_by_services

require_helm("the chart's secret tests")

FIXTURE = CHART / "ci/existing-secret-values.yaml"
EXISTING = "wingman-credentials"
SECRET_KEYS = {
    "GITLAB_TOKEN",
    "JWT_SECRET_KEY",
    "OPENSHIFT_OAUTH_CLIENT_SECRET",
    "GITLAB_WEBHOOK_SECRET",
    "DEV_AUTH_SECRET",
}
SECRET_VALUES = [
    "gitlab.accessToken",
    "gitlab.webhookSecret",
    "auth.oauthClientSecret",
    "auth.jwtSecret",
    "devAuth.secret",
]
SERVICES = ("wingman-day1", "wingman-day2")


def by_kind(docs: list[dict[str, Any]], kind: str) -> dict[str, dict[str, Any]]:
    return {d["metadata"]["name"]: d for d in docs if d["kind"] == kind}


def secret_refs(docs: list[dict[str, Any]]) -> dict[str, list[str]]:
    """The Secrets each Deployment's containers load with envFrom."""
    return {
        name: [
            source["secretRef"]["name"]
            for container in doc["spec"]["template"]["spec"]["containers"]
            for source in container.get("envFrom") or []
            if "secretRef" in source
        ]
        for name, doc in by_kind(docs, "Deployment").items()
    }


def test_by_default_the_chart_renders_its_secret_and_the_oauth_client() -> None:
    docs = render("--set", "auth.oauthClientSecret=s3cret", "--set", "gitlab.accessToken=t0ken")
    secret = by_kind(docs, "Secret")["wingman-secrets"]
    assert set(secret["stringData"]) == SECRET_KEYS
    assert secret["stringData"]["GITLAB_TOKEN"] == "t0ken"
    client = by_kind(docs, "OAuthClient")["wingman-app"]
    assert client["secret"] == "s3cret"
    assert client["redirectURIs"] == ["https://wingman.apps.your-cluster.internal/login"]
    refs = secret_refs(docs)
    assert {name: refs[name] for name in SERVICES} == {
        name: ["wingman-secrets"] for name in SERVICES
    }
    assert refs["wingman-web"] == refs["wingman-nginx"] == []


@pytest.mark.parametrize(
    "switches",
    [
        ("--set", "secrets.existingSecret=", "--set", "auth.oauthClient.create=true"),
        # values kept from a release before 3.62 (helm upgrade --reuse-values)
        ("--set", "secrets=null", "--set", "auth.oauthClient=null"),
    ],
    ids=["defaults", "values-from-before-3.62"],
)
def test_the_switches_at_their_defaults_change_nothing(switches: tuple[str, ...]) -> None:
    assert render(*switches) == render()


def test_an_existing_secret_replaces_the_chart_s_own() -> None:
    result = template("-f", str(FIXTURE), tags=False)
    assert result.returncode == 0, result.stderr
    docs = render("-f", str(FIXTURE))
    assert by_kind(docs, "Secret") == {}
    assert by_kind(docs, "OAuthClient") == {}
    refs = secret_refs(docs)
    assert {name: refs[name] for name in SERVICES} == {name: [EXISTING] for name in SERVICES}
    assert "wingman-secrets" not in result.stdout


@pytest.mark.parametrize("key", SECRET_VALUES)
def test_a_secret_in_the_values_beside_an_existing_secret_fails_naming_it(key: str) -> None:
    refused = template("-f", str(FIXTURE), "--set", f"{key}=x", tags=False)
    assert refused.returncode != 0
    assert f"{key} is set, but secrets.existingSecret names the Secret" in refused.stderr
    assert f"({EXISTING})" in refused.stderr


def test_an_existing_secret_needs_the_oauth_client_made_by_hand() -> None:
    refused = template("-f", str(FIXTURE), "--set", "auth.oauthClient.create=true", tags=False)
    assert refused.returncode != 0
    assert "set auth.oauthClient.create=false" in refused.stderr
    # No OAuthClient to render: dev login, or plain Kubernetes with an Ingress.
    for elsewhere in (
        ("--set", "devAuth.enabled=true"),
        ("--set", "openshiftRoute.enabled=false", "--set", "ingress.enabled=true"),
    ):
        docs = render("-f", str(FIXTURE), "--set", "auth.oauthClient.create=true", *elsewhere)
        assert by_kind(docs, "OAuthClient") == {}
        assert by_kind(docs, "Secret") == {}


def test_no_oauth_client_alone_keeps_the_chart_s_secret() -> None:
    docs = render("--set", "auth.oauthClient.create=false")
    assert by_kind(docs, "OAuthClient") == {}
    assert set(by_kind(docs, "Secret")["wingman-secrets"]["stringData"]) == SECRET_KEYS
    without = [d for d in render() if d["kind"] != "OAuthClient"]
    assert docs == without


def test_values_yaml_names_the_secret_s_keys_the_services_read() -> None:
    """The header's `oc create secret` line and the optional keys are the chart Secret's keys."""
    header = (CHART / "values.yaml").read_text(encoding="utf-8").split("# ── Container images")[0]
    named = set(re.findall(r"--from-literal=([A-Z][A-Z0-9_]*)=", header))
    assert named == {"GITLAB_TOKEN", "JWT_SECRET_KEY", "OPENSHIFT_OAUTH_CLIENT_SECRET"}
    optional = {"GITLAB_WEBHOOK_SECRET", "DEV_AUTH_SECRET"}
    assert all(key in header for key in optional)
    assert named | optional == SECRET_KEYS
    assert not SECRET_KEYS - set(read_by_services()), "a key no service reads"
