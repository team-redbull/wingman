/**
 * The install dialog's server picker, when a pool has many free servers
 * (ADR-0057's 2026-11-25 amendment): a search, the group (ready, needs a fix,
 * not offered), the hardware, and the chosen ones only; then picking every
 * server shown at once. Pure: the servers and their groups are day1's,
 * nothing is recounted here.
 */

import type { Candidate } from "@/types/inventory";
import { hardwareLabel } from "./pools";
import { CANDIDATE_GROUPS, candidateGroup, type CandidateGroup } from "./waiver";

export interface CandidateFilter {
  /** Words that must each appear in the name, the hardware, or why a server needs a fix or is not offered. */
  search: string;
  /** `""`: every group. */
  group: CandidateGroup | "";
  /** A `hardwareLabel`; `""`: any hardware. */
  hardware: string;
  /** Only the servers chosen so far. */
  chosenOnly: boolean;
}

export const NO_CANDIDATE_FILTER: CandidateFilter = { search: "", group: "", hardware: "", chosenOnly: false };

export const isFiltering = (filter: CandidateFilter): boolean =>
  filter.search.trim() !== "" || filter.group !== "" || filter.hardware !== "" || filter.chosenOnly;

export interface FacetCount<V extends string> {
  value: V;
  label: string;
  count: number;
}

export interface CandidateFacets {
  /** The groups the list holds, in the list's order. */
  groups: FacetCount<CandidateGroup>[];
  /** The hardware the list holds, most servers first. */
  hardware: FacetCount<string>[];
}

/** Each group and each hardware the servers hold, with how many. */
export function candidateFacets(candidates: readonly Candidate[]): CandidateFacets {
  const groups = CANDIDATE_GROUPS.map((info) => ({
    value: info.group,
    label: info.label,
    count: candidates.filter((c) => candidateGroup(c) === info.group).length,
  })).filter((facet) => facet.count > 0);
  const byHardware = new Map<string, number>();
  for (const c of candidates) byHardware.set(hardwareLabel(c), (byHardware.get(hardwareLabel(c)) ?? 0) + 1);
  const hardware = [...byHardware]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { groups, hardware };
}

function matches(candidate: Candidate, terms: readonly string[]): boolean {
  const text = [candidate.name, hardwareLabel(candidate), ...candidate.health_problems, candidate.why_not ?? ""]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** The servers `filter` keeps, in day1's order; `chosen` are the names picked so far. */
export function filterCandidates(
  candidates: readonly Candidate[],
  filter: CandidateFilter,
  chosen: readonly string[]
): Candidate[] {
  const terms = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
  return candidates.filter(
    (c) =>
      (filter.group === "" || candidateGroup(c) === filter.group) &&
      (filter.hardware === "" || hardwareLabel(c) === filter.hardware) &&
      (!filter.chosenOnly || chosen.includes(c.name)) &&
      matches(c, terms)
  );
}

/** The shown servers that can be picked and are not yet, at most as many as `max` leaves room for. */
function addableNames(chosen: readonly string[], shown: readonly Candidate[], max: number): string[] {
  const room = Math.max(0, max - chosen.length);
  return shown.filter((c) => c.offered && !chosen.includes(c.name)).map((c) => c.name).slice(0, room);
}

/** How many servers picking the shown ones adds. */
export const addableCount = (chosen: readonly string[], shown: readonly Candidate[], max: number): number =>
  addableNames(chosen, shown, max).length;

/** The chosen names, then the shown servers that can be picked, up to `max` in all. */
export const withShown = (chosen: readonly string[], shown: readonly Candidate[], max: number): string[] => [
  ...chosen,
  ...addableNames(chosen, shown, max),
];

/** How many chosen servers the filters hide. */
export const hiddenChosen = (chosen: readonly string[], shown: readonly Candidate[]): number =>
  chosen.filter((name) => !shown.some((c) => c.name === name)).length;
