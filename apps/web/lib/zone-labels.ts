/**
 * A NodePool's zone label (ADR-0072's 2026-11-28 amendments):
 * `topology.kubernetes.io/zone` in its `nodeLabels`, the naming convention's,
 * which the platform's upgrade workflow reads to roll a cluster zone by zone.
 * Wingman writes it on every NodePool it adds for a convention InfraEnv, and
 * never on one that exists: changing an existing NodePool's labels could roll
 * its nodes, so Nodes labelled with their zone come from a new NodePool. Day1
 * refuses an edit's new NodePool without its zone label
 * (`wingman_day1.domain.zone_labels.edit_problems`); Edit cluster offers to
 * write it ({@link withZoneLabel}).
 */

import { indentOf, itemRange, keyLines, load, sorted } from "@/lib/infra-envs";
import { parseInfraEnvName } from "@/lib/node-types";

export const ZONE_LABEL = "topology.kubernetes.io/zone";
const NODE_LABELS = "nodeLabels";
/** A block mapping's zone line: its indentation, an optional quote around the key, a trailing comment. */
const ZONE_LINE = /^(\s*)(["']?)topology\.kubernetes\.io\/zone\2:[^#]*?(\s+#.*)?$/;

type Labels = Record<string, unknown>;

const isMapping = (value: unknown): value is Labels => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The zone a new NodePool of `infraEnv` labels its Nodes with: its name's, under the convention; else none. */
export const ownZone = (infraEnv: string | null): string | null => (infraEnv ? (parseInfraEnvName(infraEnv)?.zone ?? null) : null);

/** The zone label a file entry's `nodeLabels` give, as text; `null` when they give none. */
export function labelledZone(entry: Record<string, unknown>): string | null {
  const labels = entry[NODE_LABELS];
  const value = isMapping(labels) ? labels[ZONE_LABEL] : undefined;
  return value === undefined || value === null ? null : String(value);
}

/** Why a new NodePool of `infraEnv` does not label its Nodes with its zone; `null` when it does, or its InfraEnv names none. */
export function zoneLabelProblem(infraEnv: string | null, labelled: string | null): string | null {
  const zone = ownZone(infraEnv);
  if (zone === null || labelled === zone) return null;
  return labelled === null
    ? `A new NodePool labels its Nodes with its zone: add ${ZONE_LABEL}: ${zone} to its nodeLabels`
    : `Its nodeLabels give ${ZONE_LABEL}: ${labelled}, but its zone is ${zone}`;
}

/** A mapping as the shared template's `tojson` writes it: keys sorted, `{"a": "b", "c": "d"}`. */
function flow(labels: Labels): string {
  return `{${Object.keys(labels).sort().map((key) => `${JSON.stringify(key)}: ${JSON.stringify(labels[key])}`).join(", ")}}`;
}

/** The lines with nodepool `index`'s zone label set, or `null` when the entry's layout is not one this edits. */
function edited(lines: readonly string[], index: number, zone: string, labels: Labels): string[] | null {
  const range = itemRange(lines, index);
  if (!range) return null;
  const line = `${NODE_LABELS}: ${flow({ ...labels, [ZONE_LABEL]: zone })}`;
  const found = keyLines(lines, range, NODE_LABELS);
  const next = [...lines];
  if (!found) {
    next.splice(range.end, 0, `${" ".repeat(range.keys)}${line}`);
    return next;
  }
  const [head, stop] = found;
  if (head === range.start) return null; // the item's first key: leave it to the person
  const value = lines[head].slice(lines[head].indexOf(`${NODE_LABELS}:`) + NODE_LABELS.length + 1);
  if (value.replace(/#.*$/, "").trim() !== "") {
    const comment = /\}(\s+#.*)$/.exec(lines[head])?.[1] ?? "";
    next[head] = `${" ".repeat(indentOf(lines[head]))}${line}${comment}`; // a flow mapping, written as the template writes it
    return next;
  }
  const children = lines.slice(head + 1, stop);
  const at = children.findIndex((l) => ZONE_LINE.test(l));
  if (at >= 0) {
    const [, lead, quote, comment] = ZONE_LINE.exec(children[at]) ?? [];
    next[head + 1 + at] = `${lead}${quote}${ZONE_LABEL}${quote}: ${zone}${comment ?? ""}`;
  } else {
    const content = children.find((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
    next.splice(stop, 0, `${" ".repeat(content ? indentOf(content) : range.keys + 2)}${ZONE_LABEL}: ${zone}`);
  }
  return next;
}

/**
 * `text` with nodepool `index`'s `nodeLabels` giving `topology.kubernetes.io/zone: <zone>`,
 * every other label and line kept: added to a block mapping (or its value
 * replaced there), a flow mapping rewritten as the template writes it, or a
 * `nodeLabels` line added at the end of the entry. `null` when the layout is
 * not one this handles: the result must parse and hold exactly the old values
 * with that one change, or nothing is changed and the person edits the text.
 */
export function withZoneLabel(text: string, index: number, zone: string): string | null {
  const before = load(text);
  const pools = before && Array.isArray(before.nodepool) ? before.nodepool : [];
  const pool: unknown = pools[index];
  if (!isMapping(pool)) return null;
  const labels = pool[NODE_LABELS];
  if (labels !== undefined && labels !== null && !isMapping(labels)) return null;
  const next = edited(text.split("\n"), index, zone, isMapping(labels) ? labels : {});
  if (!next) return null;
  const result = next.join("\n");
  const expected = structuredClone(before) as Record<string, unknown>;
  const entry = (expected.nodepool as Labels[])[index];
  entry[NODE_LABELS] = { ...(isMapping(labels) ? labels : {}), [ZONE_LABEL]: zone };
  const after = load(result);
  return after && JSON.stringify(sorted(after)) === JSON.stringify(sorted(expected)) ? result : null;
}
