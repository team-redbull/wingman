import type { ClusterStatus } from "@/types";

/** The owner numbers a cluster file carries (§13 of the flavors v2 API note), in the file's order. */
export const OWNER_KEYS = ["merkaz", "anaf", "mador"] as const;
export type OwnerKey = (typeof OWNER_KEYS)[number];

/**
 * The cluster detail page; an admin's `site`/`mce` pin the file when a name is
 * ambiguous. A viewer's cluster has no `mce` (ADR-0068): its link is its name.
 */
export function clusterHref(c: Pick<ClusterStatus, "name" | "site" | "mce">): string {
  return `/clusters/${encodeURIComponent(c.name)}${clusterQuery(c.site, c.mce)}`;
}

/** Where a cluster is, as a list shows it: `site / mce` for an admin, the site for a viewer (ADR-0068). */
export function placeOf(c: { site: string; mce: string | null }): string {
  return c.mce ? `${c.site} / ${c.mce}` : c.site;
}

/**
 * `?site=&mce=` for the day1 cluster routes, omitting what is unknown (names
 * are unique). Only with an MCE: a viewer's cluster has none and is found by
 * its name, so a viewer's page sends neither.
 */
export function clusterQuery(site: string, mce: string | null): string {
  if (!mce) return "";
  const params = new URLSearchParams();
  if (site) params.set("site", site);
  params.set("mce", mce);
  return `?${params.toString()}`;
}

// ── The clusters list's site and MCE, kept in the URL (`?site=&mce=`) ───────

const SITE_PARAM = "site";
const MCE_PARAM = "mce";

/** The site and MCE the clusters list is filtered to; `null`: every one. */
export interface ListPlace {
  site: string | null;
  mce: string | null;
}

/** The site and MCE a URL's query names; an empty one names none. */
export function listPlaceOf(search: string): ListPlace {
  const params = new URLSearchParams(search);
  return { site: params.get(SITE_PARAM)?.trim() || null, mce: params.get(MCE_PARAM)?.trim() || null };
}

/** The URL showing `place`, every other part of `url` kept; every site or every MCE leaves no trace. */
export function withListPlace(url: { pathname: string; search: string; hash: string }, place: ListPlace): string {
  const params = new URLSearchParams(url.search);
  for (const [key, value] of [[SITE_PARAM, place.site], [MCE_PARAM, place.mce]] as const) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

/** The clusters list filtered to `place`, for the pages that link to an MCE's hosted clusters. */
export const clustersHref = (place: ListPlace): string => withListPlace({ pathname: "/clusters", search: "", hash: "" }, place);
