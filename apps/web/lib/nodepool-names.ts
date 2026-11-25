/**
 * A NodePool's name (ADR-0071): the InfraEnv it draws from, then an optional
 * suffix, `<InfraEnv>` or `<InfraEnv>-<suffix>`. The InfraEnv part is the
 * nodepool's own and never typed; a person adds only the suffix, which lets
 * several NodePools draw from one InfraEnv. No cluster prefix: each cluster's
 * NodePools sit in its own `hcp-<clusterName>`. Day1 composes the name from
 * the form's `name_suffix` (its schema offers the input where the template
 * reads `nodepool_name`) and refuses a suffix, a length or a clash this file
 * shows before sending (`wingman_day1.domain.nodepool_names`). An existing
 * NodePool keeps its name, the chart's derived `<clusterName>-<infraEnvName>`
 * or a written one: renaming one would replace every node.
 */

import { itemRange, keyLines, load, sorted } from "@/lib/infra-envs";

export const SUFFIX_INPUT = "name_suffix";
/** A label value's limit: the name labels each of the NodePool's Nodes. */
const MAX_NAME = 63;
/** A DNS-1123 label's characters: a suffix ends one, a whole name is one. */
const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SUFFIX = LABEL;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Whether `path` is a nodepool's suffix input (`nodepools[1].name_suffix`). */
export const isSuffixPath = (path: string): boolean => /^nodepools\[\d+\]\.name_suffix$/.test(path);

/** A new NodePool's name: the InfraEnv alone, or the InfraEnv and the suffix. */
export function composeName(infraEnv: string, suffix: string): string {
  return suffix ? `${infraEnv}-${suffix}` : infraEnv;
}

/** Why a suffix cannot be used; `null` when it can (or is none). */
export function suffixProblem(suffix: string): string | null {
  if (suffix === "" || SUFFIX.test(suffix)) return null;
  return "Lowercase letters, digits and '-', starting and ending with a letter or digit";
}

/** Why a whole name cannot be used; `null` when it can. */
export function nameProblem(name: string): string | null {
  if (name.length > MAX_NAME) return `At most ${MAX_NAME} characters (this is ${name.length})`;
  if (!LABEL.test(name)) return "The InfraEnv's name is not lowercase letters, digits and '-'";
  return null;
}

/** Whether `name` is `infraEnv`, or `infraEnv` and a valid suffix. */
export function followsRule(name: string, infraEnv: string): boolean {
  if (name === infraEnv) return true;
  return name.startsWith(`${infraEnv}-`) && SUFFIX.test(name.slice(infraEnv.length + 1));
}

// ── The create form ──────────────────────────────────────────────────────────

/** Each form nodepool's name problem, by index: its suffix, its length, a name another one has. */
export function formNameProblems(pools: unknown): Record<number, string> {
  const found: Record<number, string> = {};
  if (!Array.isArray(pools)) return found;
  const seen = new Map<string, number>();
  pools.forEach((pool: unknown, index: number) => {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) return;
    const entry = pool as Record<string, unknown>;
    const infraEnv = text(entry.infra_env);
    const suffix = text(entry[SUFFIX_INPUT]);
    const own = suffixProblem(suffix);
    if (own) found[index] = own;
    if (!infraEnv) return;
    const name = composeName(infraEnv, suffix);
    const problem = own ?? nameProblem(name);
    if (problem) found[index] = problem;
    const first = seen.get(name);
    if (first === undefined) seen.set(name, index);
    else if (!problem) found[index] = `Nodepool ${first + 1} is named ${name} already: give one of them another suffix`;
  });
  return found;
}

// ── A cluster file: both shapes ─────────────────────────────────────────────

/** The NodePool the chart renders for a file entry: its `name`, else `<clusterName>-<infraEnvName>`. */
export function renderedName(entry: { name?: unknown; infraEnvName?: unknown }, clusterName: string): string | null {
  if (text(entry.name)) return text(entry.name);
  return text(entry.infraEnvName) ? `${clusterName}-${text(entry.infraEnvName)}` : null;
}

/** One nodepool entry of the file being edited, by its NodePool. */
export interface FileName {
  index: number;
  infraEnv: string | null;
  /** Its own `name`, when it writes one. */
  name: string | null;
  /** The NodePool the chart renders: `name`, else the derived one. */
  rendered: string | null;
  /** The file before the edit has this NodePool: its name is kept, never changed here. */
  existing: boolean;
}

function entries(doc: Record<string, unknown> | null): Record<string, unknown>[] {
  const pools = doc && Array.isArray(doc.nodepool) ? doc.nodepool : [];
  return pools.map((p: unknown) => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {}));
}

/**
 * The NodePools of `content`, each marked existing when `base` (the file
 * before the edit) has it, the first entry only: a second one rendering the
 * same name is another nodepool, which needs its own. `null` when it does not parse.
 */
export function fileNames(content: string, base: string, clusterName: string): FileName[] | null {
  const doc = load(content);
  if (!doc) return null;
  const left = new Set(entries(load(base)).map((e) => renderedName(e, clusterName)).filter((n): n is string => n !== null));
  return entries(doc).map((entry, index) => {
    const rendered = renderedName(entry, clusterName);
    const existing = rendered !== null && left.delete(rendered);
    return { index, infraEnv: text(entry.infraEnvName) || null, name: text(entry.name) || null, rendered, existing };
  });
}

/** The NodePools `base` has and `text` no longer does: merging deletes them, and their nodes. */
export function removedNames(content: string, base: string, clusterName: string): string[] {
  const now = new Set(entries(load(content)).map((e) => renderedName(e, clusterName)));
  return entries(load(base))
    .map((e) => renderedName(e, clusterName))
    .filter((n): n is string => n !== null && !now.has(n));
}

/**
 * `text` with nodepool `index`'s `name` set to `name`, every other line byte
 * for byte: the line replaced, or added below `infraEnvName`. `null` when the
 * layout is not one this handles (the item's first key, no `infraEnvName`
 * line): the result must parse and hold exactly the old values with that one
 * change, or nothing is changed and the person edits the text.
 */
export function withName(content: string, index: number, name: string): string | null {
  const before = load(content);
  const lines = content.split("\n");
  const range = itemRange(lines, index);
  if (!before || !range) return null;
  const line = `${" ".repeat(range.keys)}name: ${name}`;
  const found = keyLines(lines, range, "name");
  const next = [...lines];
  if (found) {
    if (found[0] === range.start) return null; // the item's first key: leave it to the person
    next.splice(found[0], found[1] - found[0], line);
  } else {
    const first = keyLines(lines, range, "infraEnvName");
    if (!first) return null;
    next.splice(first[1], 0, line);
  }
  const result = next.join("\n");
  const expected = structuredClone(before) as Record<string, unknown>;
  (expected.nodepool as Record<string, unknown>[])[index].name = name;
  const after = load(result);
  return after && JSON.stringify(sorted(after)) === JSON.stringify(sorted(expected)) ? result : null;
}
