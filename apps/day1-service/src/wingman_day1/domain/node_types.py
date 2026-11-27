"""Node types: the kind of server a customer picks, an InfraEnv without its zone (ADR-0072).

The platform's naming convention (2026-11-22) names an InfraEnv
``<flavor>-<size>-<zone>`` (``r760-mtl-az1``): ``<size>`` is ``mtl`` for bare
metal or ``kv<cpu>`` for a KubeVirt VM of that many CPUs, and the InfraEnv's
``topology.kubernetes.io/zone`` agentLabel names its zone. A customer speaks
of the kind of server and where it sits, not of InfraEnvs: the **node type**
is the name without its zone (``r760-mtl``), and the node type's InfraEnvs on
an MCE are its **zones** (``r760-mtl-az1``, ``r760-mtl-az2``, ...).

- **The node type is the name's** (:func:`split`), so a cluster file's
  NodePools group the same way whether the MCE is read or not: a name that
  follows the convention is ``<flavor>-<size>``; any other
  (``dell-r660-site1-128c-1024gb-5tb``, from before the convention) is its
  own node type, with one zone.
- **The zone is the hub's label** where the hub is read, else the name's
  (:func:`zone_of`); a name off the convention without the label has an
  unnamed zone (``None``).

This is the only parser of the convention in day1 (the web's is
``apps/web/lib/node-types.ts``): a KV cluster's bare-metal pool
(``kv_create``) is a node type of size ``mtl``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Final

from wingman_day1.domain.infra_env_pools import InfraEnvObservation
from wingman_day1.domain.kv_clusters import ZONE_LABEL

BARE_METAL: Final = "mtl"
"""The size of a bare-metal InfraEnv; a KubeVirt one's is ``kv<cpu>``."""
_CONVENTION = re.compile(r"^(?P<flavor>[a-z0-9]+)-(?P<size>mtl|kv[0-9]+)-(?P<zone>[a-z0-9]+)$")


@dataclass(frozen=True, slots=True)
class InfraEnvName:
    """An InfraEnv's name under the convention: ``<flavor>-<size>-<zone>``."""

    flavor: str
    size: str
    zone: str

    @property
    def node_type(self) -> str:
        """``<flavor>-<size>``: the name without its zone."""
        return f"{self.flavor}-{self.size}"


def parse(infra_env: str) -> InfraEnvName | None:
    """``r760-mtl-az1`` as its flavor, size and zone; ``None`` for a name off the convention."""
    found = _CONVENTION.match(infra_env)
    return InfraEnvName(found["flavor"], found["size"], found["zone"]) if found else None


@dataclass(frozen=True, slots=True)
class Placed:
    """Where an InfraEnv sits for a customer: its node type and its zone."""

    node_type: str
    zone: str | None
    """``None``: the name names no zone and the hub gave none."""


def split(infra_env: str) -> Placed:
    """The node type and zone of an InfraEnv, from its name alone."""
    found = parse(infra_env)
    return Placed(found.node_type, found.zone) if found else Placed(infra_env, None)


def node_type_of(infra_env: str) -> str:
    """The node type of an InfraEnv: ``r760-mtl`` for ``r760-mtl-az1``, else the whole name."""
    return split(infra_env).node_type


def zone_of(infra_env: str, agent_labels: Mapping[str, str] | None = None) -> str | None:
    """The zone of an InfraEnv: its zone label when the hub gave one, else its name's."""
    label = (agent_labels or {}).get(ZONE_LABEL)
    return label if label else split(infra_env).zone


@dataclass(frozen=True, slots=True)
class Zone:
    """One zone of a node type on an MCE: the InfraEnv that serves it."""

    zone: str | None
    infra_env: str


@dataclass(frozen=True, slots=True)
class NodeType:
    """A node type on an MCE and its zones, in zone order."""

    name: str
    zones: tuple[Zone, ...]


def _natural(text: str | None) -> tuple[object, ...]:
    """``az2`` before ``az10``; an unnamed zone first."""
    if text is None:
        return ()
    return tuple(int(part) if part.isdigit() else part for part in re.split(r"(\d+)", text))


def node_types(infra_envs: Iterable[InfraEnvObservation]) -> tuple[NodeType, ...]:
    """The node types an MCE's InfraEnvs make, by name, each with its zones."""
    grouped: dict[str, list[Zone]] = {}
    for infra_env in infra_envs:
        zone = zone_of(infra_env.name, infra_env.agent_labels)
        grouped.setdefault(node_type_of(infra_env.name), []).append(Zone(zone, infra_env.name))
    return tuple(
        NodeType(name, tuple(sorted(zones, key=lambda z: (_natural(z.zone), z.infra_env))))
        for name, zones in sorted(grouped.items())
    )
