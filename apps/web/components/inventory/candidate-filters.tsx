"use client";

import { FilterPills } from "@/components/clusters/list/filter-pills";
import { SearchBox } from "@/components/common/search-box";
import { buttonVariants } from "@/components/ui/button";
import {
  addableCount, hiddenChosen, withShown, type CandidateFacets, type CandidateFilter,
} from "@/lib/inventory/candidate-filter";
import { MAX_SERVERS } from "@/lib/inventory/start";
import { cn } from "@/lib/utils";
import type { Candidate } from "@/types/inventory";

/** A facet's pills, `All` first; none when the list holds one value only. */
function Facet({
  label,
  facets,
  value,
  onChange,
  testId,
}: {
  label: string;
  facets: CandidateFacets["groups"] | CandidateFacets["hardware"];
  value: string;
  onChange: (next: string) => void;
  testId: string;
}) {
  if (facets.length < 2) return null;
  const pills = [{ value: "", label: "All" }, ...facets.map(({ value: v, label: l, count }) => ({ value: v, label: l, count }))];
  return <FilterPills label={label} pills={pills} value={value} onChange={onChange} testId={testId} />;
}

/**
 * The picker's filters, above the list: a search on the name, the hardware
 * and why a server is held back; the chosen servers only; the group and the
 * hardware when the pool holds more than one; and how many show.
 */
export function CandidateFilterBar({
  facets,
  filter,
  onChange,
  shown,
  total,
  filtering,
}: {
  facets: CandidateFacets;
  filter: CandidateFilter;
  onChange: (next: CandidateFilter) => void;
  shown: number;
  total: number;
  filtering: boolean;
}) {
  return (
    <div className="grid gap-2" data-testid="candidate-filters">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={filter.search}
          onChange={(search) => onChange({ ...filter, search })}
          label="Search the servers"
          placeholder="Search name, hardware or problem…"
          className="sm:max-w-xs sm:flex-1"
          testId="candidate-search"
        />
        <button
          type="button"
          aria-pressed={filter.chosenOnly}
          onClick={() => onChange({ ...filter, chosenOnly: !filter.chosenOnly })}
          data-testid="candidate-chosen-only"
          className={cn(
            "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
            filter.chosenOnly
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
          )}
        >
          Chosen only
        </button>
        <p role="status" aria-atomic className="text-xs text-muted-foreground sm:ml-auto" data-testid="candidate-count">
          {filtering ? `${shown} of ${total} servers` : `${total} server${total === 1 ? "" : "s"}`}
        </p>
      </div>
      {(facets.groups.length > 1 || facets.hardware.length > 1) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Facet
            label="Status"
            facets={facets.groups}
            value={filter.group}
            onChange={(group) => onChange({ ...filter, group: group as CandidateFilter["group"] })}
            testId="candidate-group-filter"
          />
          <Facet
            label="Hardware"
            facets={facets.hardware}
            value={filter.hardware}
            onChange={(hardware) => onChange({ ...filter, hardware })}
            testId="candidate-hardware"
          />
        </div>
      )}
    </div>
  );
}

const ACTION = buttonVariants({ variant: "outline", size: "sm" });

/**
 * Under the list: the chosen servers the filters hide, picking every server
 * shown that can be picked (up to the most one install takes), and unpicking
 * them all.
 */
export function PickShown({
  chosen,
  shown,
  onSelected,
}: {
  chosen: string[];
  shown: readonly Candidate[];
  onSelected: (names: string[]) => void;
}) {
  const adds = addableCount(chosen, shown, MAX_SERVERS);
  const pickable = shown.filter((c) => c.offered && !chosen.includes(c.name)).length;
  const hidden = hiddenChosen(chosen, shown);
  const pickLabel = adds === 0 ? "Pick the shown" : adds < pickable ? `Pick the first ${adds} shown` : `Pick the ${adds} shown`;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="candidate-actions">
      {hidden > 0 && (
        <p className="mr-auto text-xs text-muted-foreground" data-testid="candidate-hidden-chosen">
          {hidden} chosen {hidden === 1 ? "server is" : "servers are"} hidden by the filters
        </p>
      )}
      <button type="button" className={ACTION} disabled={adds === 0} onClick={() => onSelected(withShown(chosen, shown, MAX_SERVERS))}>
        {pickLabel}
      </button>
      <button type="button" className={ACTION} disabled={chosen.length === 0} onClick={() => onSelected([])}>
        Unpick all
      </button>
    </div>
  );
}
