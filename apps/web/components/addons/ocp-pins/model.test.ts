import { describe, expect, it } from "vitest";
import { NO_SETTINGS } from "@/lib/olm";
import type { AddonDetail, AddonOcpVersion, Destination, OperatorPin, RepoFile, ScopeDestination, ScopePanel } from "@/types/day2";
import {
  cardsProblem,
  compareVersions,
  draftsProblem,
  fleetOverrides,
  pinBody,
  pinCards,
  pinEdit,
  pinEdits,
  reachAt,
  teamVersions,
  versionProblem,
  versionSuggestions,
  withNewCard,
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
  it("need a revision, values or operator settings, values that parse, and one version each", () => {
    const [a, b] = withNewRow(withNewRow([]));
    expect(a.key).not.toBe(b.key);
    expect(draftsProblem([])).toBeNull();
    // pin-empty: a pin with nothing in it is refused; a revision alone, values alone or a channel alone is a pin (ADR-0073).
    expect(draftsProblem([{ ...a, version: "4.16.27", revision: "" }])).toBe("Pin 1: A pin needs a chart revision or values");
    expect(draftsProblem([{ ...a, version: "4.16.27", revision: "" }], true)).toBe("Pin 1: A pin needs a chart revision, values or operator settings");
    expect(draftsProblem([{ ...a, version: "4.16.27", revision: "", values: { a: 1 } }])).toBeNull();
    expect(draftsProblem([{ ...a, version: "4.16.27", operator: { ...NO_SETTINGS, channel: "stable-v1" } }], true)).toBeNull();
    expect(draftsProblem([{ ...a, version: "4.16.27", operator: { ...NO_SETTINGS, channel: "-bad" } }], true)).toContain("Pin 1: Update channel:");
    expect(draftsProblem([{ ...a, version: "4.16.27", revision: "1.0", values: null }])).toBe("Pin 1: Fix the values YAML");
    const twice = [
      { ...a, version: "4.16.27", revision: "1.0" },
      { ...b, version: "4.16.27", revision: "2.0" },
    ];
    expect(draftsProblem(twice)).toBe("Pin 1: OCP 4.16.27 is pinned already");
  });

  it("are sent with a revision only when given, and operator settings only when set", () => {
    expect(pinBody({ version: " 4.16.27", revision: " 1.0 ", values: null, operator: NO_SETTINGS })).toEqual({ version: "4.16.27", target_revision: "1.0", values: {} });
    expect(pinBody({ version: "4.20.9", revision: "", values: {}, operator: { channel: "stable-v1.15", starting_csv: "", install_plan_approval: null } })).toEqual({
      version: "4.20.9",
      values: {},
      operator: { channel: "stable-v1.15", starting_csv: "" },
    });
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

describe("the pins of Edit add-on", () => {
  const own = (channel: string | null) => ({ version: "4.20.9", own: { ...NO_SETTINGS, channel } }) as OperatorPin;
  const cards = () => pinCards(detail([], [pin("4.20.9", "2.0.0", { extra: 1 }), pin("4.16.27", null, { a: 1 })]), [own("stable-v1.15")]);

  it("are read oldest version first, each with its operator settings", () => {
    const [old, recent] = cards();
    expect([old.from, recent.from]).toEqual(["4.16.27", "4.20.9"]);
    expect(recent.original).toMatchObject({ revision: "2.0.0", values: { extra: 1 }, operator: { channel: "stable-v1.15" } });
    expect(old.operator).toEqual(NO_SETTINGS);
    expect(pinEdits(cards())).toEqual({ ocp_versions: [], remove_ocp_versions: [] });
  });

  it("send only what changes: its own version, the keys, a dropped revision as blank", () => {
    const [old, recent] = cards();
    expect(pinEdit({ ...recent, revision: "2.1.0" })).toEqual({ version: "4.20.9", from_version: "4.20.9", target_revision: "2.1.0" });
    expect(pinEdit({ ...recent, revision: "" })).toEqual({ version: "4.20.9", from_version: "4.20.9", target_revision: "" });
    expect(pinEdit({ ...recent, values: {} })).toEqual({ version: "4.20.9", from_version: "4.20.9", values: {} });
    expect(pinEdit({ ...recent, operator: { ...recent.operator, channel: null } })).toEqual({ version: "4.20.9", from_version: "4.20.9", operator: { channel: null } });
    expect(pinEdit({ ...old, values: null })).toBeNull();
  });

  it("move a folder, add a pin with what it has, and remove one", () => {
    const [old, recent] = cards();
    expect(pinEdit({ ...recent, version: "4.20.10" })).toEqual({ version: "4.20.10", from_version: "4.20.9" });
    const added = withNewCard([old, recent]).at(-1);
    expect(added?.key).toBe(3);
    const fresh = { ...added!, version: "4.21.2", operator: { ...NO_SETTINGS, channel: "stable-v1.16" } };
    expect(pinEdit(fresh)).toEqual({ version: "4.21.2", operator: { channel: "stable-v1.16" } });
    expect(pinEdit({ ...fresh, revision: "1.16.0", values: { b: 1 } })).toEqual({ version: "4.21.2", target_revision: "1.16.0", values: { b: 1 }, operator: { channel: "stable-v1.16" } });
    expect(pinEdits([{ ...old, removed: true }, recent, { ...fresh, removed: true }])).toEqual({ ocp_versions: [], remove_ocp_versions: ["4.16.27"] });
  });

  it("are checked like a new add-on's: a version no other pin that stays has, and something in each", () => {
    const [old, recent] = cards();
    expect(cardsProblem([old, { ...recent, version: "4.16.27" }], true)).toBe("OCP 4.20.9: OCP 4.16.27 is pinned already");
    expect(cardsProblem([{ ...old, removed: true }, { ...recent, version: "4.16.27" }], true)).toBeNull();
    expect(cardsProblem([old, { ...recent, revision: "", values: {}, operator: NO_SETTINGS }], true)).toBe(
      "OCP 4.20.9: A pin needs a chart revision, values or operator settings",
    );
    const fresh = withNewCard([]);
    expect(cardsProblem(fresh, false)).toBe("The new pin: Give the OpenShift version");
    expect(cardsProblem([{ ...fresh[0], version: "4.16" }], false)).toContain("OCP 4.16: A pin is keyed by the full version");
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
