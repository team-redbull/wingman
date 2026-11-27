/**
 * A cluster file's NodePools as logical nodepools (ADR-0072): the NodePools
 * whose InfraEnvs are one node type and whose names carry one suffix
 * (`<InfraEnv>[-<suffix>]`, ADR-0071; a derived name has none) are one
 * logical nodepool, a NodePool per zone with the same config, in the order
 * the first of each appears. A NodePool named off the rule, or drawing from
 * no InfraEnv, is one alone. Read from the names alone, as day1's drift reads
 * them (`wingman_day1.domain.logical_pools`).
 */

import { nodeTypeOf, zoneOf } from "@/lib/node-types";
import { followsRule } from "@/lib/nodepool-names";
import type { NodeType } from "@/types";

/** What grouping reads of a file entry: its written `name` and its InfraEnv. */
export interface PoolNames {
  name: string | null | undefined;
  infraEnv: string | null | undefined;
}

/** `node type\u0000suffix`, or `null` when the entry groups with no other. */
function logicalKey({ name, infraEnv }: PoolNames): string | null {
  if (!infraEnv) return null;
  if (!name || name === infraEnv) return `${nodeTypeOf(infraEnv)}\u0000`;
  if (!followsRule(name, infraEnv)) return null;
  return `${nodeTypeOf(infraEnv)}\u0000${name.slice(infraEnv.length + 1)}`;
}

export interface LogicalPool<T> {
  /** `null` for an entry that is a group alone. */
  nodeType: string | null;
  suffix: string;
  /** The entries, in file order, with their index in the file. */
  members: { index: number; entry: T; zone: string | null }[];
}

/** The entries grouped, each group where its first entry is. */
export function logicalPools<T>(entries: readonly T[], read: (entry: T) => PoolNames, nodeTypes?: readonly NodeType[] | null): LogicalPool<T>[] {
  const groups: { key: string | null; pool: LogicalPool<T> }[] = [];
  entries.forEach((entry, index) => {
    const names = read(entry);
    const key = logicalKey(names);
    const member = { index, entry, zone: names.infraEnv ? zoneOf(names.infraEnv, nodeTypes) : null };
    const found = key === null ? undefined : groups.find((g) => g.key === key);
    if (found) {
      found.pool.members.push(member);
      return;
    }
    const [nodeType, suffix] = key === null ? [null, ""] : key.split("\u0000");
    groups.push({ key, pool: { nodeType, suffix, members: [member] } });
  });
  return groups.map((g) => g.pool);
}

/** `r760-mtl`, `r760-mtl · gpu` with a suffix: a logical nodepool in a customer's words. */
export const groupLabel = (pool: { nodeType: string | null; suffix: string }): string =>
  pool.nodeType === null ? "" : pool.suffix ? `${pool.nodeType} · ${pool.suffix}` : pool.nodeType;
