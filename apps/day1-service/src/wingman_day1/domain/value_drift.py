"""Value drift: each locked value a cluster file does not hold (ADR-0036).

A flavor's locks are template inputs (``nodepools[0].configs``); the file
holds what the shared template wrote for them (``nodepool[0].configs``),
through the ``LOCKABLE`` table. This module compares the two, in the file's
own form:

- an owner compares as text (``"0042"``), a whole number in the file being
  the same as its digits;
- ``platform`` is ``kubevirt`` or the Agent default; a file without the key
  is on the Agent platform, as the template writes it;
- replicas compare as numbers, node labels as a mapping (no key is ``{}``),
  without the zone key, which is each NodePool's own and never a flavor's
  (ADR-0072), a scale-down policy as the entry's annotation's text (ADR-0062);
- configs compare by name, each as often, in any order (ADR-0029); a lock's
  ``{name: nm-conf, hardware: <hw>}`` is the file's
  ``nm-conf-<clusterName>-<hw>``. Where the hardware is the nodepool's own
  (the configs rule, or a lock with no hardware), it is read from the one
  network config the nodepool lists; none or several needs a person;
- tuning profiles (the tuning rule, ADR-0061) compare as a set of names; a
  file's ``tuningConfig`` is a string for one name or a list;
- image mirrors (ADR-0063) compare as the chart uses them: the
  ``imageContentSources`` entries merged by source and sorted (no key is no
  entries), and ``disableIdmsMerge`` by Go's truth (no key keeps the MCE's).

A flavor's position (``nodepools[1]``) is the file's logical nodepool there
(``logical_pools``, ADR-0072): its lock holds on each of that nodepool's
NodePools, one per zone, so a cluster spread over zones has no false drift
and a sync sets every zone alike. A cluster made before logical nodepools
keeps one entry per position.

Presets are never compared: overriding them is allowed. Each difference is
a :class:`ValueDrift` with the flavor's value and the file's, and for
configs the names a sync would add and remove.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, cast

from wingman_day1.domain.image_mirrors import MIRROR_FILE_KEYS, mirrors_held, show_mirrors
from wingman_day1.domain.locks import (
    MISSING,
    NETWORK_ENTRY,
    TUNING_RULE,
    InputPath,
    Lock,
    entry_key,
    is_configs_lock,
    lockable,
    lookup,
    same_value,
)
from wingman_day1.domain.logical_pools import flavor_positions
from wingman_day1.domain.machine_configs import MachineConfigCatalog, network_config_name
from wingman_day1.domain.nodepool_names import rendered_name
from wingman_day1.domain.tuning_profiles import TUNING_FILE_KEY, file_value, tuning_names
from wingman_day1.domain.tuning_rule import compare
from wingman_day1.domain.zone_labels import with_own_zone, without_zone

_KUBEVIRT: Final = "kubevirt"
_AGENT: Final = "agent"
_SHOWN: Final = 80


@dataclass(frozen=True, slots=True)
class NodepoolRef:
    """A nodepool of the file: its position and the NodePool name the chart renders."""

    index: int
    name: str


@dataclass(frozen=True, slots=True)
class ValueDrift:
    """One locked value the cluster file does not hold."""

    lock: InputPath
    """The flavor's locked path: ``owner_anaf``, ``nodepools[0].configs`` or the rule."""
    file_key: InputPath
    """Where the value is in the file: ``owner.anaf``, ``nodepool[1].configs``."""
    flavor_value: object
    """The locked value in the file's form; an undecided network config is ``{name: nm-conf}``."""
    cluster_value: object
    """What the file holds there; ``MISSING`` when it has no such key."""
    nodepool: NodepoolRef | None = None
    added: tuple[str, ...] = ()
    """Configs and tuning profiles: the names a sync adds."""
    removed: tuple[str, ...] = ()
    """Configs and tuning profiles: the names a sync removes (configs exactly, ADR-0029)."""
    needs_decision: str | None = None
    """Why a sync cannot set this value until a person decides; ``None`` when it can."""
    needs_hardware: bool = False
    """The decision is the nodepool's network hardware type: a sync request can choose it."""

    @property
    def is_configs(self) -> bool:
        """Whether this is a nodepool's configs: changing them rolls the nodepool's nodes."""
        return self.file_key.segments[-1] == "configs"

    @property
    def is_tuning(self) -> bool:
        """Whether this is a nodepool's tuning profiles (ADR-0061)."""
        return self.file_key.segments[-1] == TUNING_FILE_KEY

    @property
    def reboots(self) -> bool:
        """Configs or tuning: syncing them can roll or reboot the nodepool's nodes."""
        return self.is_configs or self.is_tuning


def file_nodepools(values: Mapping[str, object]) -> list[object]:
    """The file's ``nodepool`` list; ``[]`` when it has none or it is not a list."""
    pools = values.get("nodepool")
    return list(cast("Sequence[object]", pools)) if isinstance(pools, list) else []


def nodepool_name(pool: object, index: int, *, cluster_name: str) -> str:
    """The NodePool the chart renders (``nodepool_names.rendered_name``), else its position."""
    if isinstance(pool, Mapping):
        found = rendered_name(cast("Mapping[str, object]", pool), cluster_name=cluster_name)
        if found is not None:
            return found
    return f"nodepool[{index}]"


def config_names(configs: object) -> list[str]:
    """The names a file's ``configs`` value lists, in order (``[]`` when it is not a list)."""
    if not isinstance(configs, list):
        return []
    return [entry_key(item) for item in cast("Sequence[object]", configs)]


def show_value(value: object) -> str:
    """A drifted value as an MR description shows it: configs by name, cut at 80 characters.

    Image mirrors read ``source → mirror, ...`` (ADR-0063).
    """
    if value is MISSING:
        return "(absent)"
    if (
        isinstance(value, list)
        and value
        and all(isinstance(e, Mapping) and "source" in e for e in cast("Sequence[object]", value))
    ):
        return show_mirrors(value)
    if isinstance(value, list):
        names = [
            str(cast("Mapping[str, object]", e).get("name")) if isinstance(e, Mapping) else str(e)
            for e in cast("Sequence[object]", value)
        ]
        text = ", ".join(names) or "none"
    else:
        text = repr(value) if isinstance(value, str) else str(value)
    return text if len(text) <= _SHOWN else f"{text[: _SHOWN - 3]}..."


def compare_names(expected: Sequence[str], have: Sequence[str]) -> tuple[list[str], list[str]]:
    """What to add (in ``expected`` order) and remove (in file order) so ``have`` is ``expected``.

    Names compare as a multiset: order is ignored, and a name listed twice
    where ``expected`` has it once is removed once.
    """
    remaining = Counter(expected)
    removed: list[str] = []
    for name in have:
        if remaining[name] > 0:
            remaining[name] -= 1
        else:
            removed.append(name)
    added: list[str] = []
    for name in expected:
        if remaining[name] > 0:
            added.append(name)
            remaining[name] -= 1
    return added, removed


@dataclass(frozen=True, slots=True)
class _Context:
    values: Mapping[str, object]
    cluster_name: str
    catalog: MachineConfigCatalog
    hardware: Mapping[int, str]
    positions: Mapping[int, tuple[int, ...]]
    """The file entries each flavor position means (``logical_pools.flavor_positions``)."""


def network_configs(names: Sequence[str], catalog: MachineConfigCatalog) -> list[str]:
    """The names a hardware template captures: the nodepool's network configs (ADR-0027)."""
    return [name for name in names if catalog.template_for(name) is not None]


def _network(index: int, have: Sequence[str], context: _Context) -> tuple[str | None, str | None]:
    """The nodepool's own network config name, or why a person must choose its hardware."""
    chosen = context.hardware.get(index)
    if chosen is not None:
        return network_config_name(context.cluster_name, chosen), None
    found = network_configs(have, context.catalog)
    template = context.catalog.template_for(found[0]) if len(found) == 1 else None
    if template is not None:
        return network_config_name(context.cluster_name, template.name), None
    pattern = network_config_name(context.cluster_name, "<hardware>")
    if not found:
        return None, (
            f"nodepool[{index}] has no network config ({pattern}); choose its hardware type"
        )
    return None, (
        f"nodepool[{index}] has {len(found)} network configs ({', '.join(found)}); choose the "
        "hardware type it keeps"
    )


def _configs_drift(
    lock: Lock, index: int, pool: Mapping[str, object], context: _Context
) -> ValueDrift | None:
    entries = cast("Sequence[object]", lock.value) if isinstance(lock.value, list) else []
    have_value = pool.get("configs", MISSING)
    have = config_names(have_value)
    expected: list[str] = []
    shown: list[dict[str, str]] = []
    decision: str | None = None
    network_names = set(network_configs(have, context.catalog))
    for entry in entries:
        name = entry_key(entry)
        hardware = (
            cast("Mapping[str, object]", entry).get("hardware")
            if isinstance(entry, Mapping)
            else None
        )
        if name != NETWORK_ENTRY:
            expected.append(name)
            shown.append({"name": name})
        elif isinstance(hardware, str) and hardware and not lock.is_rule:
            expanded = network_config_name(context.cluster_name, hardware)
            expected.append(expanded)
            shown.append({"name": expanded})
        else:
            expanded, decision = _network(index, have, context)
            if expanded is None:
                shown.append({"name": NETWORK_ENTRY})
            else:
                expected.append(expanded)
                shown.append({"name": expanded})
    if decision is not None:
        # The network part waits for a person; the rest is compared as usual.
        added, removed = compare_names(expected, [n for n in have if n not in network_names])
    else:
        added, removed = compare_names(expected, have)
    if not added and not removed and decision is None:
        return None
    file_key = InputPath(("nodepool", index, "configs"))
    return ValueDrift(
        lock=lock.path,
        file_key=file_key,
        flavor_value=shown,
        cluster_value=have_value,
        nodepool=NodepoolRef(index, nodepool_name(pool, index, cluster_name=context.cluster_name)),
        added=tuple(added),
        removed=tuple(removed),
        needs_decision=decision,
        needs_hardware=decision is not None,
    )


def _no_nodepool(lock: Lock, file_key: InputPath, index: int, why: str) -> ValueDrift:
    return ValueDrift(
        lock=lock.path,
        file_key=file_key,
        flavor_value=lock.value,
        cluster_value=MISSING,
        needs_decision=why.format(index=index),
    )


def _nodepool_drifts(lock: Lock, file_key: InputPath, context: _Context) -> list[ValueDrift]:
    """A position's lock on every file entry of its logical nodepool (ADR-0072)."""
    position = cast("int", lock.path.segments[1])
    indexes = context.positions.get(position, ())
    if not indexes:
        return [
            _no_nodepool(
                lock,
                file_key,
                position,
                "the cluster has no nodepool[{index}]; sync does not add nodepools",
            )
        ]
    found = (
        _nodepool_drift(lock, InputPath(("nodepool", i, *file_key.segments[2:])), i, context)
        for i in indexes
    )
    return [drift for drift in found if drift is not None]


def _nodepool_drift(
    lock: Lock, file_key: InputPath, index: int, context: _Context
) -> ValueDrift | None:
    pool = file_nodepools(context.values)[index]
    if not isinstance(pool, Mapping):
        return _no_nodepool(lock, file_key, index, "nodepool[{index}] is not a mapping")
    found = cast("Mapping[str, object]", pool)
    if is_configs_lock(lock.path):
        return _configs_drift(lock, index, found, context)
    key = str(file_key.segments[-1])
    have = lookup(found, InputPath(file_key.segments[2:]))  # a key, or an annotation's
    ref = NodepoolRef(index, nodepool_name(found, index, cluster_name=context.cluster_name))
    want = lock.value
    if key == "replicas" and isinstance(want, str) and want.isdigit():
        want = int(want)
    if key == "nodeLabels":
        return _labels_drift(lock, file_key, have, ref)
    if have is not MISSING and same_value(want, have):
        return None
    return ValueDrift(lock.path, file_key, want, have, nodepool=ref)


def _labels_drift(
    lock: Lock, file_key: InputPath, have: object, ref: NodepoolRef
) -> ValueDrift | None:
    """Locked node labels against the entry's, its zone key its own (ADR-0072).

    The template writes no ``nodeLabels`` for an empty mapping; a sync writes the
    flavor's labels with the entry's zone label when it has one, so it never adds,
    changes or drops one.
    """
    mine = without_zone(have)
    if lock.value == {} and (have is MISSING or mine == {}):
        return None
    if have is not MISSING and same_value(lock.value, mine):
        return None
    return ValueDrift(lock.path, file_key, with_own_zone(lock.value, have), have, nodepool=ref)


def _top_level_drift(lock: Lock, file_key: InputPath, context: _Context) -> ValueDrift | None:
    have = lookup(context.values, file_key)
    if str(file_key) in MIRROR_FILE_KEYS:
        held = mirrors_held(str(file_key), lock.value, have)
        return None if held else ValueDrift(lock.path, file_key, lock.value, have)
    if file_key.segments == ("platform",):
        want = _KUBEVIRT if lock.value == _KUBEVIRT else _AGENT
        effective = _KUBEVIRT if have == _KUBEVIRT else _AGENT
        return None if want == effective else ValueDrift(lock.path, file_key, want, have)
    want = str(lock.value) if type(lock.value) is int else lock.value
    if have is not MISSING and same_value(want, have):
        return None
    return ValueDrift(lock.path, file_key, want, have)


def _tuning_drift(lock: Lock, values: Mapping[str, object], cluster_name: str) -> list[ValueDrift]:
    """Each nodepool whose tuning profiles are not the rule's, compared as a set."""
    want = [str(n) for n in cast("Sequence[object]", lock.value)]
    found: list[ValueDrift] = []
    for index, pool in enumerate(file_nodepools(values)):
        if not isinstance(pool, Mapping):
            continue
        have_value = cast("Mapping[str, object]", pool).get(TUNING_FILE_KEY, MISSING)
        have = tuning_names(None if have_value is MISSING else have_value) or []
        added, removed = compare(want, have)
        if not added and not removed and tuning_names(have_value) is not None:
            continue
        ref = NodepoolRef(index, nodepool_name(pool, index, cluster_name=cluster_name))
        file_key = InputPath(("nodepool", index, TUNING_FILE_KEY))
        found.append(
            ValueDrift(
                lock.path,
                file_key,
                file_value(want),
                have_value,
                nodepool=ref,
                added=tuple(added),
                removed=tuple(removed),
            )
        )
    return found


def value_drift(
    locks: Sequence[Lock],
    values: Mapping[str, object],
    *,
    cluster_name: str,
    catalog: MachineConfigCatalog,
    hardware: Mapping[int, str] | None = None,
    flavor_nodepools: int | None = None,
) -> tuple[ValueDrift, ...]:
    """Every locked value ``values`` (a parsed cluster file) does not hold, in lock order.

    ``cluster_name`` is the chart's (an explicit ``clusterName`` key wins);
    ``hardware`` is a person's choice of network hardware per nodepool
    index, for nodepools whose own cannot be read. ``flavor_nodepools`` is how
    many nodepools the flavor has: a position's lock then holds every NodePool
    of the file's logical nodepool there (ADR-0072); unknown, one entry each.
    """
    positions = flavor_positions(file_nodepools(values), flavor_nodepools)
    context = _Context(values, cluster_name, catalog, hardware or {}, positions)
    found: list[ValueDrift] = []
    for lock in locks:
        if lock.path == TUNING_RULE:
            found += _tuning_drift(lock, values, cluster_name)
            continue
        if lock.is_rule:
            for index, pool in enumerate(file_nodepools(values)):
                if not isinstance(pool, Mapping):
                    found.append(
                        _no_nodepool(
                            lock,
                            InputPath(("nodepool", index, "configs")),
                            index,
                            "nodepool[{index}] is not a mapping",
                        )
                    )
                    continue
                drift = _configs_drift(lock, index, cast("Mapping[str, object]", pool), context)
                if drift is not None:
                    found.append(drift)
            continue
        shape = lockable(lock.path)
        if shape is None:
            continue
        file_key = shape.file_path(lock.path)
        if file_key.segments[0] == "nodepool":
            found += _nodepool_drifts(lock, file_key, context)
        elif (drift := _top_level_drift(lock, file_key, context)) is not None:
            found.append(drift)
    return tuple(found)
