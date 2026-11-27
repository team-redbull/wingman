"""Each zone's NodePool labels its Nodes with its zone (ADR-0072's 2026-11-28 amendments).

The naming convention (kubevirt-workflows ``docs/naming-convention.md`` §3.2,
§3.3): a NodePool "sets ``topology.kubernetes.io/zone`` on its Nodes", from
its ``nodeLabels``. The platform reads it there: the upgrade workflow takes a
NodePool's zone from the day1 entry's ``nodeLabels``, upgrades a cluster as
zoned (its zoned soak) only when a NodePool has one, and rolls NodePools zone
by zone only when every one has one; tenant workloads spread by it
(``topologySpreadConstraints``). So Wingman writes it on every NodePool it
adds, and never on one that exists:

- **At create** (:func:`with_zone_labels`): every agent nodepool whose
  InfraEnv follows the convention gets ``node_labels[topology.kubernetes.io/zone]``
  = that InfraEnv's zone, merged with the person's node labels: each zone of
  a logical nodepool its own, a one-zone node type and a KV cluster's too. A
  value the request gives for the key that is not each NodePool's own zone is
  refused (:func:`input_problems`); a flavor never presets it
  (:func:`flavor_problems`). The rendered file must hold it
  (:func:`rendered_problems`).
- **An existing NodePool's label is never added, changed or removed** (the
  user, 2026-11-28: "the fix will be create new Nodepool"): changing a
  NodePool's ``nodeLabels`` may apply in place or only to new Nodes, and under
  ``upgradeType: Replace`` a NodePool change can replace every worker. The key
  is never part of the one configuration a flavor locks (``value_drift``), and
  a sync that sets drifted node labels keeps the file's zone label, if it has
  one, and adds none (:func:`with_own_zone`). A NodePool of a convention
  InfraEnv without it (made before Wingman labelled zones) is listed, never
  fixed (:func:`zone_labels_missing`): a new NodePool is the way to Nodes
  labelled with their zone.

An InfraEnv off the convention names no zone Wingman can trust at create, so
Wingman writes none for it, and a label a person set there is theirs.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, cast

from wingman_day1.domain.node_types import ZONE_LABEL, parse
from wingman_day1.domain.nodepool_names import infra_env_of, rendered_name
from wingman_day1.domain.zone_inputs import zone_infra_envs

INPUT: Final = "node_labels"
FILE_KEY: Final = "nodeLabels"
GUIDE: Final = "docs/upgrade/3.70-to-3.71.md"


def zone_of(infra_env: object) -> str | None:
    """The zone a convention InfraEnv's name gives (``az1`` for ``r760-mtl-az1``); else ``None``."""
    found = parse(infra_env) if isinstance(infra_env, str) else None
    return found.zone if found else None


def _mapping(value: object) -> dict[str, object]:
    return dict(cast("Mapping[str, object]", value)) if isinstance(value, Mapping) else {}


def _pools(values: Mapping[str, object], key: str) -> list[tuple[int, Mapping[str, object]]]:
    raw = values.get(key)
    items = cast("Sequence[object]", raw) if isinstance(raw, (list, tuple)) else []
    return [
        (i, cast("Mapping[str, object]", p)) for i, p in enumerate(items) if isinstance(p, Mapping)
    ]


def without_zone(labels: object) -> object:
    """A file entry's ``nodeLabels`` without the zone key: never a flavor's to lock."""
    if not isinstance(labels, Mapping):
        return labels
    return {k: v for k, v in cast("Mapping[str, object]", labels).items() if k != ZONE_LABEL}


def with_own_zone(labels: object, have: object) -> object:
    """``labels`` (a flavor's) with the zone label the file's ``have`` gives, if it gives one.

    A sync that sets an existing NodePool's node labels keeps its zone label as it
    is: it never adds one, changes one or drops one.
    """
    zone = _mapping(have).get(ZONE_LABEL)
    if zone is None or not isinstance(labels, Mapping):
        return labels
    return {**cast("Mapping[str, object]", labels), ZONE_LABEL: zone}


def with_zone_labels(inputs: Mapping[str, object]) -> dict[str, object]:
    """The render's (physical) nodepools, each of a convention InfraEnv labelled with its zone."""
    raw = inputs.get("nodepools")
    if not isinstance(raw, (list, tuple)):
        return dict(inputs)
    out: list[object] = []
    for item in cast("Sequence[object]", raw):
        zone = zone_of(item.get("infra_env")) if isinstance(item, Mapping) else None
        if zone is None:
            out.append(item)
            continue
        pool = cast("Mapping[str, object]", item)
        out.append({**pool, INPUT: {**_mapping(pool.get(INPUT)), ZONE_LABEL: zone}})
    return {**inputs, "nodepools": out}


def input_problems(inputs: Mapping[str, object]) -> list[str]:
    """A create's node labels that give the zone key another value than each NodePool's zone."""
    problems: list[str] = []
    for index, pool in _pools(inputs, "nodepools"):
        given = _mapping(pool.get(INPUT)).get(ZONE_LABEL)
        if given is None:
            continue
        infra_envs = zone_infra_envs(pool) or [pool.get("infra_env")]
        zones = [(str(env), zone) for env in infra_envs if (zone := zone_of(env)) is not None]
        if any(zone != given for _, zone in zones):
            own = ", ".join(f"{env}: {zone}" for env, zone in zones)
            problems.append(
                f"nodepools[{index}].{INPUT}: {ZONE_LABEL} is Wingman's, each NodePool's own "
                f"zone ({own}); leave it out"
            )
    return problems


def flavor_problems(values: Mapping[str, object]) -> list[str]:
    """A flavor never presets or locks the zone key: each cluster's NodePools get their own."""
    return [
        f"nodepools[{index}].{INPUT}: {ZONE_LABEL} is each zone's NodePool's own, which Wingman "
        "writes at create; a flavor does not set it"
        for index, pool in _pools(values, "nodepools")
        if ZONE_LABEL in _mapping(pool.get(INPUT))
    ]


def rendered_problems(inputs: Mapping[str, object], rendered: Mapping[str, object]) -> list[str]:
    """Each rendered nodepool that does not label its Nodes with the zone its input gave."""
    written = dict(_pools(rendered, "nodepool"))
    problems: list[str] = []
    for index, pool in _pools(inputs, "nodepools"):
        want = _mapping(pool.get(INPUT)).get(ZONE_LABEL)
        entry = written.get(index)
        if want is None or entry is None or _mapping(entry.get(FILE_KEY)).get(ZONE_LABEL) == want:
            continue
        problems.append(
            f"nodepool[{index}].{FILE_KEY}: the template wrote no {ZONE_LABEL}: {want}; the specs "
            f"project's cluster-template.j2 must render node_labels as nodeLabels ({GUIDE})"
        )
    return problems


@dataclass(frozen=True, slots=True)
class ZoneLabelMissing:
    """A NodePool of a convention InfraEnv whose ``nodeLabels`` lack its zone: told, never fixed."""

    index: int
    name: str
    """The NodePool the chart renders (``nodepool_names.rendered_name``)."""
    zone: str
    """Its InfraEnv's zone, which its Nodes are not labelled with."""


def zone_labels_missing(
    values: Mapping[str, object], *, cluster_name: str
) -> tuple[ZoneLabelMissing, ...]:
    """The file's NodePools whose InfraEnv names a zone their Nodes are not labelled with.

    Made before Wingman labelled zones: their Nodes carry no zone label, a sync
    never changes an existing NodePool, and a new NodePool gets its zone.
    """
    found: list[ZoneLabelMissing] = []
    for index, entry in _pools(values, "nodepool"):
        zone = zone_of(infra_env_of(entry))
        if zone is not None and ZONE_LABEL not in _mapping(entry.get(FILE_KEY)):
            name = rendered_name(entry, cluster_name=cluster_name) or f"nodepool[{index}]"
            found.append(ZoneLabelMissing(index, name, zone))
    return tuple(found)
