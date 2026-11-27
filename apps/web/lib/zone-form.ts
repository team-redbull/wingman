/**
 * A logical nodepool on the create form (ADR-0072): the customer picks a node
 * type (`r760-mtl`) and sets each zone's replicas; behind it, day1 writes one
 * NodePool per zone of that node type on the MCE, every one with the
 * nodepool's config. The form keeps the pick in the nodepool as `node_type`
 * (a flavor may preset it) and each zone's replicas in `zone_replicas`, by
 * InfraEnv; a zone not set there starts at the nodepool's `replicas` (the
 * flavor's preset, else the template's). Under a ratio or a locked replicas
 * every zone has the nodepool's replicas, read-only.
 *
 * A nodepool is logical while the MCE's node types are listed and its
 * `node_type` is one of them with several zones; a node type in one zone is
 * one NodePool, sent as that zone's InfraEnv as before. Without the list
 * (live status off, or the read failed) it is one NodePool on the InfraEnv
 * the person types, as before; so is one whose flavor presets an InfraEnv
 * (before node types), until the person spreads it over every zone. The
 * request sends a logical nodepool as `node_type` and
 * `zones: [{infra_env, replicas}]` for every zone, 0 included
 * (`wingman_day1.domain.zone_inputs`).
 */

import { nodeTypeOf, zoneLabel } from "@/lib/node-types";
import type { NodeType, NodeTypeZone } from "@/types";

export const NODE_TYPE = "node_type";
const ZONE_REPLICAS = "zone_replicas";

type Pool = Record<string, unknown>;
type NodeTypes = readonly NodeType[] | null | undefined;

const isMap = (value: unknown): value is Pool => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The form's nodepools, each a map (anything else as an empty one). */
export const formPools = (form: Record<string, unknown>): Pool[] =>
  Array.isArray(form.nodepools) ? form.nodepools.map((p) => (isMap(p) ? p : {})) : [];

/** `pool` without `keys`. */
const without = (pool: Pool, keys: readonly string[]): Pool => Object.fromEntries(Object.entries(pool).filter(([k]) => !keys.includes(k)));

/** `form` with nodepool `index` replaced by `pool`. */
export function withPool<T extends Record<string, unknown>>(form: T, index: number, pool: Pool): T {
  const pools = Array.isArray(form.nodepools) ? form.nodepools : [];
  return { ...form, nodepools: pools.map((p, i) => (i === index ? pool : p)) };
}

/** The nodepool's `node_type` as the MCE lists it; `null` when it names none the MCE has. */
export function listedType(pool: Pool, nodeTypes: NodeTypes): NodeType | null {
  const name = text(pool[NODE_TYPE]);
  return name && nodeTypes ? (nodeTypes.find((t) => t.name === name) ?? null) : null;
}

/**
 * The node type a nodepool is spread over: its listed `node_type`, when that
 * has several zones; `null` for one NodePool (no list, an InfraEnv of its own,
 * or a node type in one zone, sent as that zone's InfraEnv).
 */
export function spreadType(pool: Pool, nodeTypes: NodeTypes): NodeType | null {
  const type = listedType(pool, nodeTypes);
  return type && type.zones.length > 1 ? type : null;
}

/** A whole number of at least 0, from a number or its digits; `null` for anything else. */
function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : null;
}

/** What a zone's replicas input holds: the nodepool's own under a ratio or a lock (`fixed`), else the zone's. */
export function zoneValue(pool: Pool, infraEnv: string, fixed: boolean): unknown {
  const zones = isMap(pool[ZONE_REPLICAS]) ? pool[ZONE_REPLICAS] : {};
  return fixed || zones[infraEnv] === undefined ? pool.replicas : zones[infraEnv];
}

/** The nodepool after a node type is picked: its zones start over; in one zone, that zone's InfraEnv is its own. */
export function chooseNodeType(pool: Pool, name: string | null, nodeTypes: NodeTypes): Pool {
  const zones = nodeTypes?.find((t) => t.name === name)?.zones ?? [];
  const next: Pool = { ...pool, [NODE_TYPE]: name ?? "", infra_env: zones.length === 1 ? zones[0].infra_env : "" };
  delete next[ZONE_REPLICAS];
  return next;
}

/** The nodepool with one zone's replicas set (as typed). */
export const setZoneReplicas = (pool: Pool, infraEnv: string, value: unknown): Pool => ({
  ...pool,
  [ZONE_REPLICAS]: { ...(isMap(pool[ZONE_REPLICAS]) ? pool[ZONE_REPLICAS] : {}), [infraEnv]: value },
});

/** A nodepool on one InfraEnv (a flavor's older preset) spread over every zone of its node type. */
export const spreadOverZones = (pool: Pool, nodeTypes: NodeTypes): Pool =>
  chooseNodeType(pool, nodeTypeOf(text(pool.infra_env)), nodeTypes);

/** The InfraEnvs a nodepool's NodePools draw from, for their names: its listed node type's zones; `null` without one. */
export function zoneInfraEnvs(pool: Pool, nodeTypes: NodeTypes): string[] | null {
  return listedType(pool, nodeTypes)?.zones.map((z) => z.infra_env) ?? null;
}

/** Every zone's replicas as the request sends them; `null` for a zone not a whole number of at least 0. */
export function zoneCounts(pool: Pool, zones: readonly NodeTypeZone[], fixed: boolean): (number | null)[] {
  return zones.map((z) => count(zoneValue(pool, z.infra_env, fixed)));
}

/**
 * The request's nodepools from `vars` (`requestVariables`' output): a logical
 * one as its config with `node_type` and every zone's `{infra_env, replicas}`,
 * its `replicas` kept only under a lock (`locked(i)`); a ratio or a lock fixes
 * every zone's replicas (`fixed(i)`). A node type in one zone is that zone's
 * InfraEnv; any other nodepool loses only the form's own keys.
 */
export function zonedRequest(
  vars: Record<string, unknown>,
  nodeTypes: NodeTypes,
  { fixed, locked }: { fixed: (index: number) => boolean; locked: (index: number) => boolean }
): Record<string, unknown> {
  if (!Array.isArray(vars.nodepools)) return vars;
  const nodepools = vars.nodepools.map((raw, i) => {
    if (!isMap(raw)) return raw;
    const pool = without(raw, [NODE_TYPE, ZONE_REPLICAS]);
    const listed = listedType(raw, nodeTypes);
    if (listed?.zones.length === 1) return { ...pool, infra_env: listed.zones[0].infra_env };
    const type = spreadType(raw, nodeTypes);
    if (!type) return pool;
    const counts = zoneCounts(raw, type.zones, fixed(i));
    const zones = type.zones.map((z, j) => ({ infra_env: z.infra_env, replicas: counts[j] }));
    const config = without(pool, ["infra_env", "replicas"]);
    return { ...config, ...(locked(i) ? { replicas: pool.replicas } : {}), [NODE_TYPE]: type.name, zones };
  });
  return { ...vars, nodepools };
}

/** A nodepool's InfraEnv for the required check: its listed node type's first zone, when it has one. */
export function withZoneInfraEnvs(form: Record<string, unknown>, nodeTypes: NodeTypes): Record<string, unknown> {
  if (!Array.isArray(form.nodepools)) return form;
  return {
    ...form,
    nodepools: form.nodepools.map((p) => {
      const type = isMap(p) ? listedType(p, nodeTypes) : null;
      return type && isMap(p) ? { ...p, infra_env: type.zones[0]?.infra_env ?? "" } : p;
    }),
  };
}

/**
 * Why each nodepool's node type and zones stop the review, by index: a node
 * type this MCE does not have (a flavor's preset, say), a zone's replicas
 * not a whole number, no replica in any zone.
 */
export function zoneProblems(form: Record<string, unknown>, nodeTypes: NodeTypes, fixed: (index: number) => boolean): Record<number, string> {
  const found: Record<number, string> = {};
  if (!nodeTypes) return found;
  formPools(form).forEach((pool, i) => {
    const name = text(pool[NODE_TYPE]);
    if (name && !listedType(pool, nodeTypes)) {
      found[i] = `This MCE has no node type ${name}: pick one it has`;
      return;
    }
    const type = spreadType(pool, nodeTypes);
    if (!type) return;
    const counts = zoneCounts(pool, type.zones, fixed(i));
    const bad = type.zones.find((_, j) => counts[j] === null);
    if (bad) found[i] = `${zoneLabel(bad.zone)}: replicas are a whole number of at least 0`;
    else if (counts.every((c) => c === 0)) found[i] = "Every zone has 0 replicas: give one at least a replica";
  });
  return found;
}

/** The servers a logical nodepool needs, `<zone's InfraEnv>:<replicas>` per zone with any; `null` for one NodePool. */
export function zoneNeeds(pool: Pool): string[] | null {
  if (!Array.isArray(pool.zones)) return null;
  return pool.zones.flatMap((z) => {
    const zone = isMap(z) ? z : {};
    const replicas = count(zone.replicas);
    return typeof zone.infra_env === "string" && replicas !== null && replicas > 0 ? [`${zone.infra_env}:${replicas}`] : [];
  });
}
