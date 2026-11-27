"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { REPO_URL, day2Api, day2Keys, problemOf } from "@/lib/day2";
import { useDebounced } from "@/hooks/use-debounced";
import type { AddonChart, AddonDetail, AddonOperator } from "@/types/day2";

/** One add-on of a team (`GET /teams/{team}/addons/{addon}`): the add-on page's read, shared by its editor. */
export function useAddonDetail(team: string, name: string, enabled = true) {
  return useQuery<AddonDetail>({
    queryKey: day2Keys.addonDetail(team, name),
    queryFn: () => api.get<AddonDetail>(day2Api.addonDetail(team, name)),
    staleTime: 30_000,
    enabled,
  });
}

/** A refusal is not retried (a service without the read answers 404 at once); anything else twice, as every read. */
function retryUnlessRefused(count: number, error: unknown): boolean {
  const status = problemOf(error).status;
  return count < 2 && !(status !== undefined && status >= 400 && status < 500);
}

/** Whether an add-on installs an OLM operator, and its settings per level with the catalog (ADR-0073). */
export function useAddonOperator(team: string, name: string, enabled = true) {
  return useQuery<AddonOperator>({
    queryKey: day2Keys.addonOperator(team, name),
    queryFn: () => api.get<AddonOperator>(day2Api.addonOperator(team, name)),
    staleTime: 30_000,
    retry: retryUnlessRefused,
    enabled,
  });
}

/**
 * The chart a New add-on form names, once its address has stopped changing
 * for half a second: its branches, and its operator if it is one. Nothing
 * is read until the address is a URL.
 */
export function useAddonChart(team: string, repourl: string, revision: string, path: string) {
  const settled = useDebounced(JSON.stringify([repourl.trim(), revision.trim(), path.trim()]), 500);
  const [url, rev, dir] = JSON.parse(settled) as [string, string, string];
  return useQuery<AddonChart>({
    queryKey: day2Keys.addonChart(team, url, rev, dir),
    queryFn: () => api.get<AddonChart>(day2Api.addonChart(team, { repourl: url, revision: rev, path: dir })),
    enabled: REPO_URL.test(url),
    staleTime: 60_000,
    retry: false,
  });
}
