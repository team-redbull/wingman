#!/usr/bin/env python3
"""Wingman's chart in redbull-platform, as each release deploys it (ADR-0070).

    python3 scripts/platform_chart.py write PLATFORM --chart CHART --version X.Y.Z --registry REG
    python3 scripts/platform_chart.py images RENDERED --version X.Y.Z --registry REG

PLATFORM is a redbull-platform checkout, CHART ``deploy/helm/wingman``, REG
``ghcr.io/<owner>`` (where CI published the images) and RENDERED a file of
``helm template``'s output.

``write`` makes ``PLATFORM/gitops/charts/wingman/`` the chart exactly (a file
removed from the chart is removed from the copy) with two changes: each Wingman
image is ``REG/wingman-<name>`` at the release (its ``repository`` and ``tag``
lines), and ``Chart.yaml``'s ``version`` and ``appVersion`` are the release.
``image.registry`` stays empty: it would prefix nginx's Red Hat image too. The
copy's ``values.yaml`` keeps Wingman's generic defaults: a cluster's settings
are redbull-platform's hand-kept ``gitops/overrides/wingman.yaml``, which no
release touches. A copy of a newer release is left as it is, so re-running an
old release's job never deploys it again. ``images`` checks a render of the
copy pulls the three Wingman images from REG at the release, and nothing else
from REG. Standard library only: it runs on a bare runner.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

COPY = Path("gitops/charts/wingman")
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
REGISTRY = re.compile(r"^[^\s/:]+(:\d+)?(/[a-z0-9._-]+)*$")
IMAGES = ("day1", "day2", "web")
TOP_LEVEL = re.compile(r"^[^\s#]")
IMAGE_ENTRY = re.compile(r"^  ([A-Za-z0-9]+):")
EMPTY_REGISTRY = re.compile(r'^  registry: ""')
REPOSITORY_LINE = re.compile(r"^(    repository: )\S+")
TAG_LINE = re.compile(r'^(    tag: )"[^"]*"')
CHART_VERSION = re.compile(r'^version: *"?([^"\s]+)"? *$', re.MULTILINE)
CHART_APP_VERSION = re.compile(r"^appVersion: .*$", re.MULTILINE)
RENDERED_IMAGE = re.compile(r'^\s*image: "?([^"\s]+)"?\s*$', re.MULTILINE)
WINGMAN_IMAGE = re.compile(
    r"^(?:.+/)?wingman-(?P<name>day1|day2|web):(?P<tag>[^@]+)(?:@sha256:[0-9a-f]{64})?$"
)


class ChartError(Exception):
    """The chart, the copy or a render is not what the release job expects."""


def semver(version: str) -> tuple[int, int, int] | None:
    """``X.Y.Z`` as numbers, comparable; ``None`` for anything else."""
    match = SEMVER.match(version)
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return major, minor, patch


def set_values(text: str, version: str, registry: str) -> str:
    """``values.yaml`` with each Wingman image ``<registry>/wingman-<name>:<version>``.

    Edited line by line, never re-emitted: the file is the chart's documented
    defaults, and every other line, comments included, stays byte-identical.
    The chart's ``image.registry`` must be empty, or it would prefix these too.
    """
    lines = text.splitlines(keepends=True)
    found = {"empty image.registry": 0}
    found |= {f"image.{name}.{key}": 0 for name in IMAGES for key in ("repository", "tag")}
    in_image, entry = False, ""
    for index, line in enumerate(lines):
        if TOP_LEVEL.match(line):
            in_image, entry = line.startswith("image:"), ""
            continue
        if not in_image:
            continue
        if match := IMAGE_ENTRY.match(line):
            entry = match.group(1)
        if EMPTY_REGISTRY.match(line):
            found["empty image.registry"] += 1
        elif entry in IMAGES and REPOSITORY_LINE.match(line):
            lines[index] = REPOSITORY_LINE.sub(rf"\g<1>{registry}/wingman-{entry}", line)
            found[f"image.{entry}.repository"] += 1
        elif entry in IMAGES and TAG_LINE.match(line):
            lines[index] = TAG_LINE.sub(rf'\g<1>"{version}"', line)
            found[f"image.{entry}.tag"] += 1
    wrong = sorted(key for key, count in found.items() if count != 1)
    if wrong:
        raise ChartError(f"values.yaml: expected one line for each of {wrong}, found {found}")
    return "".join(lines)


def set_chart(text: str, version: str) -> str:
    """``Chart.yaml`` with ``version`` and ``appVersion`` the release."""
    text, versions = CHART_VERSION.subn(f"version: {version}", text)
    text, app_versions = CHART_APP_VERSION.subn(f'appVersion: "{version}"', text)
    if (versions, app_versions) != (1, 1):
        raise ChartError("Chart.yaml: expected one version line and one appVersion line")
    return text


def write(platform: Path, chart: Path, version: str, registry: str) -> str:
    """Write the copy for ``version``, unless it holds a newer release; say which."""
    release = semver(version)
    if release is None:
        raise ChartError(f"{version!r} is not a release version (X.Y.Z)")
    if not REGISTRY.match(registry):
        raise ChartError(f"{registry!r} is not a registry path (host[/path], no scheme)")
    if not (chart / "Chart.yaml").is_file():
        raise ChartError(f"{chart} is not a chart: it has no Chart.yaml")
    copy = platform / COPY
    if (copy / "Chart.yaml").is_file():
        current = CHART_VERSION.search((copy / "Chart.yaml").read_text(encoding="utf-8"))
        held = current.group(1) if current else ""
        if (semver(held) or (0, 0, 0)) > release:
            return f"{COPY} holds {held}, newer than {version}: left as it is"
    if copy.exists():
        shutil.rmtree(copy)
    shutil.copytree(chart, copy)
    values = copy / "values.yaml"
    values.write_text(set_values(values.read_text(encoding="utf-8"), version, registry), "utf-8")
    meta = copy / "Chart.yaml"
    meta.write_text(set_chart(meta.read_text(encoding="utf-8"), version), "utf-8")
    return f"{COPY} written: the chart, the images {registry}/wingman-{{day1,day2,web}}:{version}"


def check_images(rendered: str, version: str, registry: str) -> list[str]:
    """The Wingman images a render names: the three, each ``<registry>/wingman-<name>:<version>``.

    Any other image under ``registry`` is refused too: ``image.registry`` set
    by an override file prefixes nginx's Red Hat image, which is not there.
    """
    images = set(RENDERED_IMAGE.findall(rendered))
    matches = {image: match for image in images if (match := WINGMAN_IMAGE.match(image))}
    found = sorted(matches)
    names = set()
    for image, match in matches.items():
        expected = f"{registry}/wingman-{match.group('name')}:{version}"
        if image.split("@")[0] != expected:
            raise ChartError(f"the render pulls {image}, not the release's {expected}")
        names.add(match.group("name"))
    if names != set(IMAGES):
        raise ChartError(f"the render names the Wingman images {found}, not day1, day2 and web")
    for image in sorted(images - set(matches)):
        if image.startswith(f"{registry}/"):
            raise ChartError(f"the render pulls {image} from {registry}: is image.registry set?")
    return found


def main(argv: list[str] | None = None) -> int:
    """Run one subcommand; a refusal is one ``::error::`` line and exit 1."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    write_cmd = commands.add_parser("write", help="write the chart copy into a checkout")
    write_cmd.add_argument("platform", type=Path, help="the redbull-platform checkout")
    write_cmd.add_argument("--chart", type=Path, required=True, help="deploy/helm/wingman")
    write_cmd.add_argument("--version", required=True, help="X.Y.Z, the release")
    write_cmd.add_argument("--registry", required=True, help="ghcr.io/<owner>")
    images_cmd = commands.add_parser("images", help="check a render's Wingman images")
    images_cmd.add_argument("rendered", type=Path, help="helm template's output")
    images_cmd.add_argument("--version", required=True)
    images_cmd.add_argument("--registry", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "write":
            print(write(args.platform, args.chart, args.version, args.registry))
        else:
            rendered = args.rendered.read_text(encoding="utf-8")
            print("\n".join(check_images(rendered, args.version, args.registry)))
    except ChartError as exc:
        print(f"::error::{exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
