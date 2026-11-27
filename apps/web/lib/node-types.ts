/**
 * Node types (ADR-0072): the kind of server a customer picks, an InfraEnv
 * without its zone. The platform's naming convention names an InfraEnv
 * `<flavor>-<size>-<zone>` (`r760-mtl-az1`); its node type is `r760-mtl`, and
 * the node type's InfraEnvs on an MCE are its zones. A name off the
 * convention (`dell-r660-site1-128c-1024gb-5tb`) is its own node type, in one
 * unnamed zone. Day1 reads the zone from the InfraEnv's
 * `topology.kubernetes.io/zone` label where it reads the MCE
 * (`GET /mces/{mce}/node-types`); the name alone gives the rest.
 *
 * The web's one parser of the convention (day1's is
 * `wingman_day1.domain.node_types`): Inventory Management's zone and size
 * filters read it too.
 */

import type { NodeType } from "@/types";

/** An InfraEnv's name under the platform's convention, `<flavor>-<size>-<zone>`. */
export interface InfraEnvName {
  flavor: string;
  /** `mtl` (bare metal) or `kv<cpu>` (a KubeVirt VM of that many CPUs). */
  size: string;
  zone: string;
}

const CONVENTION = /^([a-z0-9]+)-(mtl|kv[0-9]+)-([a-z0-9]+)$/;

/** `c200-kv32-az2` as its flavor, size and zone; `null` for a name off the convention (`dell-r660-site1-128c-1024gb-5tb`). */
export function parseInfraEnvName(name: string): InfraEnvName | null {
  const match = CONVENTION.exec(name);
  return match ? { flavor: match[1], size: match[2], zone: match[3] } : null;
}

/** Where an InfraEnv sits for a customer: its node type, and its zone (`null`: the name names none). */
export interface Placed {
  nodeType: string;
  zone: string | null;
}

/** `r760-mtl-az1` → `{nodeType: "r760-mtl", zone: "az1"}`; a name off the convention is its own node type. */
export function splitInfraEnv(name: string): Placed {
  const parsed = parseInfraEnvName(name);
  return parsed ? { nodeType: `${parsed.flavor}-${parsed.size}`, zone: parsed.zone } : { nodeType: name, zone: null };
}

/** The node type of an InfraEnv: `r760-mtl` for `r760-mtl-az1`, else the whole name. */
export const nodeTypeOf = (infraEnv: string): string => splitInfraEnv(infraEnv).nodeType;

/** `r760-mtl · az1`, or the node type alone when the zone is unnamed: an InfraEnv in a customer's words. */
export function placedLabel(infraEnv: string, zone: string | null = splitInfraEnv(infraEnv).zone): string {
  const { nodeType } = splitInfraEnv(infraEnv);
  return zone ? `${nodeType} · ${zone}` : nodeType;
}

/** `az1`, or "one zone" for an unnamed zone. */
export const zoneLabel = (zone: string | null): string => zone ?? "one zone";

/** The node type `infraEnv` belongs to in `nodeTypes`, by its InfraEnvs (the hub's zones); else by its name. */
export function nodeTypeFor(infraEnv: string, nodeTypes: readonly NodeType[] | null | undefined): NodeType | null {
  const found = nodeTypes?.find((t) => t.zones.some((z) => z.infra_env === infraEnv));
  return found ?? nodeTypes?.find((t) => t.name === nodeTypeOf(infraEnv)) ?? null;
}

/** The zone of `infraEnv`: the hub's, when `nodeTypes` lists it; else its name's. */
export function zoneOf(infraEnv: string, nodeTypes?: readonly NodeType[] | null): string | null {
  const listed = nodeTypes?.flatMap((t) => t.zones).find((z) => z.infra_env === infraEnv);
  return listed ? listed.zone : splitInfraEnv(infraEnv).zone;
}

/** Every InfraEnv the node types name, in their order. */
export const infraEnvsOf = (nodeTypes: readonly NodeType[]): string[] => nodeTypes.flatMap((t) => t.zones.map((z) => z.infra_env));
