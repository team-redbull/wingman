"use client";

import { FilterPills } from "@/components/clusters/list/filter-pills";
import { SearchBox } from "@/components/common/search-box";
import { cn } from "@/lib/utils";
import type { Facet, Facets, PoolFilter } from "@/lib/inventory/pool-filter";

const FACET_LABEL: Record<Facet, string> = { zone: "Zone", size: "Size" };

/** One part of the platform's names, `All` or one value; `""` is All. */
function FacetPills({ facet, facets, value, onChange }: { facet: Facet; facets: Facets; value: string | null; onChange: (next: string | null) => void }) {
  if (facets[facet].length === 0) return null;
  const pills = [{ value: "", label: "All" }, ...facets[facet].map(({ value: v, count }) => ({ value: v, label: v, count }))];
  return (
    <FilterPills
      label={FACET_LABEL[facet]}
      pills={pills}
      value={value ?? ""}
      onChange={(next) => onChange(next || null)}
      testId={`pool-${facet}`}
    />
  );
}

/**
 * The table's own filters, beside the InfraEnv picker: a search on the name;
 * the zone and size the platform's names carry (none when no name follows
 * the convention); only the pools with servers; and how many InfraEnvs show.
 */
export function PoolFilters({
  facets,
  filter,
  onChange,
  shown,
  total,
  filtering,
}: {
  facets: Facets;
  filter: PoolFilter;
  onChange: (next: PoolFilter) => void;
  /** The InfraEnvs shown, and on the MCE. */
  shown: number;
  total: number;
  filtering: boolean;
}) {
  return (
    <>
      <SearchBox
        value={filter.search}
        onChange={(search) => onChange({ ...filter, search })}
        label="Search the pools by name"
        placeholder="Search by name…"
        className="sm:w-56"
      />
      <button
        type="button"
        aria-pressed={filter.withServers}
        onClick={() => onChange({ ...filter, withServers: !filter.withServers })}
        data-testid="pool-with-servers"
        className={cn(
          "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
          filter.withServers
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
        )}
      >
        Only with servers
      </button>
      <p role="status" aria-atomic className="text-xs text-muted-foreground sm:ml-auto" data-testid="pool-count">
        {filtering ? `${shown} of ${total} InfraEnvs` : `${total} InfraEnv${total === 1 ? "" : "s"}`}
      </p>
      {(facets.zone.length > 0 || facets.size.length > 0) && (
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2">
          <FacetPills facet="zone" facets={facets} value={filter.zone} onChange={(zone) => onChange({ ...filter, zone })} />
          <FacetPills facet="size" facets={facets} value={filter.size} onChange={(size) => onChange({ ...filter, size })} />
        </div>
      )}
    </>
  );
}
