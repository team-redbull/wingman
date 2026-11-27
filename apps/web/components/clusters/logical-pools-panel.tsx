"use client";

import { useMemo } from "react";
import { AlertTriangle, Layers } from "lucide-react";
import { load } from "@/lib/infra-envs";
import { groupLabel, logicalPools, type LogicalPool } from "@/lib/logical-pools";
import { plural } from "@/lib/utils";
import { ZONE_LABEL } from "@/lib/zone-labels";

type Entry = Record<string, unknown>;

/** What one configuration of a logical nodepool is: every NodePool of it has the same (ADR-0072). */
const CONFIG_KEYS = ["configs", "nodeLabels", "tuningConfig", "annotations", "labels"] as const;

/** A NodePool's zone on its Nodes is its own (ADR-0072), never part of the one configuration. */
function withoutZone(labels: unknown): unknown {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return labels;
  return Object.fromEntries(Object.entries(labels).filter(([key]) => key !== ZONE_LABEL));
}

const configOf = (entry: Entry) =>
  JSON.stringify(CONFIG_KEYS.map((key) => (key === "nodeLabels" ? withoutZone(entry[key]) : entry[key]) ?? null));

function entriesOf(text: string): Entry[] {
  const doc = load(text);
  const pools = doc && Array.isArray(doc.nodepool) ? doc.nodepool : [];
  return pools.map((p: unknown) => (p && typeof p === "object" && !Array.isArray(p) ? (p as Entry) : {}));
}

/** The NodePools of `pool` whose configuration is not its first's. */
function differing(pool: LogicalPool<Entry>): string[] {
  const first = configOf(pool.members[0].entry);
  return pool.members.filter((m) => configOf(m.entry) !== first).map((m) => String(m.entry.name ?? m.entry.infraEnvName ?? `nodepool[${m.index}]`));
}

/**
 * The file's logical nodepools while it is edited (ADR-0072): the NodePools
 * of one node type and suffix, one per zone, each with its replicas, and a
 * warning when their configuration (configs, node labels but each one's zone,
 * tuning profiles, annotations, labels) is no longer one: the text edits each NodePool, so a
 * change meant for the nodepool is made in every zone's.
 */
export function LogicalPoolsPanel({ text }: { text: string }) {
  const groups = useMemo(
    () => logicalPools(entriesOf(text), (e) => ({ name: typeof e.name === "string" ? e.name : null, infraEnv: typeof e.infraEnvName === "string" ? e.infraEnvName : null })).filter((g) => g.members.length > 1),
    [text]
  );
  if (groups.length === 0) return null;
  return (
    <section className="border-b border-zinc-800 bg-card text-card-foreground" aria-label="Nodepools by node type" data-testid="edit-logical-pools">
      <p className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 text-xs font-medium">
        <Layers className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        Nodepools by node type
        <span className="font-normal text-muted-foreground">· one NodePool per zone, one configuration: change every zone&apos;s alike</span>
      </p>
      <ul className="divide-y divide-border">
        {groups.map((group) => {
          const off = differing(group);
          return (
            <li key={group.members[0].index} className="space-y-0.5 px-3 py-2 text-xs" data-testid={`edit-logical-pool-${group.members[0].index}`}>
              <p>
                <span className="font-mono font-medium">{groupLabel(group)}</span>{" "}
                <span className="text-muted-foreground">
                  · {plural(group.members.length, "zone")}:{" "}
                  {group.members.map((m) => `${m.zone ?? "?"} ${typeof m.entry.replicas === "number" ? m.entry.replicas : "—"}`).join(" · ")}
                </span>
              </p>
              {off.length > 0 && (
                <p className="flex items-start gap-1.5 text-status-warning-fg" role="status">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 break-words">
                    {off.join(", ")} {off.length === 1 ? "has" : "have"} another configuration than the first zone&apos;s: a
                    logical nodepool&apos;s NodePools share one.
                  </span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
