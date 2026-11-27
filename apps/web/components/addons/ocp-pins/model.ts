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
import { NO_SETTINGS, hasSettings, settingsChange, settingsProblem, settingsSet, type OperatorDraft } from "@/lib/olm";
import { sameValues, type Values } from "@/lib/values";
import type { AddonDetail, AddonOcpVersion, Destination, OcpPinBody, OperatorPin, PinEditIn } from "@/types/day2";

/** `<major>.<minor>.<patch>`, as day2's `FULL_VERSION`. */
const FULL_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * A pin as a form holds it: `values` is `null` while its YAML does not
 * parse; `revision` blank is a values-only pin (ADR-0073); `operator` an OLM
 * operator's settings at this version (none for a plain chart).
 */
export interface PinDraft {
  version: string;
  revision: string;
  values: Values | null;
  operator: OperatorDraft;
}

const EMPTY_PIN: PinDraft = { version: "", revision: "", values: {}, operator: NO_SETTINGS };

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

/** A pin with nothing in it is no pin (the service's `pin-empty`). */
function emptyProblem(draft: PinDraft, isOperator: boolean): string | null {
  if (draft.revision.trim() || Object.keys(draft.values ?? {}).length > 0 || hasSettings(draft.operator)) return null;
  return isOperator ? "A pin needs a chart revision, values or operator settings" : "A pin needs a chart revision or values";
}

/** Why `draft` cannot be sent as a pin, or `null`. `taken`: the versions other pins have. */
function draftProblem(draft: PinDraft, taken: readonly string[], isOperator = false): string | null {
  return (
    versionProblem(draft.version, taken) ??
    (draft.values === null ? "Fix the values YAML" : null) ??
    settingsProblem(draft.operator) ??
    emptyProblem(draft, isOperator)
  );
}

/** Why a new add-on's pins cannot be sent, or `null`: each pin's problem, and no version twice. */
export function draftsProblem(drafts: readonly PinDraft[], isOperator = false): string | null {
  for (const [i, draft] of drafts.entries()) {
    const others = drafts.filter((_, j) => j !== i).map((d) => d.version.trim());
    const problem = draftProblem(draft, others, isOperator);
    if (problem) return `Pin ${i + 1}: ${problem}`;
  }
  return null;
}

/** A new pin, as the service reads it: no revision is a values-only pin; operator settings only when set. */
export function pinBody(draft: PinDraft): OcpPinBody {
  const revision = draft.revision.trim();
  const operator = settingsSet(draft.operator);
  return {
    version: draft.version.trim(),
    ...(revision ? { target_revision: revision } : {}),
    values: draft.values ?? {},
    ...(Object.keys(operator).length > 0 ? { operator } : {}),
  };
}

// ── The pins of Edit add-on (ADR-0073: one MR with the add-on) ───────────────

/**
 * A pin in Edit add-on: one that exists (`from`, its version as read, and
 * `original`, its fields as read) or a new one; `removed` sends it as a
 * removal, and can be undone until then.
 */
export interface PinCard extends PinRow {
  from: string | null;
  original: PinDraft | null;
  removed: boolean;
}

/** The add-on's pins as cards, oldest version first, each with its operator settings as read. */
export function pinCards(detail: AddonDetail, operatorPins: readonly OperatorPin[]): PinCard[] {
  return sortedPins(detail.ocp_versions).map((pin, i) => {
    const original: PinDraft = {
      version: pin.version,
      revision: pin.target_revision ?? "",
      values: pin.values_file.values,
      operator: operatorPins.find((p) => p.version === pin.version)?.own ?? NO_SETTINGS,
    };
    return { ...original, key: i + 1, from: pin.version, original, removed: false };
  });
}

/** `cards` with a new, empty, pin last. */
export function withNewCard(cards: readonly PinCard[]): PinCard[] {
  return [...cards, { ...EMPTY_PIN, key: Math.max(0, ...cards.map((c) => c.key)) + 1, from: null, original: null, removed: false }];
}

/**
 * A card as `ocp_versions` carries it, or `null` when it changes nothing: a
 * new pin as created (no values is none), an existing one with only what
 * changed (`target_revision: ""` drops the revision, `values: {}` the file)
 * and its own version, or another (a move of its folder).
 */
export function pinEdit(card: PinCard): PinEditIn | null {
  if (card.removed) return null;
  if (card.from === null || card.original === null) {
    const { values, ...created } = pinBody(card);
    return Object.keys(values).length > 0 ? { ...created, values } : created;
  }
  const item: PinEditIn = { version: card.version.trim(), from_version: card.from };
  const revision = card.revision.trim();
  if (revision !== card.original.revision) item.target_revision = revision;
  if (card.values !== null && !sameValues(card.values, card.original.values)) item.values = card.values;
  const operator = settingsChange(card.original.operator, card.operator);
  if (Object.keys(operator).length > 0) item.operator = operator;
  return Object.keys(item).length > 2 || item.version !== card.from ? item : null;
}

/** What Edit add-on sends for its pins. */
export function pinEdits(cards: readonly PinCard[]): { ocp_versions: PinEditIn[]; remove_ocp_versions: string[] } {
  return {
    ocp_versions: cards.map(pinEdit).filter((item): item is PinEditIn => item !== null),
    remove_ocp_versions: cards.filter((c) => c.removed && c.from !== null).map((c) => c.from as string),
  };
}

/** Why the cards cannot be sent, or `null`: each pin that stays, its rules, and no version twice. */
export function cardsProblem(cards: readonly PinCard[], isOperator: boolean): string | null {
  const live = cards.filter((c) => !c.removed);
  // A clash is said on the pin whose version was typed, not on the one it clashes with.
  const typed = (c: PinCard) => Number(c.from === c.version.trim());
  for (const card of [...live].sort((a, b) => typed(a) - typed(b))) {
    const others = live.filter((c) => c.key !== card.key).map((c) => c.version.trim());
    const problem = draftProblem(card, others, isOperator);
    const name = card.from ?? card.version.trim();
    if (problem) return `${name ? `OCP ${name}` : "The new pin"}: ${problem}`;
  }
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
 * pinned (`taken`: those the editor's pins have). The hub is version-less.
 */
export function versionSuggestions(detail: AddonDetail, taken: readonly string[] = detail.ocp_versions.map((p) => p.version)): VersionSuggestion[] {
  const pinned = new Set(taken);
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
