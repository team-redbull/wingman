import { describe, expect, it } from "vitest";
import type { AddonOperator, CatalogMinor, OperatorFacts } from "@/types/day2";
import {
  NO_SETTINGS,
  catalogSourceText,
  channelChoice,
  channelProblem,
  chartInherited,
  hasSettings,
  inheritLabel,
  installModeText,
  minorOf,
  newestFirst,
  settingsChange,
  settingsProblem,
  settingsSet,
  sigInherited,
  sigMinors,
  startingCsvProblem,
  versionChoice,
} from "./olm";

const facts = (over: Partial<OperatorFacts> = {}): OperatorFacts => ({
  package: "openshift-cert-manager-operator",
  namespace: "cert-manager-operator",
  channel: "stable-v1",
  starting_csv: "",
  install_plan_approval: "Automatic",
  source: "generic-cs",
  source_namespace: "openshift-marketplace",
  install_mode: "own-namespace",
  target_namespaces: ["cert-manager-operator"],
  defaulted: ["install_plan_approval", "source", "source_namespace"],
  ...over,
});

const V420 = ["cert-manager-operator.v1.15.1", "cert-manager-operator.v1.15.0", "cert-manager-operator.v1.14.2"];

const MINORS: CatalogMinor[] = [
  {
    minor: "4.16",
    files: ["mirror/imageset-config-4.16.yaml"],
    problems: [],
    package: {
      name: "openshift-cert-manager-operator",
      default_channel: "stable-v1",
      channels: [
        { name: "stable-v1", is_default: true, head: null, versions: [], min_version: null, max_version: null },
        { name: "stable-v1.14", is_default: false, head: null, versions: [], min_version: null, max_version: null },
      ],
    },
  },
  {
    minor: "4.20",
    files: ["mirror/imageset-config-4.20.yaml", "catalogs/4.20/catalog.json"],
    problems: [],
    package: {
      name: "openshift-cert-manager-operator",
      default_channel: "stable-v1",
      channels: [
        { name: "stable-v1", is_default: true, head: V420[0], versions: V420, min_version: null, max_version: null },
        { name: "stable-v1.15", is_default: false, head: V420[0], versions: V420.slice(0, 2), min_version: null, max_version: null },
      ],
    },
  },
  { minor: "4.18", files: ["mirror/imageset-config-4.18.yaml"], problems: [], package: null },
  { minor: "4.21", files: [], problems: [], package: null },
];

function operator(over: Partial<AddonOperator> = {}): AddonOperator {
  return {
    team: "redbull",
    chart: "cert-manager",
    is_operator: true,
    editable: true,
    reason: null,
    revision: "HEAD",
    key_path: "operator-olm.subscription",
    subchart: "operator-olm",
    chart_values_problem: null,
    sig: { path: "operators/cert-manager/values.yaml", own: { ...NO_SETTINGS, channel: "stable-v1.14" }, effective: facts({ channel: "stable-v1.14" }) },
    pins: [],
    versions: [
      { version: "4.16.27", minor: "4.16", destinations: 3, pinned: false },
      { version: "4.20.9", minor: "4.20", destinations: 2, pinned: true },
      { version: "4.20.10", minor: "4.20", destinations: 1, pinned: false },
    ],
    catalog: { configured: true, source: "redbull/operator-catalog@main", minors: MINORS },
    warnings: [],
    ...over,
  };
}

describe("the settings' rules", () => {
  it("take a channel name and a CSV name, as day2 does", () => {
    for (const ok of ["stable", "stable-v1.14", "tech_preview", "4.16", "Candidate"]) expect(channelProblem(ok)).toBeNull();
    for (const bad of ["-stable", ".x", "a b", "stable/v1", ""]) expect(channelProblem(bad)).toContain("is no channel name");
    for (const ok of ["", "cert-manager-operator.v1.14.1", "kubevirt-hyperconverged-operator.v4.16.3", "foo.v1.0.0-rc.1"]) expect(startingCsvProblem(ok)).toBeNull();
    for (const bad of ["v1.14.1", "cert-manager-operator", "Cert-Manager.v1.0.0", "x.v1.0", "x.1.0.0", `${"a".repeat(250)}.v1.0.0`]) expect(startingCsvProblem(bad)).toContain("is no version");
  });

  it("send only what changes from the level's own file, and never Manual", () => {
    const own = { channel: "stable-v1", starting_csv: null, install_plan_approval: "Manual" };
    expect(settingsChange(own, own)).toEqual({});
    expect(settingsChange(own, { ...own, channel: " stable-v1.15 " })).toEqual({ channel: "stable-v1.15" });
    expect(settingsChange(own, { ...own, channel: "  " })).toEqual({ channel: null });
    expect(settingsChange(own, { ...own, starting_csv: "" })).toEqual({ starting_csv: "" });
    expect(settingsChange(own, { ...own, install_plan_approval: "Automatic" })).toEqual({ install_plan_approval: "Automatic" });
    expect(settingsChange({ ...own, install_plan_approval: null }, own)).toEqual({});
    expect(settingsSet({ ...NO_SETTINGS, starting_csv: "" })).toEqual({ starting_csv: "" });
    expect(hasSettings(NO_SETTINGS)).toBe(false);
    expect(hasSettings({ ...NO_SETTINGS, channel: "stable" })).toBe(true);
    expect(settingsProblem({ ...NO_SETTINGS, channel: "a b" })).toContain("Update channel:");
    expect(settingsProblem({ ...NO_SETTINGS, starting_csv: "1.0" })).toContain("Version:");
    expect(settingsProblem({ channel: "stable", starting_csv: "x.v1.0.0", install_plan_approval: null })).toBeNull();
  });
});

describe("what a level shows and inherits", () => {
  it("says OperatorHub's installation mode and catalog source in words", () => {
    expect(installModeText(facts())).toBe("A specific namespace: cert-manager-operator");
    expect(installModeText(facts({ install_mode: "all-namespaces" }))).toBe("All namespaces on the cluster");
    expect(installModeText(facts({ install_mode: "namespaces", target_namespaces: ["a", "b"] }))).toBe("a, b");
    expect(installModeText(facts({ install_mode: "existing-group" }))).toBe("The namespace's own OperatorGroup");
    expect(installModeText(facts({ install_mode: "unknown" }))).toBe("Set by the chart's templates");
    expect(catalogSourceText(facts())).toBe("generic-cs in openshift-marketplace");
    expect(catalogSourceText(facts({ source: null, source_namespace: null }))).toBe("Set by the chart's templates");
    expect(minorOf("4.16.27")).toBe("4.16");
    expect(minorOf("4.16")).toBeNull();
  });

  it("knows what the Sig values inherit: the chart's values, else operator-olm's default", () => {
    const op = operator({ chart_level: facts({ channel: "stable-v1", install_plan_approval: null, defaulted: [] }) });
    expect(chartInherited(op, "channel")).toEqual({ value: "stable-v1", from: "chart" });
    // The Sig values set none of these: their effective value is the chart's own, or operator-olm's where defaulted.
    expect(chartInherited(op, "starting_csv")).toEqual({ value: "", from: "chart" });
    expect(chartInherited(op, "install_plan_approval")).toEqual({ value: "Automatic", from: "default" });
    const bare = operator({ sig: { path: "v", own: { ...NO_SETTINGS, channel: "x" }, effective: facts({ channel: "x" }) }, chart_level: null });
    expect(chartInherited(bare, "channel")).toEqual({ value: "stable", from: "default" });
    expect(chartInherited(operator({ subchart: "olm", chart_level: null }), "channel")).toEqual({ value: null, from: "unknown" });
    expect(inheritLabel("channel", { value: "stable-v1", from: "chart" })).toBe("The chart's (stable-v1)");
    expect(inheritLabel("starting_csv", { value: "", from: "default" })).toBe("operator-olm's default (Latest in the channel)");
    expect(inheritLabel("channel", { value: null, from: "unknown" })).toBe("The chart's default");
  });

  it("gives a pin the Sig values' setting as edited", () => {
    const op = operator();
    expect(sigInherited(op, op.sig!.own, "channel")).toEqual({ value: "stable-v1.14", from: "sig" });
    expect(sigInherited(op, { ...NO_SETTINGS, channel: "stable-v1.15" }, "channel").value).toBe("stable-v1.15");
    expect(inheritLabel("channel", sigInherited(op, op.sig!.own, "channel"))).toBe("Inherit the Sig values' (stable-v1.14)");
  });
});

describe("the catalog's choices", () => {
  it("offer the Sig level every minor's channels, each marked where it is missing", () => {
    const op = operator();
    expect(sigMinors(op)).toEqual(["4.16", "4.20"]);
    const choice = channelChoice(op, sigMinors(op), "stable-v1.14");
    expect(choice.reason).toBeNull();
    expect(choice.options).toEqual([
      { value: "stable-v1", label: "stable-v1 (default)" },
      { value: "stable-v1.14", label: "stable-v1.14 · not in 4.20" },
      { value: "stable-v1.15", label: "stable-v1.15 · not in 4.16" },
    ]);
    // The current value is always offered, marked when the catalog lacks it.
    expect(channelChoice(op, ["4.20"], "fast")?.options?.at(-1)).toEqual({ value: "fast", label: "fast (not in the catalog)" });
  });

  it("say why there is no list: no catalog, or a minor without the package", () => {
    expect(channelChoice(operator({ catalog: { configured: false, source: null, minors: [] } }), ["4.16"], null)).toMatchObject({
      options: null,
      reason: "No mirrored catalog is configured in Wingman, so there is no list.",
    });
    expect(channelChoice(operator(), ["4.18"], null)).toMatchObject({ options: null, reason: "4.18's mirrored catalog has no openshift-cert-manager-operator." });
    expect(channelChoice(operator(), ["4.21", "4.22"], null).reason).toBe("4.21 has no catalog file; no catalog was read for 4.22.");
    const partly = channelChoice(operator(), ["4.18", "4.20"], null);
    expect(partly.options?.map((o) => o.label)).toEqual(["stable-v1 (default) · not in 4.18", "stable-v1.15 · not in 4.18"]);
    expect(partly.note).toBe("4.18's mirrored catalog has no openshift-cert-manager-operator.");
  });

  it("offer a channel's versions newest first, the head marked, or say there are none", () => {
    const op = operator();
    expect(versionChoice(op, ["4.16", "4.20"], "stable-v1", null).options).toEqual([
      { value: V420[0], label: `${V420[0]} (head)` },
      { value: V420[1], label: V420[1] },
      { value: V420[2], label: V420[2] },
    ]);
    expect(versionChoice(op, ["4.16"], "stable-v1", null)).toMatchObject({ options: null, reason: expect.stringContaining("lists no versions of stable-v1") });
    expect(versionChoice(op, ["4.20"], "stable-v1.14", null).reason).toContain("has no channel stable-v1.14");
    expect(versionChoice(op, ["4.20"], "stable-v1.15", "cert-manager-operator.v1.13.0").options?.at(-1)?.label).toBe("cert-manager-operator.v1.13.0 (not in the catalog)");
    expect(["x.v1.2.0", "x.v1.10.0", "x.v1.10.0-rc.1", "x.v1.9.9"].sort(newestFirst)).toEqual(["x.v1.10.0", "x.v1.10.0-rc.1", "x.v1.9.9", "x.v1.2.0"]);
  });
});
