import { describe, expect, it } from "vitest";
import { NO_SETTINGS } from "@/lib/olm";
import { withNewRow } from "@/components/addons/ocp-pins/model";
import { createBody, newAddonBlocker, type NewAddonContext, type NewAddonDraft } from "./model";

const draft = (over: Partial<NewAddonDraft> = {}): NewAddonDraft => ({
  name: "cert-manager",
  repourl: "https://gitlab.example/redbull/helm-charts/cert-manager.git",
  revision: "",
  path: "",
  namespace: "cert-manager",
  sync: { auto_sync: false, prune: false, self_heal: false, sync_options: [] },
  ignore: { ok: true, value: null },
  values: {},
  scope: null,
  defaultValues: {},
  operator: NO_SETTINGS,
  pins: [],
  ...over,
});

const context = (over: Partial<NewAddonContext> = {}): NewAddonContext => ({
  team: "redbull",
  existing: [],
  readOnlyReason: null,
  showReason: true,
  ready: true,
  isOperator: true,
  ...over,
});

describe("a new add-on", () => {
  it("is held until it can be sent, in the form's order", () => {
    expect(newAddonBlocker(draft(), context({ readOnlyReason: "no" }))).toBe("This team is read-only in Wingman");
    expect(newAddonBlocker(draft(), context({ ready: false }))).toBe("Loading what the team's add-ons use");
    expect(newAddonBlocker(draft({ name: "Cert" }), context())).toContain("lowercase");
    expect(newAddonBlocker(draft(), context({ existing: ["cert-manager"] }))).toBe("redbull has cert-manager already");
    expect(newAddonBlocker(draft({ operator: { ...NO_SETTINGS, channel: "a b" } }), context())).toMatch(/^Sig values: Update channel:/);
    // A chart that is no operator ignores operator settings left from another address.
    expect(newAddonBlocker(draft({ operator: { ...NO_SETTINGS, channel: "a b" } }), context({ isOperator: false }))).toBeNull();
    const [pin] = withNewRow([]);
    expect(newAddonBlocker(draft({ pins: [{ ...pin, version: "4.20.9" }] }), context())).toBe(
      "Pin 1: A pin needs a chart revision, values or operator settings",
    );
    expect(newAddonBlocker(draft({ pins: [{ ...pin, version: "4.20.9", operator: { ...NO_SETTINGS, channel: "stable-v1.15" } }] }), context())).toBeNull();
  });

  it("sends an operator's settings and each pin's only when set, and a pin's revision only when given", () => {
    const [pin] = withNewRow([]);
    const operatorPin = { ...pin, version: "4.20.9", operator: { ...NO_SETTINGS, channel: "stable-v1.15" } };
    const body = createBody(draft({ operator: { ...NO_SETTINGS, channel: "stable-v1" }, pins: [operatorPin] }), true);
    expect(body).toMatchObject({ operator: { channel: "stable-v1" }, ocp_versions: [{ version: "4.20.9", values: {}, operator: { channel: "stable-v1.15" } }] });
    expect(body.ocp_versions?.[0]).not.toHaveProperty("target_revision");
    const plain = createBody(draft({ operator: { ...NO_SETTINGS, channel: "stable-v1" }, pins: [{ ...operatorPin, values: { a: 1 } }] }), false);
    expect(plain).not.toHaveProperty("operator");
    expect(plain.ocp_versions).toEqual([{ version: "4.20.9", values: { a: 1 } }]);
    expect(createBody(draft(), true)).not.toHaveProperty("ocp_versions");
  });
});
