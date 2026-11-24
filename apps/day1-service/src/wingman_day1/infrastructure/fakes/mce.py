"""The fake MCE hubs for ``DAY1_FAKE_FLEET``, built from ``dev/fleet-fixtures/mce.yaml``.

Each scenario in the fixture becomes the objects a real MCE serves for a
hosted cluster: its HostedCluster and NodePools, and in its control-plane
namespace the MachineSets, Machines and AgentMachines, with the Agents in its
agent namespace. They are built as Kubernetes JSON (``fakes/mce_objects.py``)
and read with ``HttpHubApi``'s own parsers, so the fake cannot drift from
what the adapter understands. Agents carry the servers' serials and MACs from
the fake server-scan fleet, and their BareMetalHost label is the server's
name, lowercased as a Kubernetes name is.

Each hub's own nodes and pods (``hubs:``, for MCE placement's free pods,
ADR-0050) are built as Node objects and a pod Table, read with the
adapter's parsers too, and its ``infra_envs`` are InfraEnvs with agentLabels.
An MCE in neither ``hubs`` nor a fixture cluster is not configured.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Final

import yaml

from wingman_day1.domain.machines import (
    DEPLOYMENT_NAME_LABEL,
    NODE_POOL_ANNOTATION,
    REVISION_ANNOTATION,
    UPGRADE_IN_PROGRESS_ANNOTATION,
    AgentMachineObservation,
    AgentObservation,
    MachineObservation,
    MachineSetObservation,
)
from wingman_day1.domain.mce_capacity import NodeObservation
from wingman_day1.domain.names import HostedClusterNaming, HostedClusterRef
from wingman_day1.domain.servers import ServerRow
from wingman_day1.domain.status import HostedClusterObservation, NodePoolObservation
from wingman_day1.infrastructure.fakes.hub import FakeHubApi
from wingman_day1.infrastructure.fakes.mce_objects import (
    SCENARIOS,
    agent_machine_object,
    agent_name,
    agent_object,
    hosted_cluster_object,
    machine_object,
    node_object,
    node_pool_object,
    pod_table,
    short,
)
from wingman_day1.infrastructure.hub.parse import (
    agent_from,
    agent_machine_from,
    hosted_cluster_from,
    machine_from,
    machine_set_from,
    node_from,
    node_pool_from,
    pods_per_node_from,
)

MCE_FILE: Final = Path("dev/fleet-fixtures/mce.yaml")
Fixture = Mapping[str, Any]
"""One entry of the fixture, as YAML reads it."""


def default_mce_file() -> Path:
    """``dev/fleet-fixtures/mce.yaml`` of this checkout."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / MCE_FILE
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"{MCE_FILE} not found above this file")


def load_fake_mce(
    path: Path, *, servers: Iterable[ServerRow], naming: HostedClusterNaming
) -> FakeHubApi:
    """The fake MCE hubs the fixture at ``path`` describes, for these servers and naming."""
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("clusters"), list):
        raise TypeError(f"{path}: expected a mapping with a 'clusters' list")
    builder = _Builder(servers, naming=naming, agent_namespace=str(raw["agent_namespace"]))
    for cluster in raw["clusters"]:
        builder.cluster(cluster)
    for mce, nodes in (raw.get("hubs") or {}).items():
        builder.hub_nodes(str(mce), nodes)
    return builder.hub()


class _Builder:
    """Turns scenarios into the Kubernetes objects an MCE would serve, and parses them."""

    def __init__(
        self, servers: Iterable[ServerRow], *, naming: HostedClusterNaming, agent_namespace: str
    ) -> None:
        self._servers = {row.name.lower(): row for row in servers}
        self._naming = naming
        self._agent_ns = agent_namespace
        self._hosted: dict[str, list[HostedClusterObservation]] = defaultdict(list)
        self._pools: dict[tuple[str, str], list[NodePoolObservation]] = defaultdict(list)
        self._machines: dict[tuple[str, str], list[MachineObservation]] = defaultdict(list)
        self._sets: dict[tuple[str, str], list[MachineSetObservation]] = defaultdict(list)
        self._agent_machines: dict[tuple[str, str], list[AgentMachineObservation]] = defaultdict(
            list
        )
        self._agents: dict[tuple[str, str], list[AgentObservation]] = defaultdict(list)
        self._infra_envs: dict[str, set[str]] = defaultdict(set)
        self._labels: dict[str, dict[str, dict[str, str]]] = defaultdict(dict)
        self._nodes: dict[str, list[NodeObservation]] = {}
        self._pods: dict[str, dict[str, int]] = {}

    def hub_nodes(self, mce: str, raw: Fixture) -> None:
        """An MCE's own nodes, their pods and its free Agents, in the shapes the adapter reads."""
        nodes: Sequence[Fixture] = raw.get("nodes") or []
        self._nodes[mce] = [node_from(node_object(node)) for node in nodes]
        self._pods[mce] = pods_per_node_from(pod_table(nodes))
        for name, labels in (raw.get("infra_envs") or {}).items():
            self._infra_envs[mce].add(str(name))
            self._labels[mce][str(name)] = {str(k): str(v) for k, v in labels.items()}
        for free in raw.get("free_agents") or []:
            self._add_agent(mce, str(free["server"]), str(free["infra_env"]), scenario="free")

    def hub(self) -> FakeHubApi:
        """Every hub built so far."""
        return FakeHubApi(
            nodes=self._nodes,
            pods=self._pods,
            hosted_clusters=self._hosted,
            node_pools=self._pools,
            infra_envs={mce: {self._agent_ns: sorted(n)} for mce, n in self._infra_envs.items()},
            agent_labels=self._labels,
            machines=self._machines,
            machine_sets=self._sets,
            agent_machines=self._agent_machines,
            agents=self._agents,
        )

    def cluster(self, raw: Fixture) -> None:
        """One fixture cluster: its HostedCluster, its NodePools' objects, its spare Agents."""
        ref = self._naming.for_file(str(raw["name"]))
        mce = str(raw["mce"])
        hosted = hosted_cluster_object(
            ref, version=str(raw["version"]), agent_namespace=self._agent_ns
        )
        self._hosted[mce].append(
            hosted_cluster_from(hosted, namespace=ref.namespace, name=ref.name)
        )
        for pool in raw.get("node_pools") or []:
            self._pool(mce, ref, pool)
        for spare in raw.get("spare_agents") or []:
            self._spare_agent(mce, spare)

    def _pool(self, mce: str, ref: HostedClusterRef, raw: Fixture) -> None:
        infra_env = str(raw["infra_env"])
        name = f"{ref.cluster_name}-{infra_env}"
        key = f"{ref.namespace}/{name}"
        nodes: Sequence[Fixture] = raw.get("nodes") or []
        updating: Fixture | None = raw.get("updating")
        progress = None
        if updating is not None and str(raw["upgrade"]) == "InPlace":
            progress = (
                f"Nodepool update in progress. Target Config version: {short(str(updating))}. "
                f"Total Nodes: {len(nodes)}. Upgraded: {updating.get('upgraded', 0)}"
            )
        set_names = self._machine_sets(mce, ref, raw, pool=name, key=key, progress=progress)
        self._infra_envs[mce].add(infra_env)
        machines = [
            self._node(
                mce,
                ref,
                node,
                i,
                set_name=set_names[int(node.get("revision", 1))],
                pool=name,
                key=key,
                infra_env=infra_env,
            )
            for i, node in enumerate(nodes)
        ]
        pool = node_pool_object(ref, name, infra_env, raw, machines, progress)
        self._pools[(mce, ref.namespace)].append(node_pool_from(pool))

    def _machine_sets(
        self,
        mce: str,
        ref: HostedClusterRef,
        raw: Fixture,
        *,
        pool: str,
        key: str,
        progress: str | None,
    ) -> dict[int, str]:
        """The pool's MachineSets by revision: one named after it (InPlace), or one per revision."""
        in_place = str(raw["upgrade"]) == "InPlace"
        nodes: Sequence[Fixture] = raw.get("nodes") or []
        revisions = sorted({int(node.get("revision", 1)) for node in nodes} | {1})
        names: dict[int, str] = {}
        for revision in revisions:
            name = pool if in_place else f"{pool}-{short(f'{pool}/{revision}')}"
            annotations = {NODE_POOL_ANNOTATION: key}
            labels: dict[str, str] = {}
            if in_place and progress is not None:
                annotations[UPGRADE_IN_PROGRESS_ANNOTATION] = progress
            if not in_place:
                annotations[REVISION_ANNOTATION] = str(revision)
                labels[DEPLOYMENT_NAME_LABEL] = pool
            machine_set = {"metadata": {"name": name, "labels": labels, "annotations": annotations}}
            self._sets[(mce, ref.control_plane_namespace)].append(machine_set_from(machine_set))
            names[revision] = name
        return names

    def _node(
        self,
        mce: str,
        ref: HostedClusterRef,
        raw: Fixture,
        index: int,
        *,
        set_name: str,
        pool: str,
        key: str,
        infra_env: str,
    ) -> str:
        """Add one node's Machine, AgentMachine and Agent; returns the Machine's name."""
        scenario = str(raw.get("as", "ready"))
        if scenario not in SCENARIOS:
            raise ValueError(f"{pool}: a node is {scenario!r}; expected one of {sorted(SCENARIOS)}")
        server = raw.get("server")
        name = f"{set_name}-{short(str(server or f'{pool}/machine/{index}'))}"
        agent = agent_name(server) if server and scenario != "waiting" else None
        host = str(server).lower() if server else None
        machine = machine_object(
            ref,
            name,
            set_name=set_name,
            pool=pool,
            key=key,
            scenario=scenario,
            agent=agent,
            host=host,
        )
        namespace = ref.control_plane_namespace
        self._machines[(mce, namespace)].append(machine_from(machine))
        self._agent_machines[(mce, namespace)].append(
            agent_machine_from(agent_machine_object(name, agent, scenario, self._agent_ns))
        )
        if agent is not None and server is not None:
            self._add_agent(
                mce, str(server), infra_env, scenario=scenario, taken_by=name, hostname=host
            )
        return name

    def _spare_agent(self, mce: str, raw: Fixture) -> None:
        server, scenario = str(raw["server"]), str(raw["as"])
        if scenario not in {"bound", "unapproved"}:
            raise ValueError(f"spare Agent {server}: {scenario!r} is neither bound nor unapproved")
        infra_env = str(raw["infra_env"])
        taken_by = f"{infra_env}-gone" if scenario == "bound" else None
        self._add_agent(mce, server, infra_env, scenario=scenario, taken_by=taken_by)

    def _add_agent(
        self,
        mce: str,
        server: str,
        infra_env: str,
        *,
        scenario: str,
        taken_by: str | None = None,
        hostname: str | None = None,
    ) -> None:
        """``server``'s Agent in ``infra_env``'s pool, which the hub then has."""
        row = self._servers.get(server.lower())
        if row is None:
            raise ValueError(f"an Agent names {server!r}, which servers.yaml does not have")
        self._infra_envs[mce].add(infra_env)
        agent = agent_object(
            row, infra_env, scenario=scenario, taken_by=taken_by, hostname=hostname
        )
        self._agents[(mce, self._agent_ns)].append(agent_from(agent))
