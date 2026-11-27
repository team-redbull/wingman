import { describe, expect, it } from "vitest";
import { NO_SETTINGS } from "@/lib/olm";
import type { AddonDetail, AddonOcpVersion, AddonOperator, CatalogEntry, OperatorFacts, RepoFile } from "@/types/day2";
import { editableOperator, editorBlocker, editorBody, focusedPin, initialDraft, type EditorDraft } from "./model";

const file = (path: string, values: Record<string, unknown> = {}): RepoFile => ({ path, exists: true, text: "x\n", values, last_commit_id: "c1", problem: null });

const SIG = { "operator-olm": { subscription: { channel: "stable-v1" } } };

const entry: CatalogEntry = {
  team: "redbull",
  name: "cert-manager",
  available_versions: ["main", "1.15.0", "1.14.0"],
  current_version: "HEAD",
  default_values: SIG,
  argocd_metadata: { projectNamespace: "cert-manager-operator", repourl: "https://gitlab.example/redbull/helm-charts/cert-manager.git", targetRevision: "HEAD", syncPolicy: {}, path: "." },
  dependencies: [],
  ocp_version_pins: [],
  fleet_defaults: [],
  chart_project: "redbull/helm-charts/cert-manager",
  warnings: [],
  writable: true,
  read_only_reason: null,
  sync: { auto_sync: false, prune: false, self_heal: false, sync_options: ["CreateNamespace=true"] },
  ignore_differences: null,
  deploy_config_exists: true,
  last_commit_id: "entry-1",
};

const pin = (version: string, revision: string | null, values: Record<string, unknown>): AddonOcpVersion => ({
  version,
  target_revision: revision,
  deploy_config: file(`operators/cert-manager/ocp-versions/${version}/cert-manager.yaml`),
  values_file: file(`operators/cert-manager/ocp-versions/${version}/values.yaml`, values),
  last_commit_id: "pin-1",
});

const detail = {
  team: "redbull",
  name: "cert-manager",
  catalog: entry,
  ocp_versions: [pin("4.20.9", null, { a: 1 }), pin("4.16.27", "1.14.0", {})],
  scopes: [],
} as unknown as AddonDetail;

const facts = { channel: "stable-v1", starting_csv: "", install_plan_approval: "Automatic", defaulted: [] } as unknown as OperatorFacts;

const op = {
  team: "redbull",
  chart: "cert-manager",
  is_operator: true,
  editable: true,
  subchart: "operator-olm",
  key_path: "operator-olm.subscription",
  sig: { path: "operators/cert-manager/values.yaml", own: { ...NO_SETTINGS, channel: "stable-v1" }, effective: facts },
  pins: [
    { version: "4.16.27", own: { ...NO_SETTINGS, channel: "stable-v1.14" } },
    { version: "4.20.9", own: { ...NO_SETTINGS, channel: "stable-v1.15" } },
  ],
  versions: [],
  catalog: { configured: false, source: null, minors: [] },
  warnings: [],
} as unknown as AddonOperator;

const draft = (over: Partial<EditorDraft> = {}) => ({ ...initialDraft(entry, detail, op), ...over });

describe("Edit add-on's one request", () => {
  it("starts as read: nothing to send", () => {
    const d = draft();
    expect(d.revision).toBe("");
    expect(d.path).toBe("");
    expect(d.operator).toEqual(op.sig?.own);
    expect(d.pins.map((p) => [p.from, p.operator.channel])).toEqual([
      ["4.16.27", "stable-v1.14"],
      ["4.20.9", "stable-v1.15"],
    ]);
    expect(editorBody(entry, op, d)).toEqual({ last_commit_id: "entry-1" });
    expect(editorBlocker(entry, op, d)).toBe("No changes yet");
  });

  it("carries the deploy config, the Sig values, the operator and the pins together, only what changed", () => {
    const d = draft();
    const [old, recent] = d.pins;
    const edited: EditorDraft = {
      ...d,
      namespace: "",
      operator: { ...d.operator, channel: "stable-v1.15", starting_csv: "" },
      pins: [{ ...old, removed: true }, { ...recent, operator: { ...recent.operator, channel: "stable-v1" } }],
    };
    expect(editorBody(entry, op, edited)).toEqual({
      last_commit_id: "entry-1",
      project_namespace: null,
      operator: { channel: "stable-v1.15", starting_csv: "" },
      ocp_versions: [{ version: "4.20.9", from_version: "4.20.9", operator: { channel: "stable-v1" } }],
      remove_ocp_versions: ["4.16.27"],
    });
    expect(editorBlocker(entry, op, edited)).toBeNull();
  });

  it("sends no operator settings for a plain chart or one Wingman does not edit", () => {
    const locked = { ...op, editable: false } as AddonOperator;
    expect(editableOperator(locked)).toBeNull();
    expect(editableOperator({ ...op, is_operator: false } as AddonOperator)).toBeNull();
    const d = initialDraft(entry, detail, locked);
    expect(editorBody(entry, locked, { ...d, operator: { ...d.operator, channel: "fast" } })).toEqual({ last_commit_id: "entry-1" });
    expect(initialDraft(entry, detail, null).operator).toEqual(NO_SETTINGS);
  });

  it("is held while a field breaks a rule, in the order the form shows them", () => {
    expect(editorBlocker(entry, op, draft({ values: null }))).toBe("Fix the values YAML");
    expect(editorBlocker(entry, op, draft({ ignoreText: "- [" }))).toBe("Fix the ignoreDifferences YAML");
    expect(editorBlocker(entry, op, draft({ repourl: "gitlab/x" }))).toBe("Give the chart repo URL (http or https)");
    expect(editorBlocker(entry, op, draft({ operator: { ...NO_SETTINGS, channel: "no way" } }))).toMatch(/^Sig values: Update channel:/);
    const d = draft();
    expect(editorBlocker(entry, op, { ...d, pins: [d.pins[0], { ...d.pins[1], version: "4.20" }] })).toMatch(/^OCP 4.20.9: A pin is keyed by the full version/);
  });

  it("opens where the pins card asked: a new pin, or one marked removed", () => {
    const added = initialDraft(entry, detail, op, { kind: "add" });
    expect(added.pins.map((p) => p.from)).toEqual(["4.16.27", "4.20.9", null]);
    expect(focusedPin(added.pins, { kind: "add" })).toBe(3);
    const removing = initialDraft(entry, detail, op, { kind: "remove", version: "4.20.9" });
    expect(removing.pins.find((p) => p.from === "4.20.9")?.removed).toBe(true);
    expect(editorBody(entry, op, removing)).toEqual({ last_commit_id: "entry-1", remove_ocp_versions: ["4.20.9"] });
    expect(focusedPin(removing.pins, { kind: "edit", version: "4.16.27" })).toBe(1);
    expect(focusedPin(removing.pins)).toBeNull();
  });
});
