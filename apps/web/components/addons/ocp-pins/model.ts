/**
 * OCP-version pins (ADR-0043's 2026-11-25 amendment): the rules day2 checks
 * (`domain/ocp_pins.py`), checked here first so a form says what is wrong
 * before it is sent, and what the add-on's page knows that helps choosing.
 *
 * A pin is `operators/<chart>/ocp-versions/<version>/`, read by every
 * destination whose OCP version is exactly `<version>`: the full version a
 * cluster's `mastertag` gives (`4.16.27-x86_64` is `4.16.27`), never `4.16`.
 */

import { FLEET_SCOPES, scopeLabel } from "@/lib/day2";
import { sameValues, type Values } from "@/lib/values";
import type { AddonDetail, AddonOcpVersion, ChangePinBody, Destination, OcpPinBody } from "@/types/day2";

/** `<major>.<minor>.<patch>`, as day2's `FULL_VERSION`. */
const FULL_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** A pin as a form holds it: `values` is `null` while its YAML does not parse. */
export interface PinDraft {
  version: string;
  revision: string;
  values: Values | null;
}

export const EMPTY_PIN: PinDraft = { version: "", revision: "", values: {} };

/** One pin of a list a form edits: `key` keeps its fields when another row goes. */
export interface PinRow extends PinDraft {
  key: number;
}

/** `rows` with one more, empty, row. */
export function withNewRow(rows: readonly PinRow[]): PinRow[] {
  return [...rows, { ...EMPTY_PIN, key: Math.max(0, ...rows.map((r) => r.key)) + 1 }];
}

/** Numeric order of full versions (`4.9.1` before `4.16.0`); anything else first. */
export function compareVersions(a: string, b: string): number {
  const key = (v: string) => (FULL_VERSION.test(v) ? v.split(".").map(Number) : []);
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Why `version` cannot be a new pin's, or `null`. `taken`: the versions already pinned. */
export function versionProblem(version: string, taken: readonly string[]): string | null {
  const v = version.trim();
  if (!v) return "Give the OpenShift version";
  if (!FULL_VERSION.test(v)) {
    return /^\d+\.\d+$/.test(v)
      ? `A pin is keyed by the full version, ${v}.<patch>: a cluster even a z-stream away does not read ${v}`
      : "The version is <major>.<minor>.<patch>, as a cluster's mastertag gives it (4.16.27)";
  }
  if (taken.includes(v)) return `OCP ${v} is pinned already`;
  return null;
}

/** Why a pin's revision cannot be sent, or `null`. */
function revisionProblem(revision: string): string | null {
  return revision.trim() ? null : "Give the chart revision: a branch of the chart repo (HEAD for its default branch)";
}

/** Why `draft` cannot be sent as a new pin, or `null`. */
export function draftProblem(draft: PinDraft, taken: readonly string[]): string | null {
  return versionProblem(draft.version, taken) ?? revisionProblem(draft.revision) ?? (draft.values === null ? "Fix the values YAML" : null);
}

/** Why a new add-on's pins cannot be sent, or `null`: each pin's problem, and no version twice. */
export function draftsProblem(drafts: readonly PinDraft[]): string | null {
  for (const [i, draft] of drafts.entries()) {
    const others = drafts.filter((_, j) => j !== i).map((d) => d.version.trim());
    const problem = draftProblem(draft, others);
    if (problem) return `Pin ${i + 1}: ${problem}`;
  }
  return null;
}

/** The body of a new pin, as the service reads it. */
export function pinBody(draft: PinDraft): OcpPinBody {
  return { version: draft.version.trim(), target_revision: draft.revision.trim(), values: draft.values ?? {} };
}

/** A form's draft of an existing pin. */
export function draftOf(pin: AddonOcpVersion): PinDraft {
  return { version: pin.version, revision: pin.target_revision ?? "", values: pin.values_file.values };
}

/**
 * A change of `pin` to `draft`: only what changes is sent (`values: {}`
 * deletes the file), guarded by the commit the pin was read at.
 */
export function changeBody(pin: AddonOcpVersion, draft: PinDraft): ChangePinBody {
  const body: ChangePinBody = { last_commit_id: pin.last_commit_id };
  const revision = draft.revision.trim();
  if (revision && revision !== (pin.target_revision ?? "")) body.target_revision = revision;
  if (draft.values !== null && !sameValues(draft.values, pin.values_file.values)) body.values = draft.values;
  return body;
}

/** Why a change of `pin` to `draft` cannot be sent, or `null`. */
export function changeProblem(pin: AddonOcpVersion, draft: PinDraft): string | null {
  // A pin that pins a revision keeps one; a hand-written values-only layer may stay so.
  if (pin.target_revision && !draft.revision.trim()) return revisionProblem(draft.revision);
  if (draft.values === null) return "Fix the values YAML";
  const body = changeBody(pin, draft);
  if (!("target_revision" in body) && !("values" in body)) return "No changes yet";
  if (!pin.target_revision && !draft.revision.trim() && Object.keys(draft.values).length === 0)
    return "A pin with neither a revision nor values is no pin: remove it instead";
  return null;
}

/** A version to offer: how many of the team's destinations run it, and how many of them get this add-on. */
export interface VersionSuggestion {
  version: string;
  destinations: number;
  deploying: number;
}

/**
 * The versions the add-on's destinations run (the page's own read): those
 * that deploy it first, then the rest, newest first, without the versions
 * already pinned. The hub is version-less.
 */
export function versionSuggestions(detail: AddonDetail): VersionSuggestion[] {
  const pinned = new Set(detail.ocp_versions.map((p) => p.version));
  const found = new Map<string, VersionSuggestion>();
  for (const panel of detail.scopes) {
    for (const d of panel.destinations) {
      if (!d.ocp_version || pinned.has(d.ocp_version)) continue;
      const entry = found.get(d.ocp_version) ?? { version: d.ocp_version, destinations: 0, deploying: 0 };
      entry.destinations += 1;
      if (d.deployed) entry.deploying += 1;
      found.set(d.ocp_version, entry);
    }
  }
  return [...found.values()].sort((a, b) => Number(b.deploying > 0) - Number(a.deploying > 0) || compareVersions(b.version, a.version));
}

/**
 * A new add-on's suggestions: the versions the destinations `team`'s repo
 * registers run (`GET /api/day2/clusters`), newest first, without `taken`.
 */
export function teamVersions(destinations: readonly Destination[], team: string, taken: readonly string[] = []): VersionSuggestion[] {
  const found = new Map<string, VersionSuggestion>();
  for (const d of destinations) {
    if (!d.ocp_version || d.kind === "hub" || !d.teams.includes(team) || taken.includes(d.ocp_version)) continue;
    const entry = found.get(d.ocp_version) ?? { version: d.ocp_version, destinations: 0, deploying: 0 };
    entry.destinations += 1;
    found.set(d.ocp_version, entry);
  }
  return [...found.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** How many of the add-on's apps run `version`: the destinations a pin there reaches. */
export function reachAt(detail: AddonDetail, version: string): number {
  return detail.scopes.flatMap((s) => s.destinations).filter((d) => d.deployed && d.ocp_version === version).length;
}

/** A fleet default whose deploy config sets `targetRevision`: on its scope, no pin's revision applies. */
export interface FleetOverride {
  label: string;
  path: string;
  revision: string;
}

/** The fleet defaults that override every pin's revision (the hub reads no pin). */
export function fleetOverrides(detail: AddonDetail): FleetOverride[] {
  return FLEET_SCOPES.filter((scope) => scope !== "hub").flatMap((scope) => {
    const panel = detail.scopes.find((s) => s.scope === scope);
    const revision = panel?.is_default ? panel.deploy_config.values.targetRevision : undefined;
    return typeof revision === "string" && revision
      ? [{ label: panel?.label || scopeLabel(scope), path: panel?.deploy_config.path ?? "", revision }]
      : [];
  });
}

/** The pins, oldest version first. */
export function sortedPins(pins: readonly AddonOcpVersion[]): AddonOcpVersion[] {
  return [...pins].sort((a, b) => compareVersions(a.version, b.version));
}
