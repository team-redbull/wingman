/**
 * Edit add-on (ADR-0043, ADR-0073): one editor for everything an add-on is,
 * sent in one `PUT /addons/{team}/{addon}` and so one merge request: its
 * deploy config (`operators/<chart>/<chart>.yaml`, edited in place), its
 * sync options and `ignoreDifferences`, its Sig values, an OLM operator's
 * settings at the Sig level, and its OCP-version pins (added, changed, moved,
 * removed). Only what changes is sent, guarded by the commit the entry was
 * read at (ADR-0006).
 */

import { REPO_URL, sameSync } from "@/lib/day2";
import { NO_SETTINGS, settingsChange, settingsProblem, type OperatorDraft } from "@/lib/olm";
import { ignoreDifferencesText, parseIgnoreDifferences, sameValues, type Values } from "@/lib/values";
import { cardsProblem, pinCards, pinEdits, withNewCard, type PinCard } from "@/components/addons/ocp-pins/model";
import type { AddonDetail, AddonOperator, CatalogEntry, SyncSettings, UpdateTeamDefaultBody } from "@/types/day2";

/** Where the editor opens: the pins card opens it on a new pin, or on one pin to edit or remove. */
export type EditorFocus = { kind: "add" } | { kind: "edit" | "remove"; version: string };

/** Everything the editor holds; `values` is `null` while its YAML does not parse. */
export interface EditorDraft {
  repourl: string;
  /** Blank: `HEAD`, no key. */
  revision: string;
  /** Blank: `.`, no key. */
  path: string;
  namespace: string;
  sync: SyncSettings;
  ignoreText: string;
  values: Values | null;
  /** The Sig level's operator settings (all `null` for a plain chart). */
  operator: OperatorDraft;
  pins: PinCard[];
}

/** The add-on's `targetRevision` as typed: blank for `HEAD`, which writes no key. */
function revisionText(entry: CatalogEntry): string {
  const revision = entry.argocd_metadata.targetRevision;
  return revision === "HEAD" ? "" : revision;
}

function pathText(entry: CatalogEntry): string {
  const path = entry.argocd_metadata.path;
  return path === "." ? "" : path;
}

/** The operator the editor writes: an editable OLM operator; `null` for a plain chart or one shown read only. */
export function editableOperator(op: AddonOperator | null | undefined): AddonOperator | null {
  return op && op.is_operator && op.editable && op.sig ? op : null;
}

/** The draft as read, opened where `focus` says: a new pin added, or a pin marked removed. */
export function initialDraft(entry: CatalogEntry, detail: AddonDetail, op: AddonOperator | null, focus?: EditorFocus): EditorDraft {
  const cards = pinCards(detail, op?.pins ?? []);
  const pins =
    focus?.kind === "add"
      ? withNewCard(cards)
      : focus?.kind === "remove"
        ? cards.map((c) => (c.from === focus.version ? { ...c, removed: true } : c))
        : cards;
  return {
    repourl: entry.argocd_metadata.repourl,
    revision: revisionText(entry),
    path: pathText(entry),
    namespace: entry.argocd_metadata.projectNamespace,
    sync: entry.sync,
    ignoreText: ignoreDifferencesText(entry.ignore_differences),
    values: entry.default_values,
    operator: op?.sig?.own ?? NO_SETTINGS,
    pins,
  };
}

/** The pin `focus` names in `pins` (the new one for `add`), to bring into view; `null` for none. */
export function focusedPin(pins: readonly PinCard[], focus?: EditorFocus): number | null {
  if (!focus) return null;
  if (focus.kind === "add") return pins.filter((p) => p.from === null).at(-1)?.key ?? null;
  return pins.find((p) => p.from === focus.version)?.key ?? null;
}

/** The deploy config's keys that change: a blank optional field removes its key. */
function deployChanges(entry: CatalogEntry, draft: EditorDraft): Partial<UpdateTeamDefaultBody> {
  const out: Partial<UpdateTeamDefaultBody> = {};
  const [repourl, revision, path, namespace] = [draft.repourl.trim(), draft.revision.trim(), draft.path.trim(), draft.namespace.trim()];
  if (repourl !== entry.argocd_metadata.repourl) out.repourl = repourl;
  if (revision !== revisionText(entry)) out.target_revision = revision || null;
  if (path !== pathText(entry)) out.path = path && path !== "." ? path : null;
  if (namespace !== entry.argocd_metadata.projectNamespace) out.project_namespace = namespace || null;
  if (!sameSync(draft.sync, entry.sync)) out.sync = draft.sync;
  const ignore = parseIgnoreDifferences(draft.ignoreText);
  if (ignore.ok && draft.ignoreText !== ignoreDifferencesText(entry.ignore_differences) && !sameValues(ignore.value, entry.ignore_differences ?? null))
    out.ignore_differences = ignore.value;
  return out;
}

/** The request: only what changes, the entry's `last_commit_id` guarding every file. */
export function editorBody(entry: CatalogEntry, op: AddonOperator | null, draft: EditorDraft): UpdateTeamDefaultBody {
  const out: UpdateTeamDefaultBody = { last_commit_id: entry.last_commit_id, ...deployChanges(entry, draft) };
  if (draft.values !== null && !sameValues(draft.values, entry.default_values)) out.values = draft.values;
  const sig = editableOperator(op)?.sig;
  const operator = sig ? settingsChange(sig.own, draft.operator) : {};
  if (Object.keys(operator).length > 0) out.operator = operator;
  const pins = pinEdits(draft.pins);
  if (pins.ocp_versions.length > 0) out.ocp_versions = pins.ocp_versions;
  if (pins.remove_ocp_versions.length > 0) out.remove_ocp_versions = pins.remove_ocp_versions;
  return out;
}

/** Why the editor cannot be previewed yet, or `null`. */
export function editorBlocker(entry: CatalogEntry, op: AddonOperator | null, draft: EditorDraft): string | null {
  if (draft.values === null) return "Fix the values YAML";
  if (!parseIgnoreDifferences(draft.ignoreText).ok) return "Fix the ignoreDifferences YAML";
  if (!REPO_URL.test(draft.repourl.trim())) return "Give the chart repo URL (http or https)";
  const settings = editableOperator(op) ? settingsProblem(draft.operator) : null;
  if (settings) return `Sig values: ${settings}`;
  const pins = cardsProblem(draft.pins, Boolean(op?.is_operator));
  if (pins) return pins;
  return Object.keys(editorBody(entry, op, draft)).length > 1 ? null : "No changes yet";
}
