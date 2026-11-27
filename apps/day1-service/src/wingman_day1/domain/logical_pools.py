"""A cluster file's NodePools as logical nodepools: one node type and suffix, a NodePool per zone.

ADR-0072: a logical nodepool a customer creates is one physical NodePool per
zone of its node type, every one with the same config. The cluster file has
no key for the group (it is the hostedclusters-setup chart's values file):
the group is read from the NodePools' names alone. Entries whose InfraEnvs
are one node type (``node_types.node_type_of``) and whose names carry the
same suffix (``<InfraEnv>[-<suffix>]``, ADR-0071; a derived name has none)
are one logical nodepool, in the order the first of each appears. An entry
named off the rule, or that names no InfraEnv, is a logical nodepool alone.

A flavor's positions (``nodepools[0]``) are logical: :func:`flavor_positions`
maps each to the file entries it means. A cluster created before logical
nodepools from a flavor that preset one InfraEnv per position (``r760-mtl-az1`` at 0,
``-az2`` at 1) has fewer groups than the flavor has nodepools: its positions
stay one entry each, as before.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast

from wingman_day1.domain.node_types import node_type_of
from wingman_day1.domain.nodepool_names import FILE_KEY, follows_rule, infra_env_of


@dataclass(frozen=True, slots=True)
class LogicalPool:
    """Some of a file's ``nodepool[]`` entries, by position: one node type and suffix."""

    node_type: str | None
    """``None`` for an entry that is a group alone (named off the rule, or no InfraEnv)."""
    suffix: str
    indexes: tuple[int, ...]


def logical_key(entry: Mapping[str, object]) -> tuple[str, str] | None:
    """``(node type, suffix)`` of a file entry; ``None`` when it groups with no other."""
    infra_env = infra_env_of(entry)
    if infra_env is None:
        return None
    name = entry.get(FILE_KEY)
    if not name or name == infra_env:
        return node_type_of(infra_env), ""
    if not follows_rule(str(name), infra_env):
        return None
    return node_type_of(infra_env), str(name)[len(infra_env) + 1 :]


def logical_pools(entries: Sequence[object]) -> tuple[LogicalPool, ...]:
    """The file's ``nodepool[]`` entries grouped, in the order each group first appears."""
    groups: list[tuple[tuple[str, str] | None, list[int]]] = []
    for index, entry in enumerate(entries):
        key = (
            logical_key(cast("Mapping[str, object]", entry)) if isinstance(entry, Mapping) else None
        )
        found = next((g for g in groups if key is not None and g[0] == key), None)
        if found is None:
            groups.append((key, [index]))
        else:
            found[1].append(index)
    return tuple(
        LogicalPool(key[0] if key else None, key[1] if key else "", tuple(indexes))
        for key, indexes in groups
    )


def flavor_positions(
    entries: Sequence[object], nodepools: int | None
) -> dict[int, tuple[int, ...]]:
    """Which file entries each of a flavor's ``nodepools`` positions means.

    The ``i``-th logical nodepool's entries while the file has at least as
    many groups as the flavor has nodepools; else (a cluster made before
    logical nodepools, or ``nodepools`` unknown) the ``i``-th entry alone.
    """
    groups = logical_pools(entries)
    if nodepools is not None and len(groups) >= nodepools:
        return {i: group.indexes for i, group in enumerate(groups)}
    return {i: (i,) for i in range(len(entries))}
