"""Each release's chart in redbull-platform (ADR-0070): the copy CI writes, the job that pushes it.

The copy is the chart exactly, but for the three Wingman images (repository and
tag) and Chart.yaml's versions, and renders Red Hat's nginx as the chart does; a
newer release's copy is never replaced by an older one; a render that does not
pull the release is refused. The ``platform`` job
runs on main only, after the images are published, with no write permission of
its own, and says in one error what to do when the organisation's token does
not reach this repository.
"""

from __future__ import annotations

import filecmp
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "deploy/helm/wingman"
REGISTRY = "ghcr.io/team-redbull"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "wingman_ci_platform_chart", ROOT / "scripts/platform_chart.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


platform_chart = _load()


def _changed(left: Path, right: Path) -> set[str]:
    """Every file that differs or exists on one side only, relative to the chart."""
    compared = filecmp.dircmp(left, right)
    found = {*compared.diff_files, *compared.left_only, *compared.right_only}
    for name in compared.subdirs:
        found |= {f"{name}/{path}" for path in _changed(left / name, right / name)}
    return found


class TestTheCopy:
    def test_it_is_the_chart_but_for_the_wingman_images_and_the_versions(
        self, tmp_path: Path
    ) -> None:
        said = platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        copy = tmp_path / "gitops/charts/wingman"
        assert "written" in said
        assert _changed(CHART, copy) == {"values.yaml", "Chart.yaml"}
        values = yaml.safe_load((copy / "values.yaml").read_text(encoding="utf-8"))
        original = yaml.safe_load((CHART / "values.yaml").read_text(encoding="utf-8"))
        for name in ("day1", "day2", "web"):
            image = values["image"].pop(name)
            expected = {**original["image"].pop(name), "tag": "3.62.0"}
            assert image == {**expected, "repository": f"{REGISTRY}/wingman-{name}"}
        # image.registry stays empty: it would prefix nginx's Red Hat image too
        assert values == original
        meta = yaml.safe_load((copy / "Chart.yaml").read_text(encoding="utf-8"))
        assert (meta["version"], meta["appVersion"]) == ("3.62.0", "3.62.0")

    def test_only_the_edited_lines_change(self, tmp_path: Path) -> None:
        platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        before = (CHART / "values.yaml").read_text(encoding="utf-8").splitlines()
        after = (tmp_path / "gitops/charts/wingman/values.yaml").read_text("utf-8").splitlines()
        changed = [(a, b) for a, b in zip(before, after, strict=True) if a != b]
        assert changed == [
            (f"    {key}: {old}", f"    {key}: {new}")
            for name in ("day1", "day2", "web")
            for key, old, new in (
                ("repository", f"wingman-{name}", f"{REGISTRY}/wingman-{name}"),
                ("tag", '""', '"3.62.0"'),
            )
        ]

    def test_a_file_the_chart_no_longer_has_leaves_the_copy(self, tmp_path: Path) -> None:
        stale = tmp_path / "gitops/charts/wingman/templates/removed.yaml"
        stale.parent.mkdir(parents=True)
        stale.write_text("kind: Gone\n", encoding="utf-8")
        platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        assert not stale.exists()

    def test_a_rerun_writes_the_same_bytes(self, tmp_path: Path) -> None:
        platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        first = tmp_path / "first"
        shutil.copytree(tmp_path / "gitops/charts/wingman", first)
        platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        assert _changed(first, tmp_path / "gitops/charts/wingman") == set()

    def test_a_newer_release_s_copy_is_left_as_it_is(self, tmp_path: Path) -> None:
        platform_chart.write(tmp_path, CHART, "3.63.0", REGISTRY)
        said = platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        assert said.endswith("holds 3.63.0, newer than 3.62.0: left as it is")
        meta = (tmp_path / "gitops/charts/wingman/Chart.yaml").read_text(encoding="utf-8")
        assert "version: 3.63.0" in meta

    @pytest.mark.parametrize(
        ("version", "registry", "words"),
        [
            ("3.62", REGISTRY, "not a release version"),
            ("v3.62.0", REGISTRY, "not a release version"),
            ("3.62.0", "https://ghcr.io/team-redbull", "not a registry path"),
            ("3.62.0", "", "not a registry path"),
        ],
    )
    def test_a_wrong_version_or_registry_is_refused(
        self, tmp_path: Path, version: str, registry: str, words: str
    ) -> None:
        with pytest.raises(platform_chart.ChartError, match=words):
            platform_chart.write(tmp_path, CHART, version, registry)
        assert not (tmp_path / "gitops").exists()

    def test_values_without_the_expected_image_lines_are_refused(self) -> None:
        text = (CHART / "values.yaml").read_text(encoding="utf-8")
        for broken, key in (
            (text.replace('  registry: ""', '  registry: "mirror.example"', 1), "empty image"),
            (text.replace("  web:\n", "  www:\n", 1), "image.web.repository"),
        ):
            with pytest.raises(platform_chart.ChartError, match=f"expected one line .*{key}"):
                platform_chart.set_values(broken, "3.62.0", REGISTRY)

    def test_the_copy_renders_the_release_s_images_and_red_hat_s_nginx(
        self, tmp_path: Path
    ) -> None:
        helm = shutil.which("helm")
        if helm is None:
            if os.environ.get("CI"):
                raise RuntimeError("the copy's render needs helm on PATH in CI")
            pytest.skip("helm is not installed")
        platform_chart.write(tmp_path, CHART, "3.62.0", REGISTRY)
        rendered = subprocess.run(  # noqa: S603 - a fixed argv, no shell
            [
                helm,
                "template",
                "wingman",
                str(tmp_path / "gitops/charts/wingman"),
                "-n",
                "wingman",
                "--set",
                "workflows.url=http://w.ns.svc:8080",
                "--set",
                "serverScan.url=http://s.ns.svc",
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        assert len(platform_chart.check_images(rendered, "3.62.0", REGISTRY)) == 3
        assert 'image: "registry.access.redhat.com/ubi9/nginx-124:9.8@sha256:' in rendered


IMAGES = [f'          image: "{REGISTRY}/wingman-{n}:3.62.0"' for n in ("day1", "day2", "web")]
NGINX = '          image: "registry.access.redhat.com/ubi9/nginx-124:9.8@sha256:' + "a" * 64 + '"'


class TestTheRender:
    def test_a_render_that_pulls_the_release_passes(self) -> None:
        rendered = "\n".join([*IMAGES, NGINX, IMAGES[0]])
        assert len(platform_chart.check_images(rendered, "3.62.0", REGISTRY)) == 3

    @pytest.mark.parametrize(
        ("lines", "words"),
        [
            (IMAGES[:2], "not day1, day2 and web"),
            ([*IMAGES[:2], IMAGES[2].replace("3.62.0", "3.61.0")], "not the release's"),
            ([*IMAGES[:2], IMAGES[2].replace(REGISTRY, "quay.io/other")], "not the release's"),
            (
                [*IMAGES, NGINX.replace('"registry', f'"{REGISTRY}/registry')],
                "is image.registry set",
            ),
        ],
    )
    def test_a_render_that_does_not_is_refused(self, lines: list[str], words: str) -> None:
        with pytest.raises(platform_chart.ChartError, match=words):
            platform_chart.check_images("\n".join([*lines, NGINX]), "3.62.0", REGISTRY)

    def test_main_says_a_refusal_in_one_error_line(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        rendered = tmp_path / "rendered.yaml"
        rendered.write_text(NGINX, encoding="utf-8")
        argv = ["images", str(rendered), "--version", "3.62.0", "--registry", REGISTRY]
        assert platform_chart.main(argv) == 1
        assert capsys.readouterr().out.startswith("::error::the render names the Wingman images")


JOBS: dict[str, Any] = yaml.safe_load(
    (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
)["jobs"]


class TestTheJob:
    def test_it_runs_on_main_after_the_images_are_published(self) -> None:
        job = JOBS["platform"]
        assert job["if"] == "github.event_name == 'push' && github.ref == 'refs/heads/main'"
        assert "publish" in job["needs"]
        assert job["permissions"] == {"contents": "read"}
        assert all("platform" not in (other.get("needs") or []) for other in JOBS.values())

    def test_a_missing_token_fails_first_saying_what_to_do(self) -> None:
        steps = JOBS["platform"]["steps"]
        first = steps[0]
        assert first["env"] == {"REDBULL_WRITE_TOKEN": "${{ secrets.REDBULL_WRITE_TOKEN }}"}
        assert "::error::" in first["run"]
        assert "repository access" in first["run"]
        for step in steps:
            if "uses" in step and "checkout" in step["uses"]:
                assert step["with"]["persist-credentials"] is False
