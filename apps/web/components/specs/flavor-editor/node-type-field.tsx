"use client";

import { Button } from "@/components/ui/button";
import { nodeTypeOf, placedLabel } from "@/lib/node-types";
import { cn } from "@/lib/utils";
import { inputCls, ValueField } from "./controls";
import { nodepoolPath, nodepoolValues, setNodepoolValue, type FlavorDraft } from "./model";

type Update = (change: (draft: FlavorDraft) => FlavorDraft) => void;

const NODE_TYPE = "node_type";
const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Why a typed node type cannot be preset; `null` when it can (or is none). Day1 checks it again at save. */
function nodeTypeProblem(value: string): string | null {
  if (!value) return null;
  if (!LABEL.test(value) || value.length > 63) return "Lowercase letters, digits and '-', like r760-mtl";
  const own = nodeTypeOf(value);
  return own !== value ? `${value} is an InfraEnv, node type ${own} in one zone: preset ${own}` : null;
}

/**
 * A flavor nodepool's node type (ADR-0072): a preset, the kind of server
 * (`r760-mtl`), never a zone. A cluster of the flavor gets a NodePool of it in
 * every zone its MCE has it in, each with this nodepool's configuration, and
 * sets each zone's replicas (they start at this nodepool's). A flavor saved
 * with an InfraEnv instead (one zone) offers to preset that InfraEnv's node type.
 */
export function NodeTypeField({ index, draft, update, problems }: {
  index: number;
  draft: FlavorDraft;
  update: Update;
  problems: (path: string, options?: { deeper?: boolean }) => string[];
}) {
  const pool = nodepoolValues(draft, index);
  const path = nodepoolPath(index, NODE_TYPE);
  const value = typeof pool[NODE_TYPE] === "string" ? (pool[NODE_TYPE] as string) : "";
  const older = typeof pool.infra_env === "string" && pool.infra_env ? pool.infra_env : null;
  const own = nodeTypeProblem(value.trim());
  const set = (next: string | undefined) => update((d) => setNodepoolValue(d, index, NODE_TYPE, next));
  const presetType = (name: string) => update((d) => setNodepoolValue(setNodepoolValue(d, index, "infra_env", undefined), index, NODE_TYPE, name));
  return (
    <ValueField
      path={path}
      label="Node type"
      empty={value === ""}
      problems={[...problems(path, { deeper: true }), ...(own ? [own] : [])]}
      hint="A preset: each cluster gets one NodePool of it in every zone its MCE has, all with this nodepool's configuration, and sets each zone's replicas (they start at this nodepool's). A cluster may pick another."
      className="max-w-md"
    >
      {({ inputId, describedBy, invalid }) => (
        <div className="space-y-1.5">
          <input
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            className={cn(inputCls, "w-56 font-mono")}
            placeholder={older ? nodeTypeOf(older) : "e.g. r760-mtl"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => set(e.target.value.trim() === "" ? undefined : e.target.value)}
            data-testid={`nodepool-${index}-node-type`}
          />
          {older && !value && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid={`nodepool-${index}-older-infra-env`}>
              <span>
                Presets one InfraEnv, <span className="font-mono">{placedLabel(older)}</span>: a cluster gets one NodePool, in that zone.
              </span>
              <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => presetType(nodeTypeOf(older))}>
                Preset node type {nodeTypeOf(older)} instead
              </Button>
            </p>
          )}
        </div>
      )}
    </ValueField>
  );
}
