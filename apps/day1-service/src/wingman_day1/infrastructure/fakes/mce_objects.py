"""The Kubernetes JSON the fake MCE hubs serve, built from ``dev/fleet-fixtures/mce.yaml``.

Each function builds one object as the API server sends it, for one of the
fixture's scenarios: a node ``ready``, ``rebooting`` (Ready Unknown),
``waiting`` (no free Agent), ``installing`` (writing its image to disk) or
``deleting`` (draining); a spare Agent ``bound`` or ``unapproved``, or
``free``. ``fakes/mce.py`` reads every object with ``HttpHubApi``'s own
parsers, so these must stay the shapes a real hub serves (ADR-0038, ADR-0050).
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Final

from wingman_day1.domain.machines import (
    AGENT_MACHINE_REF_LABEL,
    BMH_LABEL,
    DEPLOYMENT_NAME_LABEL,
    INFRA_ENV_LABEL,
    NODE_POOL_ANNOTATION,
    PROVIDER_ID_PREFIX,
    SET_NAME_LABEL,
)
from wingman_day1.domain.names import HostedClusterRef
from wingman_day1.domain.servers import ServerRow

JSON = dict[str, Any]
DELETING_SINCE: Final = "2026-11-11T07:55:00Z"
SCENARIOS: Final = frozenset({"ready", "rebooting", "waiting", "installing", "deleting"})
"""What a NodePool's node may be in the fixture (``as:``)."""
WITH_NODE: Final = frozenset({"ready", "rebooting", "deleting"})
"""The scenarios whose Machine has a Node: its Agent is installed."""
_MACHINE_PHASE: Final = {
    "ready": "Running",
    "rebooting": "Running",
    "waiting": "Pending",
    "installing": "Provisioned",
    "deleting": "Deleting",
}
_NOT_READY_REASON: Final = {
    "waiting": "NoSuitableAgents",
    "installing": "InstallationInProgress",
    "deleting": "Deleting",
}
_UNHEALTHY_REASON: Final = {
    "rebooting": "NodeConditionsFailed: Node condition Ready is Unknown.",
    "waiting": "WaitingForNodeRef",
    "installing": "WaitingForNodeRef",
}
_AGENT_STATE: Final = {
    "installing": ("installing-in-progress", "Writing image to disk"),
    "bound": ("unbinding-pending-user-action", None),
    "unapproved": ("known-unbound", None),
    "free": ("known-unbound", None),
}
_INSTALLED_STATE: Final = ("added-to-existing-cluster", "Done")


def short(text: str) -> str:
    """Five stable lowercase characters, like the random suffixes CAPI gives names."""
    return hashlib.sha256(text.encode()).hexdigest()[:5]


def agent_name(server: str) -> str:
    """The Agent's name for a server: a UUID, stable per server, as the hub names Agents."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"fake-agent/{server.lower()}"))


def condition(kind: str, status: bool, reason: str = "", message: str = "") -> JSON:
    """A Kubernetes condition."""
    return {
        "type": kind,
        "status": "True" if status else "False",
        "reason": reason,
        "message": message,
    }


# ── The hub's own nodes and pods (placement, ADR-0050) ──────────────────────


def node_object(raw: Mapping[str, Any]) -> JSON:
    """A Node as the API server serves it: its role labels, cordon, Ready and allocatable pods."""
    role = str(raw.get("role", "worker"))
    roles = ("master", "control-plane") if role == "control-plane" else (role,)
    ready = bool(raw.get("ready", True))
    spec: JSON = {"unschedulable": True} if raw.get("cordoned") else {}
    if raw.get("tainted") or role == "infra":
        spec["taints"] = [{"key": "node-role.kubernetes.io/infra", "effect": "NoSchedule"}]
    return {
        "metadata": {
            "name": str(raw["name"]),
            "labels": {f"node-role.kubernetes.io/{r}": "" for r in roles},
        },
        "spec": spec,
        "status": {
            "allocatable": {"pods": str(raw.get("allocatable", 250))},
            "conditions": [
                condition("Ready", ready, "KubeletReady" if ready else "NodeStatusUnknown")
            ],
        },
    }


def pod_table(nodes: Sequence[Mapping[str, Any]]) -> JSON:
    """The hub's non-terminal pods as a Table: ``pods`` rows per node, plus one not bound yet."""
    columns = ("Name", "Ready", "Status", "Restarts", "Age", "IP", "Node")
    rows = [
        {
            "cells": [
                f"{node['name']}-pod-{i}",
                "1/1",
                "Running",
                "0",
                "9d",
                "10.128.0.2",
                str(node["name"]),
            ]
        }
        for node in nodes
        for i in range(int(node.get("pods", 0)))
    ]
    rows.append({"cells": ["pending-0", "0/1", "Pending", "0", "1m", "<none>", "<none>"]})
    return {
        "kind": "Table",
        "apiVersion": "meta.k8s.io/v1",
        "metadata": {"continue": ""},
        "columnDefinitions": [{"name": name, "type": "string"} for name in columns],
        "rows": rows,
    }


# ── A hosted cluster's objects ──────────────────────────────────────────────


def hosted_cluster_object(ref: HostedClusterRef, *, version: str, agent_namespace: str) -> JSON:
    """A HostedCluster that is Available at ``version``."""
    return {
        "metadata": {"name": ref.name, "namespace": ref.namespace},
        "spec": {"platform": {"type": "Agent", "agent": {"agentNamespace": agent_namespace}}},
        "status": {
            "version": {"history": [{"version": version, "state": "Completed"}]},
            "conditions": [
                condition("Available", True, "AsExpected"),
                condition("Degraded", False, "AsExpected"),
                condition("Progressing", False, "AsExpected"),
            ],
        },
    }


def node_pool_object(
    ref: HostedClusterRef,
    name: str,
    infra_env: str,
    raw: Mapping[str, Any],
    machines: Sequence[str],
    progress: str | None,
) -> JSON:
    """A NodePool over ``machines``, its conditions worded as HyperShift's aggregator words them."""
    nodes: Sequence[Mapping[str, Any]] = raw.get("nodes") or []
    scenarios = [str(node.get("as", "ready")) for node in nodes]
    updating: Mapping[str, Any] | None = raw.get("updating")
    kind = updating.get("kind") if updating else None
    message = progress
    if updating is not None and progress is None:
        message = f"Updating {kind} in progress. Target {kind}: {updating.get('target')}"
    return {
        "metadata": {"name": name, "namespace": ref.namespace},
        "spec": {
            "clusterName": ref.name,
            "replicas": int(raw["replicas"]),
            "management": {"upgradeType": str(raw["upgrade"])},
            "platform": {
                "type": "Agent",
                "agent": {"agentLabelSelector": {"matchLabels": {INFRA_ENV_LABEL: infra_env}}},
            },
        },
        "status": {
            "replicas": scenarios.count("ready"),
            "version": str(raw["version"]),
            "conditions": [
                condition("Ready", True, "AsExpected"),
                _aggregate("AllMachinesReady", "ready", machines, scenarios, _NOT_READY_REASON),
                _aggregate("AllNodesHealthy", "healthy", machines, scenarios, _UNHEALTHY_REASON),
                _updating("UpdatingVersion", kind == "version", message),
                _updating("UpdatingConfig", kind == "config", message),
            ],
        },
    }


def _updating(kind: str, updating: bool, message: str | None) -> JSON:
    return condition(kind, updating, "AsExpected", (message or "") if updating else "")


def _aggregate(
    kind: str,
    adjective: str,
    machines: Sequence[str],
    scenarios: Sequence[str],
    reasons: Mapping[str, str],
) -> JSON:
    """A NodePool condition over its Machines, worded as HyperShift's aggregator words it."""
    bad = [(m, reasons[s]) for m, s in zip(machines, scenarios, strict=True) if s in reasons]
    if not bad:
        return condition(kind, True, "AsExpected", "All is well")
    lines = "".join(f"Machine {machine}: {reason}\n" for machine, reason in bad)
    message = f"{len(bad)} of {len(machines)} machines are not {adjective}\n{lines}"
    reason = ",".join(sorted({reason.split(":", 1)[0] for _, reason in bad}))
    return condition(kind, False, reason, message)


def machine_object(
    ref: HostedClusterRef,
    name: str,
    *,
    set_name: str,
    pool: str,
    key: str,
    scenario: str,
    agent: str | None,
    host: str | None,
) -> JSON:
    """A CAPI Machine of ``set_name`` in ``pool``, on Agent ``agent`` once it has one."""
    labels = {SET_NAME_LABEL: set_name}
    if set_name != pool:
        labels[DEPLOYMENT_NAME_LABEL] = pool
    metadata: JSON = {"name": name, "labels": labels, "annotations": {NODE_POOL_ANNOTATION: key}}
    if scenario == "deleting":
        metadata["deletionTimestamp"] = DELETING_SINCE
    return {
        "metadata": metadata,
        "spec": {
            "clusterName": ref.name,
            "infrastructureRef": {"kind": "AgentMachine", "name": name},
            **({"providerID": f"{PROVIDER_ID_PREFIX}{agent}"} if agent else {}),
        },
        "status": {
            "phase": _MACHINE_PHASE[scenario],
            **({"nodeRef": {"kind": "Node", "name": host}} if scenario in WITH_NODE else {}),
            "conditions": _machine_conditions(scenario),
        },
    }


def _machine_conditions(scenario: str) -> list[JSON]:
    if scenario == "waiting":
        return [
            condition("Ready", False, "NoSuitableAgents", "0 of 5 completed"),
            condition("InfrastructureReady", False, "NoSuitableAgents", "0 of 5 completed"),
            condition("NodeHealthy", False, "WaitingForNodeRef"),
        ]
    if scenario == "installing":
        return [
            condition("Ready", False, "InstallationInProgress", "3 of 5 completed"),
            condition("InfrastructureReady", False, "InstallationInProgress", "3 of 5 completed"),
            condition("NodeHealthy", False, "WaitingForNodeRef"),
        ]
    rebooting = scenario == "rebooting"
    failed = "NodeConditionsFailed" if rebooting else ""
    unknown = "Node condition Ready is Unknown. " if rebooting else ""
    conditions = [
        condition("Ready", not rebooting, failed),
        condition("InfrastructureReady", True),
        condition("NodeHealthy", not rebooting, failed, unknown),
    ]
    if scenario == "deleting":
        conditions += [
            condition("PreDrainDeleteHookSucceeded", True),
            condition("DrainingSucceeded", False, "Draining", "Draining the node before deletion"),
        ]
    return conditions


def agent_machine_object(name: str, agent: str | None, scenario: str, agent_ns: str) -> JSON:
    """The Machine's AgentMachine: no Agent reserved yet, or ``agent`` installing or installed."""
    if agent is None:
        not_yet = [
            condition(kind, False, "AgentNotYetFound", "Agent not yet reserved")
            for kind in ("AgentSpecSynced", "AgentValidated", "AgentRequirementsMet", "Installed")
        ]
        return {
            "metadata": {"name": name},
            "status": {
                "conditions": [condition("AgentReserved", False, "NoSuitableAgents"), *not_yet]
            },
        }
    installed = scenario != "installing"
    return {
        "metadata": {"name": name},
        "spec": {"providerID": f"{PROVIDER_ID_PREFIX}{agent}"},
        "status": {
            "agentRef": {"namespace": agent_ns, "name": agent},
            "conditions": [
                condition("AgentReserved", True),
                condition("AgentSpecSynced", True),
                condition("AgentValidated", True),
                condition("AgentRequirementsMet", True),
                condition(
                    "Installed",
                    installed,
                    "" if installed else "InstallationInProgress",
                    "" if installed else "The installation is in progress: Writing image to disk",
                ),
            ],
        },
    }


def agent_object(
    server: ServerRow,
    infra_env: str,
    *,
    scenario: str,
    taken_by: str | None,
    hostname: str | None,
) -> JSON:
    """``server``'s Agent in ``infra_env``'s pool, bound to Machine ``taken_by`` when it is."""
    host = server.name.lower()
    labels = {BMH_LABEL: host, INFRA_ENV_LABEL: infra_env}
    if taken_by is not None:
        labels[AGENT_MACHINE_REF_LABEL] = taken_by
    state, stage = _AGENT_STATE.get(scenario, _INSTALLED_STATE)
    installing = scenario == "installing"
    return {
        "metadata": {"name": agent_name(server.name), "labels": labels},
        "spec": {"approved": scenario != "unapproved", "hostname": hostname or host},
        "status": {
            "debugInfo": {"state": state},
            **({"progress": {"currentStage": stage}} if stage else {}),
            "inventory": {
                "hostname": host,
                "systemVendor": {"serialNumber": server.serial, "manufacturer": server.vendor},
                "interfaces": [{"macAddress": mac} for mac in server.macs],
            },
            "conditions": [
                condition("Connected", True, "AgentIsConnected"),
                condition("Validated", True, "ValidationsPassing"),
                condition("Bound", scenario not in {"unapproved", "free"}, "Bound"),
                condition(
                    "Installed",
                    scenario in WITH_NODE,
                    "InstallationInProgress" if installing else "InstallationCompleted",
                ),
            ],
        },
    }
