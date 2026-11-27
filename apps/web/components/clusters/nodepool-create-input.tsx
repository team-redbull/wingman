"use client";

import type { ReactNode } from "react";
import type { FieldInputContext, FormValues } from "@/components/clusters/dynamic-variable-form";
import { infraEnvsOf } from "@/lib/node-types";
import { isPolicyPath } from "@/lib/nodepool-policy";
import type { NodeType } from "@/types";
import { infraEnvsCreateInput } from "./infra-envs-create-input";
import { nodepoolNameInput } from "./nodepool-name-input";
import { PolicySelect } from "./policy-select";

/**
 * The create form's nodepool inputs that have a control of their own: its
 * NodePool name's suffix (ADR-0071), the InfraEnvs a nodepool also draws from
 * (ADR-0064) and its scale-down policy (ADR-0062), a select whose platform
 * default sends nothing. Each shows only when day1's template schema offers
 * it; `undefined` for any other field. `nodeTypes` are the MCE's (ADR-0072):
 * a nodepool spread over zones is named in each.
 */
export function nodepoolCreateInput(
  context: FieldInputContext,
  form: FormValues,
  nodeTypes: NodeType[] | null | undefined,
  loading: boolean
): ReactNode | undefined {
  const name = nodepoolNameInput(context, form, nodeTypes);
  if (name !== undefined) return name;
  const infraEnvs = nodeTypes ? infraEnvsOf(nodeTypes) : nodeTypes;
  if (!isPolicyPath(context.path)) return infraEnvsCreateInput(context, form, infraEnvs, loading);
  const index = Number(/\[(\d+)\]/.exec(context.path)?.[1] ?? 0);
  return (
    <PolicySelect
      value={context.value}
      onChange={(policy) => context.onChange(policy ?? "")}
      readOnly={context.locked}
      label={`Nodepool ${index + 1} scale-down policy`}
      testId={`nodepool-${index}-scale-down-policy`}
    />
  );
}
