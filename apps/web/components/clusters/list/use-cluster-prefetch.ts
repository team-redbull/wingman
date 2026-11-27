"use client";

import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { day1Api, day1Keys } from "@/lib/api/day1";
import { clusterQuery } from "@/lib/clusters";
import { day2Api, day2Keys } from "@/lib/day2";
import type { CatalogEntry, ClusterStatus, DestinationCharts } from "@/types";

/** Prefetches the cluster page's data when a row is hovered (debounced, at idle time). */
export function useClusterPrefetch(): (cluster: ClusterStatus) => void {
  const queryClient = useQueryClient();
  const prefetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  return useCallback((c: ClusterStatus) => {
    if (prefetchTimeoutRef.current) clearTimeout(prefetchTimeoutRef.current);
    prefetchTimeoutRef.current = setTimeout(() => {
      // A viewer's cluster has no MCE: it is read by its name (ADR-0068)
      const where = clusterQuery(c.site, c.mce);
      const doPrefetch = () => {
        queryClient.prefetchQuery({
          queryKey: day1Keys.clusters.detail(c.name),
          queryFn: () => day1Api.clusters.detail(c.name, where),
          staleTime: 60_000,
        });
        queryClient.prefetchQuery({
          queryKey: day1Keys.clusters.drift(c.name),
          queryFn: () => day1Api.clusters.drift(c.name, where),
          staleTime: 60_000,
        });
        // The entries the cluster's charts page reads (a bare name, narrowed by its MCE)
        queryClient.prefetchQuery({
          queryKey: day2Keys.charts(c.name, c.mce ?? undefined),
          queryFn: () => api.get<DestinationCharts>(day2Api.charts(c.name, c.mce ?? undefined)),
          staleTime: 60_000,
        });
        queryClient.prefetchQuery({
          queryKey: day2Keys.catalog,
          queryFn: () => api.get<CatalogEntry[]>(day2Api.catalog),
          staleTime: 120_000,
        });
      };
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(doPrefetch);
      } else {
        setTimeout(doPrefetch, 0);
      }
    }, 150);
  }, [queryClient]);
}
