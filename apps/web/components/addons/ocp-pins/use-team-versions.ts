"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { day2Api, day2Keys } from "@/lib/day2";
import { teamVersions, type VersionSuggestion } from "@/components/addons/ocp-pins/model";
import type { Destination } from "@/types/day2";

/** The OpenShift versions `team`'s destinations run, as a new add-on's pins are offered them. */
export function useTeamVersions(team: string, taken: readonly string[]): VersionSuggestion[] {
  const destinations = useQuery<Destination[]>({
    queryKey: day2Keys.destinations,
    queryFn: () => api.get<Destination[]>(day2Api.destinations),
    staleTime: 60_000,
  });
  return teamVersions(destinations.data ?? [], team, taken);
}
