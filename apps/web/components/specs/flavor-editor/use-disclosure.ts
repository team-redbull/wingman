"use client";

import { useState } from "react";
import { COLLAPSIBLE, isCollapsible, poolIndexOf, readCollapsed, sectionOf, writeCollapsed, type CollapsibleId, type SectionId } from "./parts";

const browserStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export interface Disclosure {
  isOpen: (id: SectionId) => boolean;
  setOpen: (id: CollapsibleId, open: boolean) => void;
  isPoolOpen: (key: number) => boolean;
  setPoolOpen: (key: number, open: boolean) => void;
  /** Open the parts and the nodepools these fields are in. */
  openAt: (paths: readonly string[]) => void;
  /** Whether a part is collapsed: the bar then offers Expand all, else Collapse all. */
  anyCollapsed: boolean;
  /** Collapse every part, or open every part and every nodepool. */
  setAll: (open: boolean) => void;
}

/**
 * Which of the editor's parts and nodepools are open. Everything starts
 * open and a new nodepool opens; on an existing flavor the parts collapsed
 * when it was last edited in this browser start collapsed (`flavor`; none
 * for a new one). The editor renders only in the browser, after its reads,
 * so the stored choice is there for its first render.
 */
export function useDisclosure(flavor: string | null, keys: readonly number[]): Disclosure {
  const [collapsed, setCollapsed] = useState<readonly CollapsibleId[]>(() => (flavor ? readCollapsed(browserStorage(), flavor) : []));
  // Closed nodepools by their key, so a nodepool keeps its state when another is removed
  const [closedPools, setClosedPools] = useState<ReadonlySet<number>>(() => new Set());

  const remember = (next: readonly CollapsibleId[]) => {
    setCollapsed(next);
    if (flavor) writeCollapsed(browserStorage(), flavor, next);
  };
  const withPools = (change: (pools: Set<number>) => void) => {
    const next = new Set(closedPools);
    change(next);
    setClosedPools(next);
  };

  return {
    isOpen: (id) => !isCollapsible(id) || !collapsed.includes(id),
    setOpen: (id, open) => remember(open ? collapsed.filter((c) => c !== id) : [...collapsed.filter((c) => c !== id), id]),
    isPoolOpen: (key) => !closedPools.has(key),
    setPoolOpen: (key, open) => withPools((pools) => (open ? pools.delete(key) : pools.add(key))),
    openAt: (paths) => {
      const sections = new Set(paths.map(sectionOf));
      if (collapsed.some((c) => sections.has(c))) remember(collapsed.filter((c) => !sections.has(c)));
      const pools = paths.map(poolIndexOf).flatMap((i) => (i !== null && keys[i] !== undefined ? [keys[i]] : []));
      if (pools.some((k) => closedPools.has(k))) withPools((closed) => pools.forEach((k) => closed.delete(k)));
    },
    anyCollapsed: collapsed.length > 0,
    setAll: (open) => {
      remember(open ? [] : COLLAPSIBLE);
      if (open) setClosedPools(new Set());
    },
  };
}
