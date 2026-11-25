import { describe, expect, it } from "vitest";
import type { AddonDetail, AddonOcpVersion, Destination, RepoFile, ScopeDestination, ScopePanel } from "@/types/day2";
import {
  changeBody,
  changeProblem,
  compareVersions,
  draftsProblem,
  fleetOverrides,
  pinBody,
  reachAt,
  teamVersions,
  versionProblem,
  versionSuggestions,
  withNewRow,
} from "./model";

const file = (path: string, values: Record<string, unknown> = {}, exists = true): RepoFile => ({
  path,
  exists,
  text: exists ? "x\n" : null,
  values,
  last_commit_id: exists ? "c1" : null,
  problem: null,
});

const pin = (version: string, revision: string | null, values: Record<string, unknown> = {}): AddonOcpVersion => ({
  version,
  target_revision: revision,
  deploy_config: file(`operators/x/ocp-versions/${version}/x.yaml`, revision ? { targetRevision: revision } : {}, revision !== null),
  values_file: file(`operators/x/ocp-versions/${version}/values.yaml`, values, Object.keys(values).length > 0),
  last_commit_id: "c1",
});

const dest = (id: string, version: string | null, deployed: boolean): ScopeDestination => ({ id, ocp_version: version, deployed }) as ScopeDestination;

function detail(destinations: ScopeDestination[], pins: AddonOcpVersion[] = [], overrides: Partial<ScopePanel> = {}): AddonDetail {
  const scope = (s: ScopePanel["scope"], extra: Partial<ScopePanel> = {}) =>
    ({ scope: s, label: s, is_default: false, deploy_config: file(`defaults/${s}/x/x.yaml`, {}, false), destinations: [], ...extra }) as ScopePanel;
  return {
    name: "x",
    ocp_versions: pins,
    scopes: [scope("hosted-clusters", { destinations, ...overrides }), scope("mces"), scope("hub"), scope("upi")],
  } as unknown as AddonDetail;
}

describe("an OCP-version pin's version", () => {
  it("is a full version, never a minor line", () => {
    expect(versionProblem("4.16.27", [])).toBeNull();
    expect(versionProblem(" 4.16.27 ", [])).toBeNull();
    expect(versionProblem("4.16", [])).toContain("full version, 4.16.<patch>");
    for (const v of ["4", "4.16.27-x86_64", "v4.16.27", "04.16.1", "4.16.x"]) expect(versionProblem(v, [])).toContain("<major>.<minor>.<patch>");
    expect(versionProblem("", [])).toBe("Give the OpenShift version");
    expect(versionProblem("4.16.27", ["4.16.27"])).toBe("OCP 4.16.27 is pinned already");
  });

  it("sorts as numbers", () => {
    expect(["4.16.27", "4.9.0", "4.16.3"].sort(compareVersions)).toEqual(["4.9.0", "4.16.3", "4.16.27"]);
  });
});

describe("a new add-on's pins", () => {
  it("need a revision, values that parse, and one version each", () => {
    const [a, b] = withNewRow(withNewRow([]));
    expect(a.key).not.toBe(b.key);
    expect(draftsProblem([])).toBeNull();
    expect(draftsProblem([{ ...a, version: "4.16.27", revision: "" }])).toContain("Pin 1: Give the chart revision");
    expect(draftsProblem([{ ...a, version: "4.16.27", revision: "1.0", values: null }])).toBe("Pin 1: Fix the values YAML");
    const twice = [
      { ...a, version: "4.16.27", revision: "1.0" },
      { ...b, version: "4.16.27", revision: "2.0" },
    ];
    expect(draftsProblem(twice)).toBe("Pin 1: OCP 4.16.27 is pinned already");
    expect(pinBody({ version: " 4.16.27", revision: " 1.0 ", values: null })).toEqual({ version: "4.16.27", target_revision: "1.0", values: {} });
  });

  it("are offered the versions the team's destinations run, newest first", () => {
    const d = (id: string, kind: Destination["kind"], version: string | null, teams: string[]) => ({ id, kind, ocp_version: version, teams }) as Destination;
    const destinations = [
      d("a", "hosted", "4.16.27", ["platform"]),
      d("b", "mce", "4.18.22", ["platform", "security"]),
      d("c", "hosted", "4.16.27", ["platform"]),
      d("d", "hosted", "4.20.9", ["security"]),
      d("hub", "hub", null, ["platform"]),
    ];
    expect(teamVersions(destinations, "platform").map((s) => [s.version, s.destinations])).toEqual([
      ["4.18.22", 1],
      ["4.16.27", 2],
    ]);
    expect(teamVersions(destinations, "platform", ["4.18.22"]).map((s) => s.version)).toEqual(["4.16.27"]);
  });
});

describe("a change of a pin", () => {
  it("sends only what changes, guarded by the read", () => {
    const p = pin("4.20.9", "2.0.0", { extra: 1 });
    expect(changeBody(p, { version: "4.20.9", revision: "2.1.0", values: { extra: 1 } })).toEqual({ last_commit_id: "c1", target_revision: "2.1.0" });
    expect(changeBody(p, { version: "4.20.9", revision: "2.0.0", values: {} })).toEqual({ last_commit_id: "c1", values: {} });
    expect(changeProblem(p, { version: "4.20.9", revision: "2.0.0", values: { extra: 1 } })).toBe("No changes yet");
    expect(changeProblem(p, { version: "4.20.9", revision: "", values: { extra: 1 } })).toContain("Give the chart revision");
  });

  it("keeps a values-only layer values-only, and refuses emptying it", () => {
    const p = pin("4.16.27", null, { a: 1 });
    expect(changeProblem(p, { version: "4.16.27", revision: "", values: { a: 2 } })).toBeNull();
    expect(changeBody(p, { version: "4.16.27", revision: "", values: { a: 2 } })).toEqual({ last_commit_id: "c1", values: { a: 2 } });
    expect(changeProblem(p, { version: "4.16.27", revision: "", values: {} })).toContain("remove it instead");
  });
});

describe("what the add-on's page knows", () => {
  it("suggests the versions its destinations run, those with the add-on first, unpinned only", () => {
    const d = detail(
      [dest("a", "4.16.27", false), dest("b", "4.18.22", true), dest("c", "4.20.9", false), dest("d", "4.16.27", false), dest("e", null, false)],
      [pin("4.20.9", "1.0")],
    );
    expect(versionSuggestions(d)).toEqual([
      { version: "4.18.22", destinations: 1, deploying: 1 },
      { version: "4.16.27", destinations: 2, deploying: 0 },
    ]);
    expect(reachAt(d, "4.18.22")).toBe(1);
    expect(reachAt(d, "4.16.27")).toBe(0);
  });

  it("says which fleet default's own revision overrides every pin", () => {
    const quiet = detail([], [], { is_default: true });
    expect(fleetOverrides(quiet)).toEqual([]);
    const loud = detail([], [], { is_default: true, deploy_config: file("defaults/hosted-clusters/x/x.yaml", { targetRevision: "main" }) });
    expect(fleetOverrides(loud)).toEqual([{ label: "hosted-clusters", path: "defaults/hosted-clusters/x/x.yaml", revision: "main" }]);
  });
});
