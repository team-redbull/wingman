"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Lock, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClassName } from "@/components/clusters/dynamic-variable-form";
import {
  composeName,
  fileNames,
  followsRule,
  nameProblem,
  removedNames,
  suffixProblem,
  withName,
  type FileName,
} from "@/lib/nodepool-names";
import { cn } from "@/lib/utils";

/** An existing NodePool: its name, kept as it is. */
function ExistingRow({ pool }: { pool: FileName }) {
  const older = pool.infraEnv !== null && pool.rendered !== null && !followsRule(pool.rendered, pool.infraEnv);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs" data-testid={`edit-nodepool-name-${pool.index}`} data-existing="">
      <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="font-mono font-medium text-foreground break-all" data-testid={`edit-nodepool-name-${pool.index}-value`}>
        {pool.rendered ?? `nodepool[${pool.index}]`}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {pool.name ? "kept" : "derived by the chart, kept"}: renaming it would replace every node
      </span>
      {older && (
        <span className="rounded-full border px-1.5 text-[10px] text-muted-foreground" title="Named before the node type and zone rule (ADR-0071); Wingman never renames it">
          older name
        </span>
      )}
    </li>
  );
}

/** Why an added nodepool's name is not yet one day1 takes; `null` when it is. */
function addedProblem(pool: FileName, twice: boolean): string | null {
  if (pool.infraEnv === null) return null; // draws from no node type: the file names it
  if (pool.name === null) return `A new NodePool is named ${pool.infraEnv} or ${pool.infraEnv}-<suffix>: name it`;
  if (!followsRule(pool.name, pool.infraEnv)) return `“${pool.name}” is not ${pool.infraEnv} or ${pool.infraEnv}-<suffix>`;
  return nameProblem(pool.name) ?? (twice ? "Another nodepool has this name: give it another suffix" : null);
}

/** A nodepool the edit adds: its InfraEnv, then a suffix written into the file as its `name`. */
function AddedRow({ pool, twice, onName }: { pool: FileName; twice: boolean; onName: (name: string) => void }) {
  const infraEnv = pool.infraEnv;
  const written = infraEnv && pool.name && followsRule(pool.name, infraEnv) ? pool.name.slice(infraEnv.length + 1) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const suffix = draft ?? written;
  const problem = (draft !== null ? suffixProblem(draft) : null) ?? addedProblem(pool, twice);
  const testId = `edit-nodepool-name-${pool.index}`;
  if (infraEnv === null) {
    return (
      <li className="px-3 py-2 text-xs" data-testid={testId}>
        <span className="font-mono">{pool.rendered ?? `nodepool[${pool.index}]`}</span>{" "}
        <span className="text-muted-foreground">· new; it draws from no node type, so the file names it</span>
      </li>
    );
  }
  return (
    <li className="space-y-1 px-3 py-2 text-xs" data-testid={testId} data-added="">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">new</span>
        <span className="max-w-[50%] truncate font-mono text-muted-foreground" title={infraEnv} aria-hidden>
          {infraEnv}-
        </span>
        <input
          aria-label={`Nodepool ${pool.index + 1} name suffix`}
          aria-invalid={problem !== null}
          className={cn(fieldInputClassName, "h-7 w-40 py-0 font-mono text-xs")}
          placeholder="none"
          spellCheck={false}
          autoComplete="off"
          value={suffix}
          onChange={(e) => {
            setDraft(e.target.value);
            if (suffixProblem(e.target.value) === null) onName(composeName(infraEnv, e.target.value));
          }}
          data-testid={`${testId}-suffix`}
        />
        {pool.name === null && draft === null && (
          <Button type="button" variant="outline" size="xs" onClick={() => onName(infraEnv)} data-testid={`${testId}-write`}>
            Name it {infraEnv}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground" data-testid={`${testId}-preview`}>
        NodePool <span className="font-mono text-foreground break-all">{pool.name ?? composeName(infraEnv, suffix)}</span>
        {pool.name === null && " once named"}
      </p>
      {problem && (
        <p role="alert" className="text-destructive" data-testid={`${testId}-problem`}>
          {problem}
        </p>
      )}
    </li>
  );
}

/**
 * Each NodePool of the file while it is edited (ADR-0071): an existing one by
 * its name, derived (`<clusterName>-<infraEnvName>`) or written, read-only
 * (renaming one would replace every node; one that does not follow the rule
 * is marked, never renamed); one the edit adds is named `<InfraEnv>` or
 * `<InfraEnv>-<suffix>` from a suffix written as its `name`, every other line
 * kept. One the edit removes is named: merging deletes it and its nodes.
 */
export function NodePoolNamesPanel({ text, base, clusterName, onChange }: {
  text: string;
  /** The file when the edit began. */
  base: string;
  /** The chart's `clusterName`, which derives an unnamed NodePool's name. */
  clusterName: string;
  onChange: (text: string) => void;
}) {
  const names = useMemo(() => fileNames(text, base, clusterName), [text, base, clusterName]);
  const removed = useMemo(() => removedNames(text, base, clusterName), [text, base, clusterName]);
  const [refused, setRefused] = useState<number | null>(null);
  if (!names || names.length === 0) return null;
  const counts = new Map<string, number>();
  for (const n of names) if (n.rendered) counts.set(n.rendered, (counts.get(n.rendered) ?? 0) + 1);
  const write = (index: number, name: string) => {
    const edited = withName(text, index, name);
    setRefused(edited === null ? index : null);
    if (edited !== null) onChange(edited);
  };
  return (
    <section className="border-b border-zinc-800 bg-card text-card-foreground" aria-label="NodePool names" data-testid="edit-nodepool-names">
      <p className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 text-xs font-medium">
        <Tag className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        NodePool names
        <span className="font-normal text-muted-foreground">· existing ones keep theirs; a new one is &lt;node type&gt;-&lt;zone&gt;[-&lt;suffix&gt;]</span>
      </p>
      <ul className="divide-y divide-border">
        {names.map((pool) =>
          pool.existing ? (
            <ExistingRow key={pool.index} pool={pool} />
          ) : (
            <AddedRow key={pool.index} pool={pool} twice={(counts.get(pool.rendered ?? "") ?? 0) > 1} onName={(name) => write(pool.index, name)} />
          )
        )}
      </ul>
      {removed.length > 0 && (
        <p role="status" className="flex items-start gap-1.5 px-3 pb-2 text-xs text-status-warning-fg" data-testid="edit-nodepool-names-removed">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Merging deletes {removed.map((n) => `NodePool ${n}`).join(", ")} and its nodes.
        </p>
      )}
      {refused !== null && (
        <p role="alert" className="flex items-start gap-1.5 px-3 pb-2.5 text-xs text-status-warning-fg" data-testid="edit-nodepool-names-refused">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          This nodepool&apos;s lines are not in a layout this can edit: write its name in the file below.
        </p>
      )}
    </section>
  );
}
