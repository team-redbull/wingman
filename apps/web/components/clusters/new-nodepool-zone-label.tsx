"use client";

import { Button } from "@/components/ui/button";
import type { FileName } from "@/lib/nodepool-names";
import { ownZone, ZONE_LABEL, zoneLabelProblem } from "@/lib/zone-labels";

/**
 * A NodePool the edit adds labels its Nodes with its zone (ADR-0072's third
 * 2026-11-28 amendment): day1 refuses a new NodePool of a convention InfraEnv
 * without `topology.kubernetes.io/zone` in its `nodeLabels`, or with another
 * zone. One click writes it into the file's text, as the names panel writes a
 * name. An InfraEnv off the convention names no zone: nothing is shown.
 */
export function NewNodePoolZoneLabel({ pool, onWrite }: { pool: FileName; onWrite: (zone: string) => void }) {
  const zone = ownZone(pool.infraEnv);
  if (zone === null) return null;
  const testId = `edit-nodepool-name-${pool.index}-zone`;
  const problem = zoneLabelProblem(pool.infraEnv, pool.labelledZone);
  if (problem === null) {
    return (
      <p className="text-muted-foreground" data-testid={testId}>
        Its Nodes are labelled with its zone, <span className="font-mono text-foreground">{ZONE_LABEL}: {zone}</span>
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" data-testid={testId}>
      <p role="alert" className="min-w-0 break-words text-destructive" data-testid={`${testId}-problem`}>
        {problem}
      </p>
      <Button type="button" variant="outline" size="xs" onClick={() => onWrite(zone)} data-testid={`${testId}-write`}>
        {pool.labelledZone === null ? "Add its zone label" : `Set its zone label to ${zone}`}
      </Button>
    </div>
  );
}
