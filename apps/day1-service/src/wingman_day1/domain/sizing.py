"""A flavor's nodepool ratio: its nodepools grow together (ADR-0040).

``spec.day1.nodepool_ratio`` is one whole number per nodepool of the
flavor (``[1, 2]``: the second twice the first). A cluster created from the
flavor gives its first nodepools ``ratio[i] * size`` replicas, for one size
the person picks; a logical nodepool (ADR-0072) has them in each of its
zones, which grow together. The ratio is not a template input: the cluster file gets
plain ``replicas``. Drift, import and sync do not read it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final, cast

from wingman_day1.domain.zone_inputs import zone_replicas

MAX_RATIO: Final = 100


def show_ratio(ratio: Sequence[int]) -> str:
    """``1:2:1``."""
    return ":".join(str(r) for r in ratio)


def ratio_problems(
    ratio: Sequence[int], *, nodepools: int, locked_paths: Sequence[str]
) -> list[str]:
    """Why a flavor's ``nodepool_ratio`` cannot be saved; empty when it can (or there is none).

    ``nodepools`` is how many nodepools the flavor has. A sized nodepool's
    replicas cannot also be locked: the size sets them.
    """
    if not ratio:
        return []
    if not all(1 <= r <= MAX_RATIO for r in ratio):
        return [f"nodepool_ratio: each entry must be a whole number from 1 to {MAX_RATIO}"]
    problems: list[str] = []
    if len(ratio) != nodepools:
        problems.append(
            f"nodepool_ratio: {len(ratio)} entries for {nodepools} nodepools; give one per nodepool"
        )
    locked = set(locked_paths)
    problems.extend(
        f"nodepool_ratio: nodepools[{i}].replicas is locked; a ratio sizes it, "
        "so it cannot be locked too"
        for i in range(len(ratio))
        if f"nodepools[{i}].replicas" in locked
    )
    return problems


def sizing_problems(
    inputs: Mapping[str, object], ratio: Sequence[int], *, flavor: str
) -> list[str]:
    """Why a create's nodepools do not follow the flavor's ratio; empty when they do.

    The first ``len(ratio)`` nodepools must have ``ratio[i] * size``
    replicas for one whole size of at least 1; nodepools after them are
    sized freely. A logical nodepool (ADR-0072) has them in every zone.
    """
    if not ratio:
        return []
    raw = inputs.get("nodepools")
    pools = list(raw) if isinstance(raw, list) else []
    shown = show_ratio(ratio)
    if len(pools) < len(ratio):
        return [
            f"nodepools: the flavor {flavor} sizes {len(ratio)} nodepools {shown}; "
            f"the cluster has {len(pools)}"
        ]
    each = [_replicas(pool) for pool in pools[: len(ratio)]]
    first = each[0][0] if each[0] else None
    size = first // ratio[0] if first is not None else 0

    def holds(i: int, counts: list[int | None]) -> bool:
        return size >= 1 and bool(counts) and all(r == ratio[i] * size for r in counts)

    if all(holds(i, counts) for i, counts in enumerate(each)):
        return []
    wrong = next((i for i, counts in enumerate(each) if not holds(i, counts)), 0)
    example = ", ".join(str(r * 2) for r in ratio)
    got = ", ".join("+".join("none" if r is None else str(r) for r in c) or "none" for c in each)
    return [
        f"nodepools[{wrong}].replicas: the flavor {flavor} sizes its nodepools {shown}, so "
        f"the replicas must be {_times(ratio)} times one size (e.g. {example}); got {got}"
    ]


def _replicas(pool: object) -> list[int | None]:
    """A nodepool's replicas: its own, or each zone's for a logical one (ADR-0072)."""
    if not isinstance(pool, Mapping):
        return [None]
    found = zone_replicas(cast("Mapping[str, object]", pool))
    if found is not None:
        return found
    value = pool.get("replicas")
    if isinstance(value, int) and not isinstance(value, bool):
        return [value]
    if isinstance(value, str) and value.strip().isdigit():
        return [int(value.strip())]
    return [None]


def _times(ratio: Sequence[int]) -> str:
    """``1, 2 and 1``."""
    words = [str(r) for r in ratio]
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"
