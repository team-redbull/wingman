"use client";

import type { ReactNode } from "react";
import { fieldInputClassName, type FieldInputContext, type FormValues } from "@/components/clusters/dynamic-variable-form";
import { composeName, formNameProblems, isSuffixPath } from "@/lib/nodepool-names";
import { cn } from "@/lib/utils";

/** The form's nodepool at `index`, as a map; `undefined` when it has none. */
function poolAt(form: FormValues, index: number): Record<string, unknown> | undefined {
  const pools = form.nodepools;
  const pool = Array.isArray(pools) ? pools[index] : undefined;
  return pool && typeof pool === "object" && !Array.isArray(pool) ? (pool as Record<string, unknown>) : undefined;
}

/**
 * The create form's NodePool name (ADR-0071): the nodepool's InfraEnv (its
 * node type and zone, ADR-0072), fixed, then the suffix a person may add, and
 * the whole name under it. The suffix lets several nodepools draw from one
 * node type in one zone; a clash, a bad suffix or a
 * name over 63 characters shows here before day1 is asked. Day1 offers the
 * input only when the specs project's template writes the name.
 * `undefined` for any other field.
 */
export function nodepoolNameInput({ path, value, onChange, locked }: FieldInputContext, form: FormValues): ReactNode | undefined {
  if (!isSuffixPath(path)) return undefined;
  const index = Number(/\[(\d+)\]/.exec(path)?.[1] ?? 0);
  const own = poolAt(form, index)?.infra_env;
  const infraEnv = typeof own === "string" ? own : "";
  const suffix = typeof value === "string" ? value : "";
  const problem = formNameProblems(form.nodepools)[index];
  const testId = `nodepool-${index}-name`;
  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-1">
        <span className="max-w-[60%] shrink-0 truncate font-mono text-sm text-muted-foreground" title={infraEnv || undefined} aria-hidden>
          {infraEnv || "<node type>-<zone>"}-
        </span>
        <input
          aria-label={`Nodepool ${index + 1} name suffix`}
          aria-invalid={problem !== undefined}
          aria-describedby={`${testId}-preview`}
          className={cn(fieldInputClassName, "min-w-0 font-mono")}
          placeholder="none"
          autoComplete="off"
          spellCheck={false}
          readOnly={locked}
          value={suffix}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`${testId}-suffix`}
        />
      </div>
      <p id={`${testId}-preview`} className="text-xs text-muted-foreground" data-testid={`${testId}-preview`}>
        NodePool{" "}
        {infraEnv ? (
          <span className="font-mono text-foreground break-all">{composeName(infraEnv, suffix)}</span>
        ) : (
          "named after its node type and zone, once they are chosen"
        )}
        : its node type and zone, then the suffix. Another nodepool of the same node type and zone needs another suffix.
      </p>
      {problem && (
        <p role="alert" className="text-xs text-destructive" data-testid={`${testId}-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
}
