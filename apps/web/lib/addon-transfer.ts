/**
 * The flavor editor's add-ons transfer list: what is left to add once some
 * are selected. A selected add-on is not offered again; removing it puts it
 * back where the catalog has it, since Available is always the catalog in
 * its own order minus the selection, never a list that is edited.
 */

import type { CatalogEntry } from "@/types";

interface AddonRef {
  team: string;
  name: string;
}

export const addonKey = (addon: AddonRef) => `${addon.team}/${addon.name}`;

export interface AvailableTeam {
  team: string;
  /** The team's add-ons the search matches and the flavor does not have yet, in the catalog's order. */
  addons: CatalogEntry[];
  /** How many add-ons of the team the search matches are selected already. */
  added: number;
}

export interface Available {
  /** Every team with an add-on the search matches, by name; a team whose matches are all selected has none left. */
  teams: AvailableTeam[];
  /** The add-ons left to add, over every team. */
  count: number;
}

/** The catalog minus `selected`, by team, narrowed to a search on the add-on's or the team's name. */
export function availableAddons(catalog: readonly CatalogEntry[], selected: readonly AddonRef[], search = ""): Available {
  const query = search.trim().toLowerCase();
  const chosen = new Set(selected.map(addonKey));
  const byTeam = new Map<string, AvailableTeam>();
  for (const addon of catalog) {
    if (query && !addon.name.toLowerCase().includes(query) && !addon.team.toLowerCase().includes(query)) continue;
    let team = byTeam.get(addon.team);
    if (!team) byTeam.set(addon.team, (team = { team: addon.team, addons: [], added: 0 }));
    if (chosen.has(addonKey(addon))) team.added++;
    else team.addons.push(addon);
  }
  const teams = [...byTeam.values()].sort((a, b) => a.team.localeCompare(b.team));
  return { teams, count: teams.reduce((sum, t) => sum + t.addons.length, 0) };
}
