"""A NodePool's name: its InfraEnv, then an optional suffix (ADR-0071).

The user's rule (2026-11-25): "Each nodepool should contain the name of the
infraenv it's pulling from." A NodePool Wingman adds is named ``<InfraEnv>``
or ``<InfraEnv>-<suffix>``. The InfraEnv part is its ``infraEnvName`` and is
never typed; a person may add only the suffix, which is what lets several
NodePools draw from one InfraEnv (one zone). There is no cluster prefix: the
hostedclusters-setup chart puts every NodePool in its cluster's own namespace,
``hcp-<clusterName>``, so a name is unique within one cluster only. Wingman
writes the name into the file (``name:``) and never leaves the chart to derive
``<clusterName>-<infraEnvName>``.

The name is a label value on every Node the NodePool makes (HyperShift's
``hypershift.openshift.io/nodePool``), so it is a DNS-1123 label of at most
:data:`MAX_NAME` characters. The objects HyperShift and CAPI make from it add
no tighter limit: the MachineDeployment is named after the NodePool, and its
MachineSets, Machines and machine templates add a hash or a random part to
object names of up to 253 characters, hashed by HyperShift when longer.

Where the rule applies:

- **A create** (a tenant's, from a flavor, and a KV cluster's;
  ``rendered_file``): each agent nodepool's ``name_suffix`` (the form's
  input, never rendered) and ``infra_env`` make the template input
  ``nodepool_name``; a ``nodepool_name`` sent as such must follow the rule.
  Names are unique within the cluster, so two nodepools on one InfraEnv need
  different suffixes and at most one of them none. The rendered file must
  hold each name as given.
- **A flavor's save** (``specs.rule_problems``): a preset ``name_suffix`` is
  a suffix; a preset ``nodepool_name`` is refused, its InfraEnv part being
  the cluster's.
- **An edit** (``cluster_file.edit_problems``): a NodePool the edit adds
  writes a name by the rule. An existing NodePool keeps its name, whatever its
  shape, and is never checked against the rule: renaming one deletes it and
  creates another with new nodes, so Wingman never renames one (Edit cluster
  shows existing names read-only, and nothing Wingman writes changes one).

Everything that finds a NodePool by name reads both shapes with
:func:`rendered_name` (``name``, else ``<clusterName>-<infraEnvName>``), and
the edit rules match an entry across two versions of a file with
:func:`entry_key`. A KubeVirt nodepool without an InfraEnv draws from none:
its name is the file's, as before.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Final, cast

from wingman_day1.domain.names import dns_label_problems
from wingman_day1.domain.template import FieldType, TemplateField
from wingman_day1.domain.zone_inputs import zone_infra_envs

SUFFIX_INPUT: Final = "name_suffix"
"""The form's input in each ``nodepools[]`` entry: the part a person adds. Never rendered."""
NAME_INPUT: Final = "nodepool_name"
"""The template input: the whole name, which the template writes as the entry's ``name``."""
INFRA_ENV_INPUT: Final = "infra_env"
FILE_KEY: Final = "name"
MAX_NAME: Final = 63
"""A label value's limit: the NodePool's name labels each of its Nodes."""
GUIDE: Final = "docs/upgrade/3.65-to-3.66.md"
DERIVED_PREFIX: Final = "<clusterName>"
"""Stands for the chart's ``clusterName`` where it is not known: no real name holds ``<``."""
_SUFFIX = re.compile(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?")
_RULE: Final = "<InfraEnv> or <InfraEnv>-<suffix>"


def nodepool_entries(
    values: Mapping[str, object], key: str
) -> list[tuple[int, Mapping[str, object]]]:
    """The mappings of the list at ``key`` (``nodepools`` or ``nodepool``), with their positions."""
    pools = values.get(key)
    if not isinstance(pools, (list, tuple)):
        return []
    items = cast("Sequence[object]", pools)
    return [
        (i, cast("Mapping[str, object]", p)) for i, p in enumerate(items) if isinstance(p, Mapping)
    ]


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def compose(infra_env: str, suffix: str | None = None) -> str:
    """A new NodePool's name: ``<infra_env>``, or ``<infra_env>-<suffix>``."""
    return f"{infra_env}-{suffix}" if suffix else infra_env


def follows_rule(name: str, infra_env: str) -> bool:
    """Whether ``name`` is ``infra_env``, or ``infra_env`` and a valid suffix."""
    if name == infra_env:
        return True
    suffix = name.removeprefix(f"{infra_env}-")
    return suffix != name and _SUFFIX.fullmatch(suffix) is not None


def suffix_problems(where: str, suffix: object) -> list[str]:
    """Why ``suffix`` is not the end of a DNS-1123 label; empty when it is (or is none)."""
    if suffix is None or suffix == "":
        return []
    if not isinstance(suffix, str):
        return [f"{where}: must be text"]
    if _SUFFIX.fullmatch(suffix):
        return []
    return [
        f"{where}: {suffix!r} must be lowercase letters, digits and '-', starting and ending "
        "with a letter or digit"
    ]


def name_problems(where: str, name: str, infra_env: str) -> list[str]:
    """Why ``name`` is not a new NodePool's name for ``infra_env``; empty when it is."""
    if not follows_rule(name, infra_env):
        return [
            f"{where}: {name!r} is not {_RULE} for InfraEnv {infra_env}: a new NodePool is "
            "named after the InfraEnv it draws from (ADR-0071)"
        ]
    return [f"{where}: {p}" for p in dns_label_problems(name, what="NodePool name")]


# ── Both shapes, wherever a NodePool is found by name ───────────────────────


def infra_env_of(entry: Mapping[str, object]) -> str | None:
    """The InfraEnv a file entry draws from, as the chart reads it.

    ``infraEnvName``, else its ``agentLabelSelector.nodeLabelValue``.
    """
    selector = entry.get("agentLabelSelector")
    label = None
    if isinstance(selector, Mapping):
        label = cast("Mapping[str, object]", selector).get("nodeLabelValue")
    found = entry.get("infraEnvName") or label
    return str(found) if found else None


def rendered_name(entry: Mapping[str, object], *, cluster_name: str) -> str | None:
    """The NodePool the chart renders for a file entry; ``None`` when it names none.

    Its ``name`` (every NodePool Wingman adds since ADR-0071), else
    ``<clusterName>-<InfraEnv>`` (the chart's default, which older files use).
    """
    if entry.get(FILE_KEY):
        return str(entry[FILE_KEY])
    infra_env = infra_env_of(entry)
    return f"{cluster_name}-{infra_env}" if infra_env else None


def entry_key(index: int, entry: Mapping[str, object], cluster_name: str | None = None) -> str:
    """What matches a file entry with itself in another version of the file: its NodePool.

    Without ``cluster_name`` a derived name keeps ``<clusterName>`` as it is,
    so a NodePool named ``c200-mtl-az1`` is never taken for the one the chart
    derives from the same InfraEnv. ``#<index>`` when the entry names none.
    """
    return rendered_name(entry, cluster_name=cluster_name or DERIVED_PREFIX) or f"#{index}"


# ── Create and flavor save: the inputs ──────────────────────────────────────


def form_schema(schema: Sequence[TemplateField]) -> list[TemplateField]:
    """The form's schema: a nodepool's ``nodepool_name`` is offered as its ``name_suffix``."""
    suffix = TemplateField(SUFFIX_INPUT, FieldType.STRING, False, "", has_default=True)
    return [
        replace(field, fields=tuple(suffix if f.name == NAME_INPUT else f for f in field.fields))
        if field.name == "nodepools"
        else field
        for field in schema
    ]


def name_of(pool: Mapping[str, object]) -> str | None:
    """A nodepool input's NodePool name: ``nodepool_name`` as sent, else its InfraEnv and suffix.

    ``None`` without an InfraEnv (a KubeVirt nodepool): its name is the template's.
    """
    infra_env = _text(pool.get(INFRA_ENV_INPUT))
    if infra_env is None:
        return None
    suffix = pool.get(SUFFIX_INPUT)
    if isinstance(suffix, str) and suffix:
        return compose(infra_env, suffix)
    return _text(pool.get(NAME_INPUT)) or infra_env


def _pool_problems(
    where: str, pool: Mapping[str, object], *, preset: bool
) -> tuple[list[str], str | None, str]:
    """One nodepool input's problems, its NodePool name and the path a clash is shown at.

    A clash is fixed by a suffix, so it is shown at the suffix; a name too
    long without one, at the InfraEnv.
    """
    suffix, sent = pool.get(SUFFIX_INPUT), _text(pool.get(NAME_INPUT))
    at = f"{where}.{SUFFIX_INPUT}"
    problems = suffix_problems(at, suffix)
    given = suffix not in (None, "")
    if preset and sent is not None:
        problems.append(
            f"{where}.{NAME_INPUT}: a NodePool is named after the cluster's InfraEnv "
            f"({_RULE}, ADR-0071); preset {SUFFIX_INPUT} instead"
        )
        return problems, None, at
    infra_env = _text(pool.get(INFRA_ENV_INPUT))
    if infra_env is None:
        if given and not preset:
            problems.append(f"{at}: a suffix follows the nodepool's InfraEnv, and it has none")
        return problems, None, at
    name = name_of(pool) or infra_env
    if problems:
        return problems, name, at
    if sent is not None and given and sent != name:
        problems.append(f"{where}.{NAME_INPUT}: {sent!r} is not {name!r}, its InfraEnv and suffix")
        return problems, name, at
    shown = at if given else f"{where}.{NAME_INPUT if sent is not None else INFRA_ENV_INPUT}"
    return name_problems(shown, name, infra_env), name, at


def _zone_names(
    where: str, pool: Mapping[str, object], zones: list[str]
) -> tuple[list[str], list[str]]:
    """A logical nodepool's problems and its NodePools' names, one per zone (ADR-0072).

    Every zone's NodePool is ``<zone's InfraEnv>[-<suffix>]``: the suffix is
    the nodepool's, shared by its zones.
    """
    at, suffix = f"{where}.{SUFFIX_INPUT}", pool.get(SUFFIX_INPUT)
    problems = suffix_problems(at, suffix)
    if _text(pool.get(NAME_INPUT)) is not None:
        problems.append(
            f"{where}.{NAME_INPUT}: a nodepool spread over zones is named per zone from its "
            f"{SUFFIX_INPUT}"
        )
    if problems:
        return problems, []
    names = [compose(zone, suffix if isinstance(suffix, str) else None) for zone in zones]
    for i, (name, zone) in enumerate(zip(names, zones, strict=True)):
        shown = at if suffix else f"{where}.zones[{i}].{INFRA_ENV_INPUT}"
        problems += name_problems(shown, name, zone)
    return problems, names


def input_problems(inputs: Mapping[str, object], *, preset: bool = False) -> list[str]:
    """Why the nodepools' names may not be used: a create's (or, ``preset``, a flavor's).

    Each suffix is a DNS-1123 label's end; a ``nodepool_name`` follows the
    rule (a flavor may not preset one: the InfraEnv is the cluster's); each
    name is at most :data:`MAX_NAME` and the cluster's only one. A flavor's
    nodepool without an InfraEnv is named at create; a logical nodepool's
    NodePools are named per zone (``zone_inputs``, ADR-0072).
    """
    problems: list[str] = []
    seen: dict[str, int] = {}
    for index, pool in nodepool_entries(inputs, "nodepools"):
        where, zones = f"nodepools[{index}]", zone_infra_envs(pool)
        if zones is None:
            found, name, at = _pool_problems(where, pool, preset=preset)
            names = [] if name is None else [name]
        else:
            (found, names), at = _zone_names(where, pool, zones), f"{where}.{SUFFIX_INPUT}"
        problems += found
        for name in names:
            if seen.get(name, index) != index:
                problems.append(
                    f"{at}: NodePool {name} is nodepools[{seen[name]}]'s already; nodepools on one "
                    "InfraEnv need different suffixes, and at most one may have none"
                )
            seen.setdefault(name, index)
    return problems


def with_names(inputs: Mapping[str, object]) -> dict[str, object]:
    """The render's inputs: each nodepool's ``nodepool_name`` set, its ``name_suffix`` dropped."""
    pools = inputs.get("nodepools")
    if not isinstance(pools, (list, tuple)):
        return dict(inputs)
    named: list[object] = []
    for raw in cast("Sequence[object]", pools):
        if not isinstance(raw, Mapping):
            named.append(raw)
            continue
        pool = cast("Mapping[str, object]", raw)
        entry = {k: v for k, v in pool.items() if k != SUFFIX_INPUT}
        if (name := name_of(pool)) is not None:
            entry[NAME_INPUT] = name
        named.append(entry)
    return {**inputs, "nodepools": named}


def rendered_problems(inputs: Mapping[str, object], rendered: Mapping[str, object]) -> list[str]:
    """Each rendered nodepool whose ``name`` is not the one :func:`with_names` gave it.

    The guard against a specs-project template that does not render
    ``nodepool_name``: the chart would derive ``<clusterName>-<infraEnvName>``.
    """
    asked = dict(nodepool_entries(inputs, "nodepools"))
    problems: list[str] = []
    for index, pool in nodepool_entries(rendered, "nodepool"):
        want = _text(asked.get(index, {}).get(NAME_INPUT))
        if want is not None and pool.get(FILE_KEY) != want:
            problems.append(
                f"nodepool[{index}].{FILE_KEY}: the template wrote {pool.get(FILE_KEY)!r} for "
                f"{want!r}; the specs project's cluster-template.j2 must render {NAME_INPUT} as "
                f"the nodepool's name ({GUIDE})"
            )
    return problems


# ── Edits of an existing file ────────────────────────────────────────────────


def edit_problems(
    old: Mapping[str, object], new: Mapping[str, object], *, cluster_name: str | None = None
) -> list[str]:
    """Why an edit's NodePool names may not be proposed; empty when they may (see the module).

    An entry whose NodePool the file had keeps it, by either shape, and is
    never checked. One it did not have is a NodePool the edit adds: an agent
    one writes a name by the rule. ``cluster_name`` is the chart's
    ``clusterName``, when known. Wingman itself never renames a NodePool; one
    a person's text replaces is the review's to see, as before (ADR-0064), and
    its replacement is a new NodePool, named by the rule.
    """
    before = {entry_key(i, e, cluster_name) for i, e in nodepool_entries(old, "nodepool")}
    problems: list[str] = []
    for index, entry in nodepool_entries(new, "nodepool"):
        if entry_key(index, entry, cluster_name) in before:
            continue
        where = f"nodepool[{index}]"
        infra_env = _text(entry.get("infraEnvName"))
        if infra_env is None:
            continue
        name = _text(entry.get(FILE_KEY))
        if name is None:
            problems.append(
                f"{where}: a new NodePool is named {_RULE} (ADR-0071); write name: {infra_env}, "
                f"or {infra_env}-<suffix>"
            )
        else:
            problems += name_problems(f"{where}.{FILE_KEY}", name, infra_env)
    return problems
