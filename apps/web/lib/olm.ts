/**
 * An add-on that installs an OLM operator (ADR-0073), as OperatorHub's install
 * page shows it: the rules day2 checks before it writes (`domain/olm.py`),
 * what each level inherits, and the choices a level's mirrored catalog offers.
 * Pure: the add-on's page, its editor and New add-on use it.
 *
 * Three settings per level (the Sig values, each OCP-version pin), each
 * `null` when the level's file does not set it: it inherits the level below
 * (a pin the Sig values, the Sig values the chart's own values, the chart
 * the operator-olm subchart's defaults).
 */

import type {
  AddonOperator,
  CatalogChannel,
  CatalogMinor,
  OperatorFacts,
  OperatorSettings,
  OperatorSettingsIn,
} from "@/types/day2";

export type OperatorField = keyof OperatorSettings;

/** A level's settings as a form holds them: `null` is not set at that level. */
export type OperatorDraft = OperatorSettings;

export const NO_SETTINGS: OperatorDraft = { channel: null, starting_csv: null, install_plan_approval: null };

/** OperatorHub's words. */
export const LATEST = "Latest in the channel";
export const VERSION_HELP = "The version of the first install only: with Automatic approval, OLM then follows the channel.";
export const MANUAL_REASON =
  "Manual stalls the GitOps sync: the Subscription waits at InstallPlanPending, Argo CD reports it Progressing and no later sync wave runs. The platform has no InstallPlan approver.";

/** What operator-olm sets when no file does (`gitops/charts/operator-olm`). */
const OLM_DEFAULTS: Record<OperatorField, string> = { channel: "stable", starting_csv: "", install_plan_approval: "Automatic" };

// ── The rules (422 olm-channel-invalid, olm-starting-csv-invalid) ────────────

const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const CSV_VERSION = /\.v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9a-z-]+(\.[0-9a-z-]+)*)?$/;

/** Why `channel` is no channel name, or `null`. */
export function channelProblem(channel: string): string | null {
  return CHANNEL.test(channel) ? null : `"${channel}" is no channel name: letters, digits, ".", "_" and "-", from a letter or digit`;
}

/** Why `csv` is no CSV name, or `null`; `""` is "Latest in the channel". */
export function startingCsvProblem(csv: string): string | null {
  if (csv === "" || (csv.length <= 253 && DNS_SUBDOMAIN.test(csv) && CSV_VERSION.test(csv))) return null;
  return `"${csv}" is no version: a CSV name, lowercase, ending .v<semver> (cert-manager-operator.v1.14.1)`;
}

/** A draft as it is sent: a channel trimmed (blank is not set), a version trimmed. */
function normalized(draft: OperatorDraft): OperatorDraft {
  return {
    channel: draft.channel?.trim() || null,
    starting_csv: draft.starting_csv === null ? null : draft.starting_csv.trim(),
    install_plan_approval: draft.install_plan_approval,
  };
}

/** Why a level's draft cannot be sent, or `null`. */
export function settingsProblem(draft: OperatorDraft): string | null {
  const d = normalized(draft);
  if (d.channel !== null) {
    const problem = channelProblem(d.channel);
    if (problem) return `Update channel: ${problem}`;
  }
  if (d.starting_csv !== null) {
    const problem = startingCsvProblem(d.starting_csv);
    if (problem) return `Version: ${problem}`;
  }
  return null;
}

/** The keys that change from `own` to `draft` (`null` removes one from the level). Manual is never written. */
export function settingsChange(own: OperatorSettings, draft: OperatorDraft): OperatorSettingsIn {
  const d = normalized(draft);
  const out: OperatorSettingsIn = {};
  if (d.channel !== own.channel) out.channel = d.channel;
  if (d.starting_csv !== own.starting_csv) out.starting_csv = d.starting_csv;
  if (d.install_plan_approval !== own.install_plan_approval && d.install_plan_approval !== "Manual")
    out.install_plan_approval = d.install_plan_approval === null ? null : "Automatic";
  return out;
}

/** The keys a new level sets (a create): only those given. */
export function settingsSet(draft: OperatorDraft): OperatorSettingsIn {
  return settingsChange(NO_SETTINGS, draft);
}

/** The draft sets one setting or more. */
export function hasSettings(draft: OperatorDraft): boolean {
  return Object.keys(settingsSet(draft)).length > 0;
}

// ── What a level shows and inherits ──────────────────────────────────────────

/** `4.16.27` → `4.16`; `null` for anything but a full version. */
export function minorOf(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

/** A setting's value as OperatorHub says it: `""` is "Latest in the channel". */
export function settingText(field: OperatorField, value: string | null): string {
  if (value === null) return "—";
  return field === "starting_csv" && value === "" ? LATEST : value;
}

/** What a level inherits for one setting, and from where. */
export interface Inherited {
  value: string | null;
  /** `chart`: the chart's own values; `default`: operator-olm's; `sig`: the Sig values; `unknown`: the chart's templates. */
  from: "chart" | "default" | "sig" | "unknown";
}

/** What the Sig values inherit: the chart's own values, else operator-olm's default. */
export function chartInherited(op: AddonOperator, field: OperatorField): Inherited {
  const sig = op.sig;
  if (sig && sig.own[field] === null && sig.effective[field] !== null)
    return { value: sig.effective[field], from: sig.effective.defaulted.includes(field) ? "default" : "chart" };
  const chart = op.chart_level?.[field] ?? null;
  if (chart !== null) return { value: chart, from: "chart" };
  return op.subchart === "operator-olm" ? { value: OLM_DEFAULTS[field], from: "default" } : { value: null, from: "unknown" };
}

/** The Sig level's value with `draft` applied. */
export function sigValue(op: AddonOperator, draft: OperatorDraft, field: OperatorField): string | null {
  return normalized(draft)[field] ?? chartInherited(op, field).value;
}

/** What a pin inherits: the Sig level's value, as edited. */
export function sigInherited(op: AddonOperator, sigDraft: OperatorDraft, field: OperatorField): Inherited {
  return { value: sigValue(op, sigDraft, field), from: "sig" };
}

/** The inherit option's label: "Inherit the Sig values' (stable-v1)", "The chart's (…)", "operator-olm's default (…)". */
export function inheritLabel(field: OperatorField, inherited: Inherited): string {
  const value = inherited.value === null ? null : settingText(field, inherited.value);
  const shown = value === null ? "" : ` (${value})`;
  if (inherited.from === "sig") return `Inherit the Sig values'${shown}`;
  if (inherited.from === "default") return `operator-olm's default${shown}`;
  if (inherited.from === "chart") return `The chart's${shown}`;
  return "The chart's default";
}

/** OperatorHub's Installation mode, in words. */
export function installModeText(facts: OperatorFacts): string {
  switch (facts.install_mode) {
    case "all-namespaces":
      return "All namespaces on the cluster";
    case "own-namespace":
      return `A specific namespace: ${facts.namespace ?? facts.target_namespaces[0] ?? "—"}`;
    case "namespaces":
      return facts.target_namespaces.join(", ") || "—";
    case "existing-group":
      return "The namespace's own OperatorGroup";
    case "unknown":
      return "Set by the chart's templates";
    default:
      return facts.install_mode;
  }
}

/** The CatalogSource: `generic-cs in openshift-marketplace`. */
export function catalogSourceText(facts: OperatorFacts): string {
  if (!facts.source && !facts.source_namespace) return "Set by the chart's templates";
  return `${facts.source ?? "—"} in ${facts.source_namespace ?? "—"}`;
}

/** The minors the Sig level is offered the catalog of: every one the add-on's destinations run, else the catalog's. */
export function sigMinors(op: AddonOperator): string[] {
  const minors = [...new Set(op.versions.map((v) => v.minor))];
  return minors.length > 0 ? minors : op.catalog.minors.map((m) => m.minor);
}

// ── The catalog's choices ────────────────────────────────────────────────────

export interface CatalogOption {
  value: string;
  label: string;
}

/**
 * What a field offers: `options` from the catalog, or `null` for free text
 * with `reason`. `note` says what part of the catalog lacks the package.
 */
export interface CatalogChoice {
  options: CatalogOption[] | null;
  reason: string | null;
  note: string | null;
}

const NO_CATALOG = "No mirrored catalog is configured in Wingman, so there is no list.";

function packageName(op: AddonOperator): string {
  return op.sig?.effective.package ?? op.chart_level?.package ?? op.chart;
}

function lacking(op: AddonOperator, minor: string, entry: CatalogMinor | undefined): string {
  if (!entry) return `no catalog was read for ${minor}`;
  if (entry.files.length === 0) return `${minor} has no catalog file`;
  return `${minor}'s mirrored catalog has no ${packageName(op)}`;
}

function sentence(parts: string[]): string {
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function isDefault(entry: CatalogMinor, name: string): boolean {
  const pkg = entry.package;
  return Boolean(pkg && (pkg.default_channel === name || pkg.channels.some((c) => c.name === name && c.is_default)));
}

/** The minors asked for, each with its catalog entry. */
function entriesOf(op: AddonOperator, minors: readonly string[]) {
  return minors.map((minor) => ({ minor, entry: op.catalog.minors.find((m) => m.minor === minor) }));
}

/**
 * The Update channel's options over `minors`: every channel of the package
 * in any of them, the default marked, and each minor it is missing from;
 * `current` is always offered, marked when the catalog lacks it.
 */
export function channelChoice(op: AddonOperator, minors: readonly string[], current: string | null): CatalogChoice {
  if (!op.catalog.configured) return { options: null, reason: NO_CATALOG, note: null };
  if (minors.length === 0) return { options: null, reason: "No destination runs it yet: there is no OpenShift version to read the catalog of.", note: null };
  const found = entriesOf(op, minors);
  const withPackage = found.filter((f) => f.entry?.package);
  const missing = found.filter((f) => !f.entry?.package).map((f) => lacking(op, f.minor, f.entry));
  if (withPackage.length === 0) return { options: null, reason: sentence(missing), note: null };
  const names = [...new Set(withPackage.flatMap((f) => f.entry?.package?.channels.map((c) => c.name) ?? []))];
  const options = names.map((name) => {
    const absent = found.filter((f) => !f.entry?.package?.channels.some((c) => c.name === name)).map((f) => f.minor);
    const defaultIn = withPackage.filter((f) => f.entry && isDefault(f.entry, name)).map((f) => f.minor);
    const mark = defaultIn.length === 0 ? "" : defaultIn.length === withPackage.length ? " (default)" : ` (default in ${defaultIn.join(", ")})`;
    return { value: name, label: `${name}${mark}${absent.length > 0 ? ` · not in ${absent.join(", ")}` : ""}` };
  });
  if (current && !names.includes(current)) options.push({ value: current, label: `${current} (not in the catalog)` });
  return { options, reason: null, note: missing.length > 0 ? sentence(missing) : null };
}

/** `cert-manager-operator.v1.15.1` → `[1, 15, 1, release]`, for ordering; a pre-release sorts below its release. */
function csvKey(csv: string): number[] {
  const m = /\.v(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(csv);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1] : [-1];
}

/** Newest first, by the CSV's version. */
export function newestFirst(a: string, b: string): number {
  const [x, y] = [csvKey(a), csvKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

/**
 * The Version's options for `channel` over `minors`: its versions newest
 * first, the head marked (OLM's latest); `current` always offered. "Latest
 * in the channel" (`""`) is the field's own first option.
 */
export function versionChoice(op: AddonOperator, minors: readonly string[], channel: string | null, current: string | null): CatalogChoice {
  if (!op.catalog.configured) return { options: null, reason: NO_CATALOG, note: null };
  if (!channel) return { options: null, reason: "Which channel this level gets is not known, so there is no list.", note: null };
  const channels = entriesOf(op, minors)
    .map((f) => f.entry?.package?.channels.find((c) => c.name === channel))
    .filter((c): c is CatalogChannel => Boolean(c));
  if (channels.length === 0) return { options: null, reason: `The catalog has no channel ${channel} here, so there is no list.`, note: null };
  const versions = [...new Set(channels.flatMap((c) => c.versions))].sort(newestFirst);
  if (versions.length === 0)
    return { options: null, reason: `The catalog lists no versions of ${channel}: an ImageSetConfiguration names channels only.`, note: null };
  const heads = new Set(channels.map((c) => c.head).filter(Boolean));
  const options = versions.map((csv) => ({ value: csv, label: heads.has(csv) ? `${csv} (head)` : csv }));
  if (current && !versions.includes(current)) options.push({ value: current, label: `${current} (not in the catalog)` });
  return { options, reason: null, note: null };
}
