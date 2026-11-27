/**
 * The create form's node types (ADR-0072): the MCE's, read from day1, and
 * the rules that size each nodepool's zones. The MCE is the one placement
 * picked on the last render, since placement asks for the servers the
 * nodepools' zones need: the picked MCE has every zone the last needs named,
 * so the needs only grow with a new pick and settle.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { isApiError } from "@/lib/api-client";
import { day1Api, day1Keys } from "@/lib/api/day1";
import type { NodeType } from "@/types";
import type { FlavorLocks } from "./flavor-form";

/** The MCE's node types; `null` when this deployment does not read the MCE (then they are typed). */
export function useNodeTypes(mce: string, enabled: boolean) {
  return useQuery<NodeType[] | null>({
    queryKey: day1Keys.fleet.nodeTypes(mce),
    queryFn: async () => {
      try {
        return await day1Api.fleet.nodeTypes(mce);
      } catch (error) {
        if (isApiError(error, "FEATURE_DISABLED")) return null;
        throw error;
      }
    },
    enabled: Boolean(mce) && enabled,
    // Another pick keeps the last MCE's while it loads: the needs do not drop out and come back
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
}

export interface ZoneRules {
  /** The flavor locks the nodepool's replicas: every zone has them, and they are sent. */
  locked: (index: number) => boolean;
  /** Every zone has the nodepool's replicas (a ratio or a lock). */
  fixed: (index: number) => boolean;
  /** Why every zone has the nodepool's replicas; `null` when each zone is set apart. */
  why: (index: number) => string | null;
}

/** How each nodepool's zones are sized: a ratio sizes every zone of a sized nodepool, a lock fixes them. */
export function zoneRules(ratio: readonly number[], size: number | null, locks: FlavorLocks): ZoneRules {
  const locked = (i: number) => locks.values.has(`nodepools[${i}].replicas`);
  const why = (i: number) =>
    i < ratio.length ? `ratio ${ratio[i]} × size ${size ?? "?"}` : locked(i) ? "locked by the flavor" : null;
  return { locked, why, fixed: (i: number) => why(i) !== null };
}
