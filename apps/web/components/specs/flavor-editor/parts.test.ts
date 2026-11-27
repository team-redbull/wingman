import { describe, expect, it } from "vitest";
import { addNodepool, newDraft, setNodepoolValue, setRatioOn, setTopValue, type FlavorDraft } from "./model";
import {
  addonsSummary,
  basicsSummary,
  nodepoolSummary,
  nodepoolsSummary,
  poolIndexOf,
  problemCounts,
  readCollapsed,
  sectionOf,
  writeCollapsed,
} from "./parts";

const DEFAULTS = [{ name: "nm-conf", hardware: "dell" }, { name: "workers-chrony-configuration" }];

/** A new flavor of `replicas.length` nodepools, each at its replicas. */
function draftOf(...replicas: unknown[]): FlavorDraft {
  let draft = newDraft(DEFAULTS);
  for (let i = 1; i < replicas.length; i++) draft = addNodepool(draft, DEFAULTS);
  return replicas.reduce<FlavorDraft>((d, r, i) => setNodepoolValue(d, i, "replicas", r), draft);
}

/** A Storage in memory; `broken` throws on every call, as a blocked one does. */
function memoryStorage(broken = false): Storage {
  const items = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => (guard(), items.get(k) ?? null),
    setItem: (k, v) => (guard(), void items.set(k, v)),
    removeItem: (k) => (guard(), void items.delete(k)),
  };
}

describe("where a field is", () => {
  it("is Nodepools for a nodepool's field or the rule's, else Basics", () => {
    expect(sectionOf("nodepools[1].replicas")).toBe("nodepools");
    expect(sectionOf("nodepools[*].configs")).toBe("nodepools");
    expect(sectionOf("metadata.name")).toBe("basics");
    expect(sectionOf("owner_merkaz")).toBe("basics");
  });

  it("names the nodepool of a nodepool's field only", () => {
    expect(poolIndexOf("nodepools[12].configs[0]")).toBe(12);
    expect(poolIndexOf("nodepools[*].tuning_config")).toBeNull();
    expect(poolIndexOf("platform")).toBeNull();
  });

  it("counts problems by part and by nodepool", () => {
    expect(problemCounts(["metadata.name", "nodepools[0].replicas", "nodepools[0].configs", "nodepools[2].configs", "nodepools[*].configs"])).toEqual({
      sections: { basics: 1, nodepools: 4, addons: 0, review: 0 },
      pools: { 0: 2, 2: 1 },
    });
  });
});

describe("a collapsed part's line", () => {
  it("gives Basics' name, version and platform, and says what is missing", () => {
    const draft = { ...newDraft(DEFAULTS), name: "agent-baseline" };
    expect(basicsSummary(draft)).toBe("agent-baseline · v1.0.0");
    expect(basicsSummary(setTopValue(draft, "platform", "kubevirt"))).toBe("agent-baseline · v1.0.0 · KubeVirt");
    expect(basicsSummary({ ...draft, name: " ", version: "" })).toBe("No name yet · no version");
  });

  it("adds up the nodepools' replicas, and says how many are not set", () => {
    expect(nodepoolsSummary(draftOf(3, 6, "3"))).toBe("3 nodepools · 12 replicas");
    expect(nodepoolsSummary(draftOf(1))).toBe("1 nodepool · 1 replica");
    expect(nodepoolsSummary(draftOf(2, undefined, "x"))).toBe("3 nodepools · 2 replicas · 2 not set");
    expect(nodepoolsSummary(draftOf(undefined))).toBe("1 nodepool · replicas not set");
  });

  it("gives the ratio the nodepools grow by, and says when there are none", () => {
    expect(nodepoolsSummary(setRatioOn(draftOf(2, 2), true))).toMatch(/ · ratio 1:1$/);
    expect(nodepoolsSummary({ ...newDraft([]), structure: {}, keys: [] })).toBe("No nodepools: each cluster adds its own");
  });

  it("gives a nodepool's InfraEnv, else its network hardware, its replicas and its machine configs", () => {
    const draft = draftOf(3);
    expect(nodepoolSummary(draft, 0)).toBe("dell · 3 replicas · 2 machine configs");
    expect(nodepoolSummary(setNodepoolValue(draft, 0, "infra_env", "dell-r660-site1"), 0)).toBe("dell-r660-site1 · 3 replicas · 2 machine configs");
    expect(nodepoolSummary(newDraft([]), 0)).toBe("replicas not set · no machine configs");
  });

  it("lists the add-ons in install order", () => {
    const addon = (name: string) => ({ team: "platform", name, version: "HEAD", overrideable: [] });
    expect(addonsSummary(newDraft([]))).toBe("No add-ons");
    expect(addonsSummary({ ...newDraft([]), addons: [addon("cert-manager")] })).toBe("1 add-on: cert-manager");
    expect(addonsSummary({ ...newDraft([]), addons: [addon("b"), addon("a")] })).toBe("2 add-ons: b, a");
  });
});

describe("the parts a viewer collapsed", () => {
  it("are remembered per flavor, in the editor's order, and forgotten when all are open", () => {
    const storage = memoryStorage();
    writeCollapsed(storage, "agent-dell", ["addons", "basics"]);
    expect(readCollapsed(storage, "agent-dell")).toEqual(["basics", "addons"]);
    expect(readCollapsed(storage, "agent-other")).toEqual([]);
    writeCollapsed(storage, "agent-dell", []);
    expect(storage.length).toBe(0);
  });

  it("are none when the stored value is not a list of parts, or storage cannot be used", () => {
    const storage = memoryStorage();
    storage.setItem("wingman:flavor-editor:collapsed:x", "{not json");
    expect(readCollapsed(storage, "x")).toEqual([]);
    storage.setItem("wingman:flavor-editor:collapsed:x", JSON.stringify(["review", "nodepools", 3]));
    expect(readCollapsed(storage, "x")).toEqual(["nodepools"]);
    expect(readCollapsed(undefined, "x")).toEqual([]);
    expect(readCollapsed(memoryStorage(true), "x")).toEqual([]);
    expect(() => writeCollapsed(memoryStorage(true), "x", ["basics"])).not.toThrow();
  });
});
