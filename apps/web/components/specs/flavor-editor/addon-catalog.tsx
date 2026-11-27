"use client";

import { useState } from "react";
import { ChevronRight, Package, Plus, Search } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Combobox } from "@/components/ui/combobox";
import { ProblemList } from "@/components/common/problem-list";
import { addonKey, type Available, type AvailableTeam } from "@/lib/addon-transfer";
import { chartRevisions } from "@/lib/day2";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/types";

/** Where an add-on that moves between the lists is found again (`use-addon-moves.ts`). */
export const flightOf = (addon: { team: string; name: string }) => ({ "data-flight": addonKey(addon) });

function AddonCatalogCard({ addon, onAdd }: { addon: CatalogEntry; onAdd: (version: string, button: HTMLElement) => void }) {
  // The add-on's revision (HEAD when it sets none), so a cluster inherits it without a pin
  const [selectedVersion, setSelectedVersion] = useState(addon.current_version);
  return (
    <div
      {...flightOf(addon)}
      data-testid={`addon-card-${addon.team}-${addon.name}`}
      className="rounded-xl border bg-card p-4 transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-md"
    >
      <div className="mb-3 flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/8">
          <Package className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold">{addon.name}</h4>
          <p className="text-xs text-muted-foreground">{addon.team}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Combobox
          options={chartRevisions(addon).map((v) => ({ value: v, label: v }))}
          value={selectedVersion}
          onValueChange={(v) => v && setSelectedVersion(v)}
          searchPlaceholder="Search revisions…"
          emptyMessage="No revision matches."
          aria-label={`${addon.name} revision`}
          className="min-w-0 flex-1 text-xs"
        />
        <button
          type="button"
          data-addon-add
          onClick={(e) => onAdd(selectedVersion, e.currentTarget)}
          title={`Add ${addon.name} to Selected`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 shrink-0")}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </button>
      </div>
    </div>
  );
}

/** A team's add-ons left to add, collapsible; once all are selected it says so, and has nothing to open. */
function TeamGroup({ group, onAdd }: { group: AvailableTeam; onAdd: (addon: CatalogEntry, version: string, button: HTMLElement) => void }) {
  const [open, setOpen] = useState(true);
  const added = group.added > 0 && <span className="text-xs font-normal text-muted-foreground">· {group.addons.length === 0 ? "All added" : `${group.added} added`}</span>;
  if (group.addons.length === 0) {
    return (
      <p className="flex items-center gap-2 pl-6 text-sm font-semibold text-muted-foreground" data-testid={`addon-team-${group.team}`}>
        {group.team}
        {added}
      </p>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`addon-team-${group.team}`}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md text-left">
        <ChevronRight aria-hidden className={cn("h-4 w-4 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <span className="text-sm font-semibold transition-colors group-hover:text-primary">{group.team}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular">{group.addons.length}</span>
        {added}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="grid gap-3 pl-6 pt-3 sm:grid-cols-2">
          {group.addons.map((addon) => (
            <AddonCatalogCard key={addonKey(addon)} addon={addon} onAdd={(version, button) => onAdd(addon, version, button)} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The transfer list's left side: the catalog's add-ons the flavor does not
 * have yet, by team, searched by name. An added add-on leaves this list,
 * and comes back to its place when it is removed from Selected.
 */
export function AvailableAddons({
  available,
  error,
  search,
  onSearch,
  onAdd,
}: {
  available: Available;
  error: unknown;
  search: string;
  onSearch: (search: string) => void;
  onAdd: (addon: CatalogEntry, version: string, button: HTMLElement) => void;
}) {
  const allAdded = available.teams.length > 0;
  const empty = search
    ? allAdded ? "Every add-on that matches is selected" : "No addons match your search"
    : allAdded ? "Every add-on is selected" : "No addons available";
  return (
    // Side by side, the catalog stays in view below the editor's tab bar while a long
    // selection scrolls, and its list uses the screen's height, not a fixed 500px
    <div className="min-w-0 space-y-4 lg:sticky lg:top-[4.25rem]" data-testid="addons-available">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          Available <span className="font-normal text-muted-foreground tabular" data-testid="addons-available-count">({available.count})</span>
        </h3>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="text"
            placeholder="Search..."
            aria-label="Search addons"
            data-addon-search
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            className="w-44 rounded-lg border bg-background py-1.5 pl-8 pr-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </div>
      </div>
      {error ? (
        <ProblemList error={error} title="The chart catalog could not be read" />
      ) : (
        <div className="max-h-[500px] space-y-6 overflow-y-auto overscroll-contain pr-2 lg:max-h-[calc(100dvh-13rem)]">
          {available.teams.map((group) => (
            <TeamGroup key={group.team} group={group} onAdd={onAdd} />
          ))}
          {available.count === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>}
        </div>
      )}
    </div>
  );
}
