"use client";

import { useCallback, useMemo, useState } from "react";
import type { ComboboxOption } from "@/components/ui/combobox";
import { OWNER_KEYS, type OwnerKey } from "@/lib/clusters";
import { flavorDisplayState } from "@/lib/flavor-state";
import type { UpgradeFilter } from "@/lib/fleet-upgrades";
import { plural } from "@/lib/utils";
import type { ClusterStatus, DriftSummaryItem } from "@/types";
import {
  ANY_OWNER, compareOwner, countBy, filterOf, matchesSearch, NO_OWNER, OWNER_LABEL, ownerOf, type DriftFilter,
} from "./model";
import type { ListUpgrades } from "./use-list-upgrades";

type OwnerFilter = Record<OwnerKey, string | null>;

const ANY_OWNERS: OwnerFilter = { merkaz: null, anaf: null, mador: null };

/** What the clusters list's filters bar shows and sets, and which rows it lets through. */
export interface ListFilters {
  search: string;
  setSearch: (next: string) => void;
  /** Every site a row is at, in name order. */
  sites: string[];
  /** A site, or `"all"`. */
  site: string;
  setSite: (next: string) => void;
  drift: DriftFilter;
  setDrift: (next: DriftFilter) => void;
  driftCounts: Record<DriftFilter, number>;
  owner: OwnerFilter;
  setOwner: (key: OwnerKey, value: string | null) => void;
  /** Each owner filter's choices: every number the files carry, with its count, and "not set" when some lack it. */
  ownerOptions: Record<OwnerKey, ComboboxOption[]>;
  /** Some row has an owner number: the owner filters and Group show. */
  hasOwners: boolean;
  setUpgrade: (next: UpgradeFilter) => void;
  /** Whether a row is shown under every filter. */
  matches: (cluster: ClusterStatus) => boolean;
  hasActive: boolean;
  clear: () => void;
}

function useOwnerOptions(clusters: readonly ClusterStatus[]): Record<OwnerKey, ComboboxOption[]> {
  return useMemo(() => {
    const options = {} as Record<OwnerKey, ComboboxOption[]>;
    for (const key of OWNER_KEYS) {
      const counts = countBy(clusters, (c) => ownerOf(c, key));
      const numbers = [...counts.keys()].filter(Boolean).sort(compareOwner);
      const count = (n: number) => plural(n, "cluster");
      options[key] = [
        { value: ANY_OWNER, label: `Any ${key}` },
        ...numbers.map((n) => ({ value: n, label: `${OWNER_LABEL[key]} ${n}`, description: count(counts.get(n) ?? 0) })),
        ...(counts.has("") ? [{ value: NO_OWNER, label: `No ${key}`, description: count(counts.get("") ?? 0) }] : []),
      ];
    }
    return options;
  }, [clusters]);
}

/**
 * The clusters list's filters: the search, Site, Drift, Upgrades and the
 * owner numbers. `onChange` runs on every change (the page goes back to its
 * first page).
 */
export function useListFilters(
  clusters: readonly ClusterStatus[] | undefined,
  driftOf: (cluster: ClusterStatus) => DriftSummaryItem | null,
  upgrades: ListUpgrades,
  onChange: () => void
): ListFilters {
  const rows = useMemo(() => clusters ?? [], [clusters]);
  const [search, setSearch] = useState("");
  const [site, setSite] = useState<string>("all");
  const [drift, setDrift] = useState<DriftFilter>("all");
  const [owner, setOwnerFilter] = useState<OwnerFilter>(ANY_OWNERS);

  const sites = useMemo(() => [...new Set(rows.map((c) => c.site).filter(Boolean))].sort(), [rows]);
  const ownerOptions = useOwnerOptions(rows);

  const driftCounts = useMemo(() => {
    const counts: Record<DriftFilter, number> = { all: 0, in_sync: 0, update: 0, drifted: 0, unknown: 0, not_linked: 0 };
    for (const c of rows) {
      counts.all += 1;
      const d = driftOf(c);
      if (d) counts[filterOf(flavorDisplayState(d))] += 1;
    }
    return counts;
  }, [rows, driftOf]);

  const upgradeMatches = upgrades.matches;
  const matches = useCallback(
    (c: ClusterStatus) => {
      if (search.trim() && !matchesSearch(c, search.toLowerCase())) return false;
      if (site !== "all" && c.site !== site) return false;
      if (drift !== "all") {
        const d = driftOf(c);
        if (d === null || filterOf(flavorDisplayState(d)) !== drift) return false;
      }
      for (const key of OWNER_KEYS) {
        const wanted = owner[key];
        if (wanted !== null && ownerOf(c, key) !== (wanted === NO_OWNER ? "" : wanted)) return false;
      }
      return upgradeMatches(c);
    },
    [search, site, drift, owner, driftOf, upgradeMatches]
  );

  const changed = <T>(setter: (v: T) => void) => (v: T) => { setter(v); onChange(); };

  return {
    search, setSearch: changed(setSearch),
    sites, site, setSite: changed(setSite),
    drift, setDrift: changed(setDrift), driftCounts,
    owner,
    setOwner: (key, value) => {
      setOwnerFilter((prev) => ({ ...prev, [key]: value === ANY_OWNER ? null : value }));
      onChange();
    },
    ownerOptions,
    hasOwners: rows.some((c) => OWNER_KEYS.some((k) => ownerOf(c, k))),
    setUpgrade: changed(upgrades.setFilter),
    matches,
    hasActive: Boolean(search) || site !== "all" || drift !== "all" || upgrades.filter !== "all" || OWNER_KEYS.some((k) => owner[k] !== null),
    clear: () => {
      setSearch(""); setSite("all"); setDrift("all"); setOwnerFilter(ANY_OWNERS); upgrades.setFilter("all"); onChange();
    },
  };
}
