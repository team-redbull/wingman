/**
 * The flavor editor's parts: which part (and which nodepool) a field is in,
 * the one line a collapsed part or nodepool shows, its problem count, and
 * the parts a viewer collapsed on a flavor, remembered in their browser.
 */

import { hardwareOf, nodepoolCount, nodepoolValues, poolConfigs, ratioLabel, type FlavorDraft } from "./model";

export const SECTIONS = [
  { id: "basics", title: "Basics", description: "What the flavor is, and the owner, platform and image mirrors of its clusters." },
  { id: "nodepools", title: "Nodepools", description: "The nodepools a cluster starts with, their machine configs and tuning profiles." },
  { id: "addons", title: "Add-ons", description: "The day2 charts every cluster of the flavor gets, in install order." },
  { id: "review", title: "Review", description: "What every cluster gets, the flavor file, and the cluster file it gives." },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

/** The parts that collapse; Review stays open, since it is what a save sends. */
export type CollapsibleId = Exclude<SectionId, "review">;
export const COLLAPSIBLE: readonly CollapsibleId[] = ["basics", "nodepools", "addons"];
export const isCollapsible = (id: SectionId): id is CollapsibleId => id !== "review";

/** The part a field's path is in: a nodepool's or the every-nodepool rule's, else Basics. */
export const sectionOf = (path: string): SectionId => (path.startsWith("nodepools") ? "nodepools" : "basics");

/** The nodepool a field's path is in (`nodepools[2].replicas` is 2), if one. */
export function poolIndexOf(path: string): number | null {
  const match = /^nodepools\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : null;
}

/** The problems by part and by nodepool, from the paths of the fields they are at. */
export function problemCounts(paths: readonly string[]): { sections: Record<SectionId, number>; pools: Record<number, number> } {
  const sections: Record<SectionId, number> = { basics: 0, nodepools: 0, addons: 0, review: 0 };
  const pools: Record<number, number> = {};
  for (const path of paths) {
    sections[sectionOf(path)]++;
    const pool = poolIndexOf(path);
    if (pool !== null) pools[pool] = (pools[pool] ?? 0) + 1;
  }
  return { sections, pools };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PLATFORM_LABELS: Record<string, string> = { agent: "Agent", kubevirt: "KubeVirt" };

/** Basics in one line: the name, the version and the platform. */
export function basicsSummary(draft: FlavorDraft): string {
  const platform = typeof draft.values.platform === "string" ? draft.values.platform : "";
  return [
    draft.name.trim() || "No name yet",
    draft.version.trim() ? `v${draft.version.trim()}` : "no version",
    ...(platform ? [PLATFORM_LABELS[platform] ?? platform] : []),
  ].join(" · ");
}

const replicasOf = (draft: FlavorDraft, index: number): number | null => {
  const replicas = nodepoolValues(draft, index).replicas;
  if (typeof replicas === "number") return replicas;
  return typeof replicas === "string" && /^\d+$/.test(replicas.trim()) ? Number(replicas) : null;
};

/** Nodepools in one line: how many, their replicas together, and the ratio they grow by. */
export function nodepoolsSummary(draft: FlavorDraft): string {
  const count = nodepoolCount(draft);
  if (count === 0) return "No nodepools: each cluster adds its own";
  const replicas = Array.from({ length: count }, (_, i) => replicasOf(draft, i));
  const set = replicas.filter((r): r is number => r !== null);
  const parts = [plural(count, "nodepool")];
  if (set.length > 0) parts.push(plural(set.reduce((sum, r) => sum + r, 0), "replica"));
  if (set.length < count) parts.push(set.length === 0 ? "replicas not set" : `${count - set.length} not set`);
  if (draft.ratio.length > 0) parts.push(`ratio ${ratioLabel(draft)}`);
  return parts.join(" · ");
}

/** One nodepool in one line: the InfraEnv (else the network hardware) it is preset to, its replicas, its machine configs. */
export function nodepoolSummary(draft: FlavorDraft, index: number): string {
  const pool = nodepoolValues(draft, index);
  const entries = poolConfigs(draft, index);
  const source = typeof pool.infra_env === "string" && pool.infra_env.trim() ? pool.infra_env.trim() : hardwareOf(entries);
  const replicas = replicasOf(draft, index);
  return [
    ...(source ? [source] : []),
    replicas === null ? "replicas not set" : plural(replicas, "replica"),
    entries.length === 0 ? "no machine configs" : plural(entries.length, "machine config"),
  ].join(" · ");
}

/** Add-ons in one line: how many, and their names in install order. */
export function addonsSummary(draft: FlavorDraft): string {
  if (draft.addons.length === 0) return "No add-ons";
  return `${plural(draft.addons.length, "add-on")}: ${draft.addons.map((a) => a.name).join(", ")}`;
}

export const SUMMARIES: Record<CollapsibleId, (draft: FlavorDraft) => string> = {
  basics: basicsSummary,
  nodepools: nodepoolsSummary,
  addons: addonsSummary,
};

// ── The parts a viewer collapsed, per flavor ────────────────────────────────

const memoryKey = (flavor: string) => `wingman:flavor-editor:collapsed:${flavor}`;

/** The parts collapsed when this flavor was last edited in this browser; none when unknown or unreadable. */
export function readCollapsed(storage: Storage | undefined, flavor: string): CollapsibleId[] {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(memoryKey(flavor)) ?? "[]");
    return Array.isArray(stored) ? COLLAPSIBLE.filter((id) => stored.includes(id)) : [];
  } catch {
    return [];
  }
}

/** Remember the collapsed parts (nothing to remember when all are open); a full or blocked storage is ignored. */
export function writeCollapsed(storage: Storage | undefined, flavor: string, collapsed: readonly CollapsibleId[]): void {
  try {
    if (collapsed.length === 0) storage?.removeItem(memoryKey(flavor));
    else storage?.setItem(memoryKey(flavor), JSON.stringify(COLLAPSIBLE.filter((id) => collapsed.includes(id))));
  } catch {
    // Kept for this visit only
  }
}
