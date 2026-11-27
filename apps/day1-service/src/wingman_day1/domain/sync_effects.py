"""What a sync does to the nodes: the configs it removes and the nodepools that roll (ADR-0037).

A sync sets a nodepool's machine configs (ADR-0029) and its tuning profiles
(ADR-0061). OpenShift applies a MachineConfig change to every node of the
nodepool (drained and rebooted in place, or replaced, by the nodepool's
``upgradeType``), and a tuning change can reboot them too (a
PerformanceProfile, kernel arguments). Removed configs must be confirmed
by the person who asks for the sync; removed tuning profiles need no
confirmation, but every nodepool whose tuning changes is named.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast

from wingman_day1.domain.cluster_edits import Edit, SetConfigs, SetValue
from wingman_day1.domain.input_paths import InputPath
from wingman_day1.domain.node_types import ZONE_LABEL
from wingman_day1.domain.value_drift import NodepoolRef, ValueDrift, file_nodepools, nodepool_name
from wingman_day1.domain.zone_labels import FILE_KEY, gap_labels, gaps


def sync_edits(drift: Sequence[ValueDrift], values: Mapping[str, object]) -> list[Edit]:
    """The text edits that set every drifted value that needs no decision, and the zone labels.

    Each NodePool of a convention InfraEnv whose ``nodeLabels`` lack its zone gets
    it (ADR-0072); one whose node labels a lock sets already gets it from the
    lock's value, which keeps each entry's own zone.
    """
    edits: list[Edit] = []
    for item in drift:
        if item.needs_decision is not None:
            continue
        if item.is_configs and item.nodepool is not None:
            entries = cast("Sequence[Mapping[str, str]]", item.flavor_value)
            edits.append(SetConfigs(item.nodepool.index, tuple(e["name"] for e in entries)))
        else:
            edits.append(SetValue(item.file_key, item.flavor_value))
    labelled = {d.file_key.segments[1] for d in drift if str(d.file_key).endswith(f".{FILE_KEY}")}
    edits.extend(
        SetValue(InputPath(("nodepool", gap.index, FILE_KEY)), gap_labels(values, gap))
        for gap in gaps(values)
        if gap.index not in labelled
    )
    return edits


@dataclass(frozen=True, slots=True)
class ZoneLabelAdded:
    """A NodePool whose ``nodeLabels`` lack its zone: a sync adds it, not the flavor."""

    nodepool: NodepoolRef
    zone: str


def zone_labels_added(
    values: Mapping[str, object], cluster_name: str
) -> tuple[ZoneLabelAdded, ...]:
    """The zone labels a sync adds (ADR-0072): never drift, the naming convention's."""
    pools = file_nodepools(values)
    return tuple(
        ZoneLabelAdded(
            NodepoolRef(
                gap.index, nodepool_name(pools[gap.index], gap.index, cluster_name=cluster_name)
            ),
            gap.zone,
        )
        for gap in gaps(values)
    )


def zone_label_lines(values: Mapping[str, object], cluster_name: str) -> list[str]:
    """What a sync says of each zone label it adds: the naming convention's, not the flavor's."""
    return [
        f"adds {ZONE_LABEL}: {added.zone} to nodepool {added.nodepool.name}: every NodePool "
        "labels its Nodes with its zone (the naming convention), which Wingman writes"
        for added in zone_labels_added(values, cluster_name)
    ]


@dataclass(frozen=True, slots=True)
class Removal:
    """A config a sync removes from a nodepool."""

    nodepool: NodepoolRef
    name: str


@dataclass(frozen=True, slots=True)
class Rebooting:
    """A nodepool whose configs or tuning a sync changes: merging rolls or reboots its nodes.

    How is the nodepool's own ``upgradeType`` (the chart's default is
    ``InPlace``: each node is drained and rebooted, ``inPlace.maxUnavailable``
    at a time, one when unset); ``Replace`` provisions new nodes instead.
    """

    nodepool: NodepoolRef
    replicas: int | None
    upgrade_type: str | None = None
    """The file's ``upgradeType``; ``None`` when unset (the chart's ``InPlace``)."""
    max_unavailable: int | str | None = None
    """The file's ``inPlace.maxUnavailable``; ``None`` when unset (one node at a time)."""
    configs: bool = True
    """Its machine configs change."""
    tuning: bool = False
    """Its tuning profiles change (ADR-0061): its nodes may reboot."""

    @property
    def replaces_nodes(self) -> bool:
        """``upgradeType: Replace``: new nodes are provisioned and the old ones removed."""
        return self.upgrade_type == "Replace"


def removals(decided: Sequence[ValueDrift]) -> tuple[Removal, ...]:
    """The configs the decided drift removes, nodepool by nodepool."""
    return tuple(
        Removal(d.nodepool, removed)
        for d in decided
        if d.is_configs and d.nodepool is not None
        for removed in d.removed
    )


def rebooting(values: Mapping[str, object], decided: Sequence[ValueDrift]) -> tuple[Rebooting, ...]:
    """Each nodepool whose configs or tuning the decided drift changes, once, in file order."""
    changing: dict[int, tuple[NodepoolRef, bool, bool]] = {}
    for d in decided:
        if not d.reboots or d.nodepool is None or not (d.added or d.removed):
            continue
        _, configs, tuning = changing.get(d.nodepool.index, (d.nodepool, False, False))
        changing[d.nodepool.index] = (d.nodepool, configs or d.is_configs, tuning or d.is_tuning)
    return tuple(
        _rebooting(values, ref, configs=configs, tuning=tuning)
        for _, (ref, configs, tuning) in sorted(changing.items())
    )


def _rebooting(
    values: Mapping[str, object], nodepool: NodepoolRef, *, configs: bool, tuning: bool
) -> Rebooting:
    pool = file_nodepools(values)[nodepool.index]
    found = cast("Mapping[str, object]", pool) if isinstance(pool, Mapping) else {}
    replicas = found.get("replicas")
    upgrade = found.get("upgradeType")
    in_place = found.get("inPlace")
    limit = (
        cast("Mapping[str, object]", in_place).get("maxUnavailable")
        if isinstance(in_place, Mapping)
        else None
    )
    return Rebooting(
        nodepool,
        replicas if isinstance(replicas, int) and not isinstance(replicas, bool) else None,
        upgrade if isinstance(upgrade, str) else None,
        limit if isinstance(limit, int | str) and not isinstance(limit, bool) else None,
        configs=configs,
        tuning=tuning,
    )


def confirmation_problems(
    planned: Sequence[Removal], confirmed: Sequence[tuple[int, str]]
) -> list[str]:
    """Planned removals the request does not confirm, and confirmed ones not planned."""
    want = Counter((r.nodepool.index, r.name) for r in planned)
    got = Counter(confirmed)
    problems = [
        f"nodepool[{index}].configs: the sync removes {name}; confirm it in confirm_removals"
        for (index, name), count in sorted(want.items())
        if got[(index, name)] < count
    ]
    problems += [
        f"nodepool[{index}].configs: confirm_removals names {name}, which the sync does not remove"
        for (index, name), count in sorted(got.items())
        if want[(index, name)] < count
    ]
    return problems


def nodes(replicas: int | None) -> str:
    """`` (3 nodes)``, or nothing when the count is unknown."""
    if replicas is None:
        return ""
    return f" ({replicas} node{'s' if replicas != 1 else ''})"


def how(rolling: Rebooting) -> str:
    """How the nodepool's nodes take the change, from its ``upgradeType``."""
    if rolling.replaces_nodes:
        return "replaced (`upgradeType: Replace`): new nodes are provisioned, then the old removed"
    at_a_time = (
        "one node at a time"
        if rolling.max_unavailable is None
        else f"`inPlace.maxUnavailable: {rolling.max_unavailable}` at a time"
    )
    return f"drained and rebooted in place, {at_a_time}"
