"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { day1Api, day1Keys } from "@/lib/api/day1";
import type { ClusterStatus, DriftSummaryItem } from "@/types";

/**
 * Each row's drift, from the one drift summary every row shares. A linked
 * cluster the summary does not list (or a failed summary) is unknown, never
 * in sync; `null` while the summary loads.
 */
export function useListDrift(): (cluster: ClusterStatus) => DriftSummaryItem | null {
  const { data: driftSummary, isError: driftFailed } = useQuery<DriftSummaryItem[]>({
    queryKey: day1Keys.clusters.driftSummary,
    queryFn: day1Api.clusters.driftSummary,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const driftMap = useMemo(() => new Map((driftSummary ?? []).map((d) => [d.name, d])), [driftSummary]);

  return useCallback(
    (c: ClusterStatus): DriftSummaryItem | null => {
      const item = driftMap.get(c.name);
      if (item) return item;
      const row = { name: c.name, site: c.site, mce: c.mce, spec_name: c.spec_name, spec_version: c.spec_version, update: null };
      if (!c.spec_name) return { ...row, state: "not_linked", is_drifted: false, error: null };
      if (driftSummary === undefined && !driftFailed) return null; // still loading
      return { ...row, state: "unknown", is_drifted: null, error: driftFailed ? "The drift summary could not be loaded" : null };
    },
    [driftMap, driftSummary, driftFailed]
  );
}
