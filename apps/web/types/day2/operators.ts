import type { Finding } from "./destinations";

// ── An add-on that installs an OLM operator (ADR-0073) ───────────────────────
// docs/notes/2026-11-12-day2-addon-authoring-api.md §9. An add-on is an
// operator when its chart's own values hold a Subscription block; Wingman
// writes three of its keys (`channel`, `startingCSV`, `installPlanApproval`)
// in the add-on's values files, per level: the Sig values and each
// OCP-version pin.

/** `installPlanApproval`. Wingman writes `Automatic` only: Manual stalls the GitOps sync. */
export type InstallPlanApproval = "Automatic" | "Manual" | (string & {});

/**
 * The OperatorGroup the chart renders: `all-namespaces` (no target
 * namespaces, or `openshift-operators`), `own-namespace` (the install
 * namespace alone), `namespaces` (another list), `existing-group`
 * (`operatorGroup.enabled: false`) or `unknown` (the chart templates its own).
 */
export type InstallMode = "all-namespaces" | "own-namespace" | "namespaces" | "existing-group" | "unknown" | (string & {});

/** The three settings Wingman writes, as one level's file sets them: `null` is not set there (inherited). */
export interface OperatorSettings {
  channel: string | null;
  /** `""`: the channel's head ("Latest in the channel"). */
  starting_csv: string | null;
  install_plan_approval: InstallPlanApproval | null;
}

/** The Subscription a level gives, merged as Helm merges: `null` is not in any of its files. */
export interface OperatorFacts extends OperatorSettings {
  /** The OLM package, `subscription.name`. */
  package: string | null;
  /** The install namespace, `subscription.namespace`. */
  namespace: string | null;
  source: string | null;
  source_namespace: string | null;
  install_mode: InstallMode;
  target_namespaces: string[];
  /** The fields that are the operator-olm subchart's defaults (no file sets them). */
  defaulted: string[];
}

/** One level: its file, what it sets itself, and what it gives. */
export interface OperatorLevel {
  /** The values file the settings are written to. */
  path: string;
  own: OperatorSettings;
  effective: OperatorFacts;
}

/** An OCP-version pin's level, `operators/<chart>/ocp-versions/<version>/values.yaml`. */
export interface OperatorPin extends OperatorLevel {
  version: string;
  /** `4.16`. */
  minor: string;
  /** `null`: a values-only pin. */
  target_revision: string | null;
  destinations: number;
}

/** An OCP version the add-on's destinations run. */
export interface OperatorVersion {
  version: string;
  minor: string;
  destinations: number;
  pinned: boolean;
}

/** A channel of a package in one minor's mirrored catalog. */
export interface CatalogChannel {
  name: string;
  is_default: boolean;
  /** OLM's "latest": the entry no other entry replaces or skips; `null` without a file-based catalog. */
  head: string | null;
  /** CSV names, newest first; empty when only an ImageSetConfiguration names the channel. */
  versions: string[];
  /** The mirrored range (oc-mirror's `minVersion` / `maxVersion`). */
  min_version: string | null;
  max_version: string | null;
}

export interface CatalogPackage {
  name: string;
  default_channel: string | null;
  channels: CatalogChannel[];
}

/** One OCP minor's catalog files, as read from Git. */
export interface CatalogMinor {
  minor: string;
  /** The files read; empty: none exists for this minor. */
  files: string[];
  /** What could not be read. */
  problems: string[];
  /** `null`: the files do not have the package (or there are none). */
  package: CatalogPackage | null;
}

/** `DAY2_OPERATOR_CATALOG_*`: off (`configured: false`, no minors) unless set. */
export interface OperatorCatalog {
  configured: boolean;
  /** Where it is read from, for the person: `<project>@<ref>: <paths>`. */
  source: string | null;
  minors: CatalogMinor[];
}

/**
 * `GET /api/day2/addons/{team}/{addon}/operator`. For a plain chart
 * `is_operator` is false, `reason` says why, and the rest is empty.
 */
export interface AddonOperator {
  team: string;
  chart: string;
  is_operator: boolean;
  /** False for an operator Wingman shows but does not edit (two Subscription blocks, unreadable chart values). */
  editable: boolean;
  reason: string | null;
  /** The chart revision whose values were read. */
  revision: string;
  /** Where the block is in a values file: `operator-olm.subscription`. */
  key_path: string | null;
  /** The key path's first key; `null` at the top level. */
  subchart: string | null;
  chart_values_problem: string | null;
  /**
   * The chart's own values' settings. §9 names this member `chart`, as it
   * names the add-on: the two cannot share a JSON key, so this is read as
   * `chart_level` (absent: the web works without it).
   */
  chart_level?: OperatorFacts | null;
  /** `null` for a plain chart. */
  sig: OperatorLevel | null;
  pins: OperatorPin[];
  versions: OperatorVersion[];
  catalog: OperatorCatalog;
  warnings: Finding[];
}

/** A write's settings for one level: absent leaves a key, `null` removes it there, a value sets it. */
export interface OperatorSettingsIn {
  channel?: string | null;
  /** `""`: "Latest in the channel". */
  starting_csv?: string | null;
  /** `Automatic` only (422 `olm-manual-approval`). */
  install_plan_approval?: "Automatic" | null;
}

/**
 * A pin in Edit add-on's one MR: no `from_version` adds it, its own version
 * changes it, another moves its folder. `target_revision: ""` drops the
 * revision (a values-only pin); `values: {}` deletes its values.yaml.
 */
export interface PinEditIn {
  version: string;
  from_version?: string;
  target_revision?: string;
  values?: Record<string, unknown>;
  operator?: OperatorSettingsIn;
}

/** `GET /api/day2/teams/{team}/addon-chart?repourl=&revision=&path=`: a chart before its add-on exists. */
export interface AddonChart {
  repourl: string;
  /** The chart repo on this GitLab, `null` elsewhere. */
  project: string | null;
  /** The chart repo's branches, default branch first; empty for a repo elsewhere (with `problem`). */
  revisions: string[];
  problem: string | null;
  /** As `GET …/operator`, with `sig.own` all `null` and no pins. */
  operator: AddonOperator;
}
