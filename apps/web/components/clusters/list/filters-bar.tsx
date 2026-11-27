"use client";

import type { ReactNode } from "react";
import { Search, SearchX, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { EmptyState, NoMatches } from "@/components/common/empty-state";
import { OWNER_KEYS } from "@/lib/clusters";
import { cn } from "@/lib/utils";
import { FilterPills } from "./filter-pills";
import { DRIFT_FILTERS, OWNER_LABEL, type GroupBy } from "./model";
import { UpgradeFilterGroup } from "./upgrade-filter";
import type { ListFilters } from "./use-list-filters";
import type { ListUpgrades } from "./use-list-upgrades";

function OwnerFilters({ filters }: { filters: ListFilters }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Owner filters">
      <span className="text-xs text-muted-foreground font-medium">Owner:</span>
      {OWNER_KEYS.map((key) => (
        <Combobox
          key={key}
          size="sm"
          options={filters.ownerOptions[key]}
          value={filters.owner[key]}
          onValueChange={(v) => filters.setOwner(key, v)}
          placeholder={OWNER_LABEL[key]}
          searchPlaceholder={`Search ${key} numbers…`}
          emptyMessage={`No ${key} number matches.`}
          aria-label={`Filter by ${key}`}
          data-testid={`owner-filter-${key}`}
          className={cn(
            "w-auto min-w-24 max-w-40 text-xs",
            filters.owner[key] !== null && "border-primary text-primary"
          )}
        />
      ))}
    </div>
  );
}

/**
 * The MCE filter: a searchable list, since a fleet has dozens of MCEs, in the
 * owner filters' style. Shown only when some row has an MCE (an admin's list).
 */
function MceFilter({ filters }: { filters: ListFilters }) {
  if (!filters.mceOptions) return null;
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="MCE filters">
      <span className="text-xs text-muted-foreground font-medium">MCE:</span>
      <Combobox
        size="sm"
        options={filters.mceOptions}
        value={filters.mce}
        onValueChange={filters.setMce}
        placeholder="Any MCE"
        searchPlaceholder="Search MCEs…"
        emptyMessage="No MCE matches."
        aria-label="Filter by MCE"
        data-testid="mce-filter"
        className={cn("w-auto min-w-28 max-w-60 text-xs", filters.mce !== null && "border-primary text-primary")}
      />
    </div>
  );
}

/** No row matches: for an MCE no cluster is on, says so and offers every MCE; else the list's usual empty state. */
export function ListNoMatches({ filters }: { filters: ListFilters }) {
  if (!filters.staleMce) return <NoMatches what="clusters" onClear={filters.clear} />;
  return (
    <EmptyState
      icon={SearchX}
      title={`No clusters on ${filters.staleMce}`}
      description="No hosted cluster in the day1 repo is on this MCE: it has none yet, or the link names an MCE the repo does not have."
      action={
        <button type="button" onClick={() => filters.setMce(null)} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Show every MCE
        </button>
      }
      data-testid="clusters-stale-mce"
    />
  );
}

function GroupByPills({ groupBy, onGroupBy }: { groupBy: GroupBy; onGroupBy: (next: GroupBy) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Group by owner">
      <span className="text-xs text-muted-foreground font-medium">Group:</span>
      {(["none", ...OWNER_KEYS] as const).map((g) => (
        <button
          key={g}
          onClick={() => onGroupBy(g)}
          aria-pressed={groupBy === g}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium transition-all border",
            groupBy === g
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
          )}
        >{g === "none" ? "None" : OWNER_LABEL[g]}</button>
      ))}
    </div>
  );
}

/**
 * The clusters list's filters bar: the search, Site, MCE, Drift, Upgrades,
 * the owner numbers and Group, Clear filters, then `children` (the page size).
 */
export function FiltersBar({
  filters,
  upgrades,
  counted,
  groupBy,
  onGroupBy,
  children,
}: {
  filters: ListFilters;
  upgrades: ListUpgrades;
  /** The clusters are read: the Drift pills show their counts. */
  counted: boolean;
  groupBy: GroupBy;
  onGroupBy: (next: GroupBy) => void;
  children?: ReactNode;
}) {
  const { site, setSite } = filters;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-48 max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          placeholder="Search clusters..."
          value={filters.search}
          onChange={(e) => filters.setSearch(e.target.value)}
          className="w-full rounded-lg border bg-card pl-8 pr-4 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-shadow"
        />
      </div>

      {filters.sites.length > 0 && (
        <FilterPills
          label="Site"
          pills={["all", ...filters.sites].map((s) => ({ value: s, label: s === "all" ? "All" : s }))}
          value={site}
          onChange={(s) => setSite(site === s && s !== "all" ? "all" : s)}
        />
      )}

      <MceFilter filters={filters} />

      <FilterPills
        label="Drift"
        pills={DRIFT_FILTERS.map((f) => ({ ...f, count: f.value !== "all" && counted ? filters.driftCounts[f.value] : undefined }))}
        value={filters.drift}
        onChange={filters.setDrift}
      />

      <UpgradeFilterGroup upgrades={upgrades} onFilter={filters.setUpgrade} />

      {filters.hasOwners && <OwnerFilters filters={filters} />}
      {filters.hasOwners && <GroupByPills groupBy={groupBy} onGroupBy={onGroupBy} />}

      {filters.hasActive && (
        <button
          onClick={filters.clear}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
        >
          <X className="h-3 w-3" />
          Clear filters
        </button>
      )}

      {children}
    </div>
  );
}
