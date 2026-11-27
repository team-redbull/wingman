"""A logical nodepool on the create form: one node type, one config, a NodePool per zone (ADR-0072).

The user (2026-11-27): "the person should select and be given 3 different
nodepools, 1 for each zone, where each one contains the same config exactly
... Each logical nodepool I am giving the customer is behind the scenes 3
physical nodepools." A create's ``nodepools[i]`` may therefore be **logical**:

- ``node_type``: the node type (``r760-mtl``), a flavor's preset or the
  person's pick;
- ``zones``: ``[{infra_env, replicas}]``, one entry per zone of that node type
  on the MCE (``r760-mtl-az1``, ...), each with its own replicas; a zone
  without ``replicas`` takes the nodepool's.

Everything else in the nodepool (configs, node labels, tuning profiles, the
scale-down policy, the name suffix) is its one config. :func:`spread` turns
each logical nodepool into one **physical** nodepool per zone, in zone order,
each with that config, ``infra_env`` its zone's and its own replicas, before
the render: the template and the cluster file see physical nodepools only,
and no new key is written. A zone may have 0 replicas, so the group always
has its full shape; the nodepool needs at least one replica in all.

The positions a flavor's locks and its ratio name are the logical ones:
:func:`lock_conflicts` holds every zone to a locked ``replicas``, and the
ratio sizes every zone of a sized nodepool (``sizing``). A nodepool without
``zones`` is physical, as before. A flavor may preset ``node_type``, never
``zones`` (it knows no MCE): :func:`flavor_problems`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final, cast

from wingman_day1.domain.input_paths import InputPath
from wingman_day1.domain.names import dns_label_problems
from wingman_day1.domain.node_types import node_type_of

NODE_TYPE_INPUT: Final = "node_type"
"""A nodepool's node type: a flavor's preset, or what the person picked. Never rendered."""
ZONES_INPUT: Final = "zones"
"""A logical nodepool's zones, ``[{infra_env, replicas}]``. Never rendered: :func:`spread`."""
INFRA_ENV: Final = "infra_env"
REPLICAS: Final = "replicas"
OTHER_INFRA_ENVS: Final = "additional_infra_envs"
_FORM_ONLY: Final = frozenset({NODE_TYPE_INPUT, ZONES_INPUT})


def _pools(inputs: Mapping[str, object]) -> list[tuple[int, Mapping[str, object]]]:
    raw = inputs.get("nodepools")
    if not isinstance(raw, (list, tuple)):
        return []
    items = cast("Sequence[object]", raw)
    return [
        (i, cast("Mapping[str, object]", p)) for i, p in enumerate(items) if isinstance(p, Mapping)
    ]


def _zones(pool: Mapping[str, object]) -> list[object] | None:
    """The nodepool's ``zones`` as sent; ``None`` when it is physical (no ``zones``)."""
    zones = pool.get(ZONES_INPUT)
    if zones is None:
        return None
    return list(cast("Sequence[object]", zones)) if isinstance(zones, (list, tuple)) else [zones]


def is_logical(pool: Mapping[str, object]) -> bool:
    """Whether a nodepool input is spread over zones."""
    return ZONES_INPUT in pool


def zone_infra_envs(pool: Mapping[str, object]) -> list[str] | None:
    """A logical nodepool's zones' InfraEnvs, in order; ``None`` for a physical one."""
    zones = _zones(pool)
    if zones is None:
        return None
    found = [
        cast("Mapping[str, object]", z).get(INFRA_ENV) for z in zones if isinstance(z, Mapping)
    ]
    return [name for name in found if isinstance(name, str) and name]


def _whole(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def zone_replicas(pool: Mapping[str, object]) -> list[int | None] | None:
    """Each zone's replicas, the nodepool's where a zone gives none; ``None`` when physical."""
    zones = _zones(pool)
    if zones is None:
        return None
    own = _whole(pool.get(REPLICAS))
    found: list[int | None] = []
    for zone in zones:
        given = (
            cast("Mapping[str, object]", zone).get(REPLICAS) if isinstance(zone, Mapping) else None
        )
        found.append(own if given is None else _whole(given))
    return found


def _zone_problems(where: str, index: int, zone: object, node_type: str | None) -> list[str]:
    at = f"{where}.{ZONES_INPUT}[{index}]"
    if not isinstance(zone, Mapping):
        return [f"{at}: must be a mapping with infra_env and replicas"]
    entry = cast("Mapping[str, object]", zone)
    extra = sorted(str(k) for k in entry if k not in {INFRA_ENV, REPLICAS})
    problems = [f"{at}: has {', '.join(extra)}; a zone gives only infra_env and replicas"] * bool(
        extra
    )
    infra_env = entry.get(INFRA_ENV)
    if not isinstance(infra_env, str) or not infra_env:
        problems.append(f"{at}.{INFRA_ENV}: the zone's InfraEnv is required")
    else:
        problems += [
            f"{at}.{INFRA_ENV}: {p}" for p in dns_label_problems(infra_env, what="InfraEnv")
        ]
        if node_type is not None and node_type_of(infra_env) != node_type:
            problems.append(
                f"{at}.{INFRA_ENV}: {infra_env} is node type {node_type_of(infra_env)}, "
                f"not {node_type}; every zone of a nodepool is one node type"
            )
    replicas = entry.get(REPLICAS)
    if replicas is not None and (_whole(replicas) is None or cast("int", _whole(replicas)) < 0):
        problems.append(f"{at}.{REPLICAS}: must be a whole number of at least 0")
    return problems


def _logical_problems(where: str, pool: Mapping[str, object], zones: list[object]) -> list[str]:
    given = pool.get(NODE_TYPE_INPUT)
    node_type = given if isinstance(given, str) and given else None
    names = zone_infra_envs(pool) or []
    if node_type is None and names:
        node_type = node_type_of(names[0])
    problems: list[str] = []
    if not zones:
        problems.append(f"{where}.{ZONES_INPUT}: a nodepool spread over zones needs one at least")
    if pool.get(INFRA_ENV):
        problems.append(
            f"{where}.{INFRA_ENV}: a nodepool spread over zones names each zone's InfraEnv in "
            f"{ZONES_INPUT}, not {INFRA_ENV}"
        )
    if pool.get(OTHER_INFRA_ENVS):
        problems.append(
            f"{where}.{OTHER_INFRA_ENVS}: a nodepool spread over zones draws from its zones only"
        )
    for i, zone in enumerate(zones):
        problems += _zone_problems(where, i, zone, node_type)
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        problems.append(f"{where}.{ZONES_INPUT}: {', '.join(twice)} listed twice")
    counts = zone_replicas(pool) or []
    if zones and all(c is not None for c in counts) and sum(c or 0 for c in counts) < 1:
        problems.append(
            f"{where}.{ZONES_INPUT}: every zone has 0 replicas; a nodepool needs one at least"
        )
    return problems


def input_problems(inputs: Mapping[str, object]) -> list[str]:
    """Why a create's nodepools' node types and zones may not be used; empty when they may.

    A logical nodepool's zones are InfraEnvs of one node type (``node_type``
    when given), each once, with whole replicas of at least 0 and one at
    least in all; it names no ``infra_env`` of its own and draws from no
    other InfraEnvs. A physical one may give ``node_type`` only as its
    ``infra_env``'s.
    """
    problems: list[str] = []
    for index, pool in _pools(inputs):
        where = f"nodepools[{index}]"
        zones = _zones(pool)
        if zones is not None:
            problems += _logical_problems(where, pool, zones)
            continue
        node_type, infra_env = pool.get(NODE_TYPE_INPUT), pool.get(INFRA_ENV)
        if not node_type:
            continue
        if not isinstance(infra_env, str) or not infra_env:
            problems.append(
                f"{where}.{ZONES_INPUT}: node type {node_type} needs its zones, one InfraEnv each "
                f"({ZONES_INPUT}: [{{infra_env, replicas}}])"
            )
        elif node_type_of(infra_env) != node_type:
            problems.append(
                f"{where}.{INFRA_ENV}: {infra_env} is node type {node_type_of(infra_env)}, "
                f"not {node_type}"
            )
    return problems


def lock_conflicts(
    variables: Mapping[str, object], locked: Mapping[int, object], *, flavor: str
) -> list[str]:
    """Each zone that sends other replicas than the flavor locks its nodepool to.

    ``locked`` maps a nodepool's position to its locked ``replicas``. A lock on
    a logical nodepool's replicas fixes every zone's.
    """
    problems: list[str] = []
    for index, pool in _pools(variables):
        want = _whole(locked.get(index))
        zones = _zones(pool)
        if want is None or zones is None:
            continue
        for i, zone in enumerate(zones):
            sent = (
                cast("Mapping[str, object]", zone).get(REPLICAS)
                if isinstance(zone, Mapping)
                else None
            )
            if sent is not None and _whole(sent) != want:
                problems.append(
                    f"nodepools[{index}].{ZONES_INPUT}[{i}].{REPLICAS}: locked by flavor {flavor} "
                    f"to {want} in every zone; the request sends {sent!r}"
                )
    return problems


def locked_replicas(paths: Sequence[tuple[InputPath, object]]) -> dict[int, object]:
    """``nodepools[<i>].replicas`` locks by position, from ``(path, value)`` pairs."""
    found: dict[int, object] = {}
    for path, value in paths:
        match path.segments:
            case ("nodepools", int(index), "replicas"):
                found[index] = value
            case _:
                pass
    return found


def spread(inputs: Mapping[str, object]) -> dict[str, object]:
    """The render's inputs: each logical nodepool as one physical nodepool per zone, in order.

    Each gets the nodepool's config as it is, its zone's ``infra_env`` and its
    zone's replicas (the nodepool's where the zone gives none);
    ``node_type`` and ``zones`` are dropped, and a physical nodepool loses
    only ``node_type``.
    """
    raw = inputs.get("nodepools")
    if not isinstance(raw, (list, tuple)):
        return dict(inputs)
    out: list[object] = []
    for item in cast("Sequence[object]", raw):
        if not isinstance(item, Mapping):
            out.append(item)
            continue
        pool = cast("Mapping[str, object]", item)
        config = {k: v for k, v in pool.items() if k not in _FORM_ONLY}
        zones = _zones(pool)
        if zones is None:
            out.append(config)
            continue
        for zone, replicas in zip(zones, zone_replicas(pool) or [], strict=True):
            infra_env = (
                cast("Mapping[str, object]", zone).get(INFRA_ENV)
                if isinstance(zone, Mapping)
                else None
            )
            physical = {**config, INFRA_ENV: infra_env}
            if replicas is not None:
                physical[REPLICAS] = replicas
            out.append(physical)
    return {**inputs, "nodepools": out}


def flavor_problems(values: Mapping[str, object]) -> list[str]:
    """Why a flavor's nodepools' node types may not be saved; empty when they may.

    A flavor presets a node type, a DNS label without a zone of the
    convention's (``r760-mtl``, not ``r760-mtl-az1``), and never ``zones``,
    which are the MCE's; with a node type it presets no ``infra_env``.
    """
    problems: list[str] = []
    for index, pool in _pools(values):
        where = f"nodepools[{index}]"
        if ZONES_INPUT in pool:
            problems.append(
                f"{where}.{ZONES_INPUT}: a flavor presets the node type; its zones are the MCE's, "
                "given at create"
            )
        node_type = pool.get(NODE_TYPE_INPUT)
        if node_type is None or node_type == "":
            continue
        if not isinstance(node_type, str):
            problems.append(f"{where}.{NODE_TYPE_INPUT}: must be text")
            continue
        found = dns_label_problems(node_type, what="node type")
        problems += [f"{where}.{NODE_TYPE_INPUT}: {p}" for p in found]
        if not found and node_type_of(node_type) != node_type:
            problems.append(
                f"{where}.{NODE_TYPE_INPUT}: {node_type} is an InfraEnv, node type "
                f"{node_type_of(node_type)} in one zone; preset the node type"
            )
        if pool.get(INFRA_ENV):
            problems.append(
                f"{where}.{INFRA_ENV}: a nodepool presets a node type or an InfraEnv, not both"
            )
    return problems
