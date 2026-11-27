"use client";

import type { ReactNode } from "react";
import { Layers } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import { fieldInputClassName, type FieldInputContext, type FormValues } from "@/components/clusters/dynamic-variable-form";
import { describeNodeType, nodeTypeFor, parseInfraEnvName, placedLabel, zoneLabel } from "@/lib/node-types";
import { composeName, SUFFIX_INPUT } from "@/lib/nodepool-names";
import { cn, plural } from "@/lib/utils";
import {
  NODE_TYPE, chooseNodeType, formPools, listedType, setZoneReplicas, spreadOverZones, spreadType, zoneCounts, zoneValue,
} from "@/lib/zone-form";
import type { NodeType } from "@/types";

/** What the create form knows of the MCE's node types and of each nodepool's sizing. */
export interface ZoneContext {
  /** The MCE's node types; `null` when this deployment does not read the MCE or the read failed; `undefined` while loading. */
  nodeTypes: NodeType[] | null | undefined;
  loading: boolean;
  /** Why a nodepool's replicas are the same in every zone (its ratio, its lock); `null` when each zone is set apart. */
  fixed: (index: number) => string | null;
  /** Replace nodepool `index` of the form. */
  setPool: (index: number, pool: Record<string, unknown>) => void;
  /** `zoneProblems`: a node type the MCE lacks, a zone's replicas, no replica at all. */
  problems: Readonly<Record<number, string>>;
}

const POOL_PATH = /^nodepools\[(\d+)\]\.(infra_env|replicas)$/;
/** The label each zone's NodePool sets on its Nodes (the naming convention; ADR-0072's 2026-11-28 amendment). */
const ZONE_LABEL = "topology.kubernetes.io/zone";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The create form's node type and replicas per zone (ADR-0072): at a
 * nodepool's `infra_env`, the **Node type** picker, and at its `replicas`,
 * one input per zone of that node type. Without the MCE's list the node type
 * is typed with its zone, one NodePool, as before. `undefined` for any other
 * field, and for a nodepool's replicas while it is one NodePool.
 */
export function zoneCreateInput(context: FieldInputContext, form: FormValues, zones: ZoneContext): ReactNode | undefined {
  const match = POOL_PATH.exec(context.path);
  if (!match) return undefined;
  const index = Number(match[1]);
  const pool = formPools(form)[index] ?? {};
  if (match[2] === "replicas") {
    const type = spreadType(pool, zones.nodeTypes);
    return type ? <ZoneReplicas index={index} pool={pool} type={type} zones={zones} locked={context.locked} /> : undefined;
  }
  if (zones.nodeTypes || zones.loading) return <NodeTypeInput index={index} pool={pool} zones={zones} />;
  // No MCE picked yet: the plain field; this deployment does not read the MCE: typed, and said so
  return zones.nodeTypes === null ? <TypedNodeType context={context} index={index} pool={pool} /> : undefined;
}

function ProblemLine({ problem, testId }: { problem: string | undefined; testId: string }) {
  if (!problem) return null;
  return (
    <p role="alert" className="text-xs text-destructive" data-testid={testId}>
      {problem}
    </p>
  );
}

/** The MCE's node types as options, each said as the convention means it: bare metal or a VM, and its zones. */
const options = (nodeTypes: readonly NodeType[]) =>
  nodeTypes.map((t) => ({ value: t.name, label: t.name, description: describeNodeType(t) }));

/** What the picked node type gives, or an older flavor's one InfraEnv with the way to spread it. */
function ZonesNote({ index, pool, zones }: { index: number; pool: Record<string, unknown>; zones: ZoneContext }) {
  const type = listedType(pool, zones.nodeTypes);
  const own = text(pool.infra_env);
  if (type) {
    const where = type.zones.map((z) => zoneLabel(z.zone)).join(", ");
    return (
      <p className="text-xs text-muted-foreground" data-testid={`nodepool-${index}-zones-note`}>
        {type.zones.length > 1 ? (
          <>
            In {plural(type.zones.length, "zone")} on this MCE ({where}): one NodePool in each, every one with this
            nodepool&apos;s configuration and its own zone on its Nodes ({ZONE_LABEL}). Set each zone&apos;s replicas below.
          </>
        ) : (
          <>In one zone on this MCE ({where}): one NodePool{type.zones[0]?.zone && parseInfraEnvName(type.zones[0].infra_env) ? `, its Nodes labelled ${ZONE_LABEL}=${type.zones[0].zone}` : ""}.</>
        )}
      </p>
    );
  }
  const whole = own ? nodeTypeFor(own, zones.nodeTypes) : null;
  if (!own) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid={`nodepool-${index}-one-zone`}>
      <span>
        Only <span className="font-mono text-foreground">{placedLabel(own)}</span>: the flavor names this one InfraEnv, so this
        nodepool is one NodePool in that zone.
      </span>
      {whole && whole.zones.length > 1 && (
        <button
          type="button"
          className="rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onClick={() => zones.setPool(index, spreadOverZones(pool, zones.nodeTypes))}
          data-testid={`nodepool-${index}-spread`}
        >
          Use every zone of {whole.name} ({whole.zones.length})
        </button>
      )}
    </p>
  );
}

/** The node type picker: the MCE's node types, each with its zones. */
function NodeTypeInput({ index, pool, zones }: { index: number; pool: Record<string, unknown>; zones: ZoneContext }) {
  const own = text(pool.infra_env);
  const picked = text(pool[NODE_TYPE]) || (own ? (nodeTypeFor(own, zones.nodeTypes)?.name ?? own) : "");
  const problem = zones.problems[index];
  return (
    <div className="min-w-0 space-y-1.5" data-testid={`nodepool-${index}-node-type`}>
      <Combobox
        size="lg"
        options={options(zones.nodeTypes ?? [])}
        value={picked || null}
        onValueChange={(name) => zones.setPool(index, chooseNodeType(pool, name, zones.nodeTypes))}
        disabled={zones.loading}
        placeholder={zones.loading ? "Loading node types…" : "Select a node type…"}
        searchPlaceholder="Search node types…"
        emptyMessage="No node type matches."
        aria-label="Node type"
        aria-invalid={problem !== undefined && /node type/.test(problem)}
        data-testid={`infra-env-select-nodepools[${index}].infra_env`}
      />
      <ZonesNote index={index} pool={pool} zones={zones} />
      <ProblemLine problem={problem && /node type/.test(problem) ? problem : undefined} testId={`nodepool-${index}-node-type-problem`} />
    </div>
  );
}

/** Without the MCE's list: the node type and its zone typed as one name, one NodePool (the old field). */
function TypedNodeType({ context, index, pool }: { context: FieldInputContext; index: number; pool: Record<string, unknown> }) {
  const preset = text(pool[NODE_TYPE]);
  return (
    <div className="min-w-0 space-y-1">
      <input
        type="text"
        className={cn(fieldInputClassName, "font-mono")}
        value={typeof context.value === "string" ? context.value : ""}
        placeholder={preset ? `e.g. ${preset}-az1` : `e.g. ${context.field.example ?? "r760-mtl-az1"}`}
        aria-label={`Nodepool ${index + 1} node type and zone`}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => context.onChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground" data-testid={`nodepool-${index}-typed-node-type`}>
        {preset ? (
          <>
            The flavor&apos;s node type is <span className="font-mono">{preset}</span>: type one of its zones as one name.{" "}
          </>
        ) : null}
        Without the MCE&apos;s list this nodepool is one NodePool, in the zone you type.
      </p>
    </div>
  );
}

/** One replicas input per zone, each zone's NodePool named under it; read-only under a ratio or a lock. */
function ZoneReplicas({ index, pool, type, zones, locked }: {
  index: number; pool: Record<string, unknown>; type: NodeType; zones: ZoneContext; locked: boolean;
}) {
  const why = zones.fixed(index) ?? (locked ? "locked by the flavor" : null);
  const counts = zoneCounts(pool, type.zones, why !== null);
  const suffix = text(pool[SUFFIX_INPUT]);
  const total = counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  const problem = zones.problems[index];
  return (
    <div className="space-y-2" role="group" aria-label={`Nodepool ${index + 1} replicas per zone`} data-testid={`nodepool-${index}-zones`}>
      <ul className="divide-y rounded-lg border">
        {type.zones.map((zone) => {
          const value = zoneValue(pool, zone.infra_env, why !== null);
          return (
            <li key={zone.infra_env} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid={`nodepool-${index}-zone-${zone.infra_env}`}>
              <span className="w-16 shrink-0 font-mono text-sm font-medium">{zoneLabel(zone.zone)}</span>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                readOnly={why !== null}
                className={cn(fieldInputClassName, "w-24 font-mono tabular-nums", why !== null && "bg-muted/30 text-muted-foreground")}
                value={value === undefined || value === null ? "" : String(value)}
                aria-label={`Nodepool ${index + 1} replicas in ${zoneLabel(zone.zone)}`}
                onChange={(e) => zones.setPool(index, setZoneReplicas(pool, zone.infra_env, e.target.value === "" ? "" : Number(e.target.value)))}
              />
              <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground" title="This zone's NodePool">
                {composeName(zone.infra_env, suffix)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" data-testid={`nodepool-${index}-zones-total`}>
        <Layers className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
        {plural(total, "node")} in {plural(type.zones.length, "NodePool")}
        {why ? `; every zone the same: ${why}` : "; a zone may have 0, and keeps its NodePool"}.
      </p>
      <ProblemLine problem={problem && !/node type/.test(problem) ? problem : undefined} testId={`nodepool-${index}-zones-problem`} />
    </div>
  );
}
