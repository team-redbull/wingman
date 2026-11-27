/**
 * A new add-on in a team's catalog (ADR-0043, ADR-0053, ADR-0073): the
 * rules the form checks before its dry run, and the body it sends. An OLM
 * operator's settings are sent only for a chart the service says is one
 * (`GET /teams/{team}/addon-chart`), and only those that are set.
 */

import { CHART_NAME, REPO_URL } from "@/lib/day2";
import { NO_SETTINGS, hasSettings, settingsProblem, settingsSet, type OperatorDraft } from "@/lib/olm";
import type { Values } from "@/lib/values";
import { draftsProblem, pinBody, type PinRow } from "@/components/addons/ocp-pins/model";
import type { CreateAddonBody, FleetScope, SyncSettings } from "@/types/day2";

/** The form as typed, with what it has read. */
export interface NewAddonDraft {
  name: string;
  repourl: string;
  revision: string;
  path: string;
  namespace: string;
  sync: SyncSettings;
  /** `ignoreDifferences` as parsed; `ok: false` while it does not parse. */
  ignore: { ok: true; value: unknown[] | null } | { ok: false };
  values: Values | null;
  scope: FleetScope | null;
  defaultValues: Values | null;
  /** The Sig level's operator settings (used only when the chart is an operator). */
  operator: OperatorDraft;
  pins: PinRow[];
}

/** What the form knows beside the draft. */
export interface NewAddonContext {
  team: string;
  /** The team's add-on names. */
  existing: readonly string[];
  readOnlyReason: string | null;
  showReason: boolean;
  /** The team's template has loaded. */
  ready: boolean;
  /** The chart is an OLM operator Wingman edits. */
  isOperator: boolean;
}

/** Why the form cannot be previewed yet, or `null`. */
export function newAddonBlocker(draft: NewAddonDraft, context: NewAddonContext): string | null {
  const chart = draft.name.trim();
  if (context.readOnlyReason) return context.showReason ? "This team is read-only in Wingman" : "Reading the team's write access";
  if (!context.ready) return "Loading what the team's add-ons use";
  if (!chart) return "Give the add-on a name";
  if (!CHART_NAME.test(chart)) return "The name must be lowercase letters, digits and '-' (it becomes part of Application names)";
  if (context.existing.includes(chart)) return `${context.team} has ${chart} already`;
  if (!REPO_URL.test(draft.repourl.trim())) return "Give the chart repo URL (http or https)";
  if (!draft.ignore.ok) return "Fix the ignoreDifferences YAML";
  if (draft.values === null || (draft.scope !== null && draft.defaultValues === null)) return "Fix the values YAML";
  const settings = context.isOperator ? settingsProblem(draft.operator) : null;
  if (settings) return `Sig values: ${settings}`;
  return draftsProblem(context.isOperator ? draft.pins : draft.pins.map((p) => ({ ...p, operator: NO_SETTINGS })), context.isOperator);
}

/** The create, as the service reads it: optional parts only when there are some. */
export function createBody(draft: NewAddonDraft, isOperator: boolean): CreateAddonBody {
  const path = draft.path.trim();
  const operator = isOperator && hasSettings(draft.operator) ? settingsSet(draft.operator) : null;
  // A chart that is no operator (any more: its address changed) sends no pin settings.
  const pins = draft.pins.map((p) => pinBody(isOperator ? p : { ...p, operator: NO_SETTINGS }));
  return {
    name: draft.name.trim(),
    repourl: draft.repourl.trim(),
    target_revision: draft.revision.trim() || null,
    path: path && path !== "." ? path : null,
    project_namespace: draft.namespace.trim() || null,
    sync: draft.sync,
    ignore_differences: draft.ignore.ok ? draft.ignore.value : null,
    values: draft.values ?? {},
    default_scope: draft.scope,
    default_values: draft.scope ? (draft.defaultValues ?? {}) : {},
    ...(operator ? { operator } : {}),
    // Sent only when there are pins: a create without them is the same body as before.
    ...(pins.length > 0 ? { ocp_versions: pins } : {}),
    confirm_changes: [],
    message: null,
  };
}
