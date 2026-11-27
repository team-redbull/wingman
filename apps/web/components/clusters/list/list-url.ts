"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { listPlaceOf, withListPlace, type ListPlace } from "@/lib/clusters";

/*
 * The clusters list's filters kept in the URL: the site and MCE
 * (`?site=&mce=`) and the Upgrades filter (`?upgrade=`, use-list-upgrades).
 * Back from a cluster returns to the filtered list, and a link can be shared.
 * A change replaces the history entry, as the Segments page's filters do.
 * Read without `useSearchParams`, so the page needs no Suspense boundary.
 */

/** Whoever reads the URL, told when it is set here: `replaceState` fires no event. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** The URL's query (`window.location.search`); empty on the server. */
export function useListSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search, () => "");
}

/** Puts `href` in place of the current history entry, and tells every reader. */
export function replaceListUrl(href: string): void {
  window.history.replaceState(null, "", href);
  listeners.forEach((listener) => listener());
}

/** The site and MCE the list is filtered to, from the URL, and their setter. */
export function useListPlace(): [ListPlace, (next: ListPlace) => void] {
  const search = useListSearch();
  const place = useMemo(() => listPlaceOf(search), [search]);
  const setPlace = useCallback((next: ListPlace) => replaceListUrl(withListPlace(window.location, next)), []);
  return [place, setPlace];
}
