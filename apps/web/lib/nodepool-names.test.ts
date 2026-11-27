import { describe, expect, it } from "vitest";
import {
  composeName,
  fileNames,
  followsRule,
  formNameProblems,
  isSuffixPath,
  removedNames,
  renderedName,
  suffixProblem,
  withName,
} from "./nodepool-names";

const ZONE = "c200-mtl-az1";

const BASE = `owner:
  merkaz: "1"
mastertag: 4.18.22-x86_64
nodepool:
- infraEnvName: c200-mtl-az1
  replicas: 2
  labels:
    allowDeletion: false

# storage nodes
- infraEnvName: c200-mtl-az2
  name: prod-lark-site1-storage
  replicas: 1
vlanId: 1412
`;
const ADDED = BASE.replace("vlanId: 1412\n", "- infraEnvName: c200-mtl-az1\n  replicas: 1  # zone a, again\nvlanId: 1412\n");

describe("the rule", () => {
  it("names a NodePool after its InfraEnv, with an optional suffix", () => {
    expect(composeName(ZONE, "")).toBe(ZONE);
    expect(composeName(ZONE, "gpu")).toBe(`${ZONE}-gpu`);
    expect(followsRule(ZONE, ZONE)).toBe(true);
    expect(followsRule(`${ZONE}-2`, ZONE)).toBe(true);
    expect(followsRule(`prod-lark-site1-${ZONE}`, ZONE)).toBe(false);
    expect(followsRule(`${ZONE}-`, ZONE)).toBe(false);
    expect(isSuffixPath("nodepools[2].name_suffix")).toBe(true);
    expect(isSuffixPath("nodepools[2].nodepool_name")).toBe(false);
  });

  it("takes a suffix that ends a DNS label", () => {
    expect(suffixProblem("")).toBeNull();
    expect(suffixProblem("zone-b")).toBeNull();
    for (const bad of ["-b", "b-", "B", "b_c", "b c"]) expect(suffixProblem(bad)).not.toBeNull();
  });
});

describe("the create form", () => {
  it("shows each nodepool's problem before sending", () => {
    const pools = [
      { infra_env: ZONE, name_suffix: "" },
      { infra_env: ZONE, name_suffix: "" },
      { infra_env: ZONE, name_suffix: "b" },
      { infra_env: ZONE, name_suffix: "Bad" },
      { infra_env: ZONE, name_suffix: "x".repeat(51) }, // 12 + 1 + 51
      { infra_env: "", name_suffix: "" },
    ];
    const found = formNameProblems(pools);
    expect(Object.keys(found)).toEqual(["1", "3", "4"]);
    expect(found[1]).toBe(`Nodepool 1 is named ${ZONE} already: give one of them another suffix`);
    expect(found[3]).toMatch(/^Lowercase letters/);
    expect(found[4]).toBe("At most 63 characters (this is 64)");
    expect(formNameProblems(undefined)).toEqual({});
  });
});

describe("a cluster file", () => {
  it("names each NodePool by either shape", () => {
    expect(renderedName({ infraEnvName: ZONE }, "prod-lark-site1")).toBe(`prod-lark-site1-${ZONE}`);
    expect(renderedName({ infraEnvName: ZONE, name: ZONE }, "prod-lark-site1")).toBe(ZONE);
    expect(renderedName({}, "prod-lark-site1")).toBeNull();
  });

  it("marks the NodePools the file had before the edit, and an added one", () => {
    const named = fileNames(ADDED, BASE, "prod-lark-site1");
    expect(named).toEqual([
      { index: 0, infraEnv: ZONE, name: null, rendered: `prod-lark-site1-${ZONE}`, existing: true, labelledZone: null },
      { index: 1, infraEnv: "c200-mtl-az2", name: "prod-lark-site1-storage", rendered: "prod-lark-site1-storage", existing: true, labelledZone: null },
      { index: 2, infraEnv: ZONE, name: null, rendered: `prod-lark-site1-${ZONE}`, existing: false, labelledZone: null },
    ]);
    const added = withName(ADDED, 2, `${ZONE}-b`)!;
    expect(fileNames(added, BASE, "prod-lark-site1")?.[2]).toMatchObject({ name: `${ZONE}-b`, existing: false });
    expect(fileNames("a: [", BASE, "c")).toBeNull();
  });

  it("lists a NodePool the edit removes", () => {
    const renamed = BASE.replace("prod-lark-site1-storage", "c200-mtl-az2");
    expect(removedNames(renamed, BASE, "prod-lark-site1")).toEqual(["prod-lark-site1-storage"]);
    expect(removedNames(BASE, BASE, "prod-lark-site1")).toEqual([]);
  });

  it("writes an added nodepool's name below its InfraEnv, every other line kept", () => {
    const added = withName(ADDED, 2, `${ZONE}-b`)!;
    expect(added).toBe(ADDED.replace("- infraEnvName: c200-mtl-az1\n  replicas: 1", `- infraEnvName: c200-mtl-az1\n  name: ${ZONE}-b\n  replicas: 1`));
    expect(withName(added, 2, ZONE)).toBe(added.replace(`  name: ${ZONE}-b\n`, `  name: ${ZONE}\n`));
    const first = "nodepool:\n- name: x\n  infraEnvName: a\n";
    expect(withName(first, 0, "a")).toBeNull();
    expect(withName("nodepool:\n- replicas: 1\n", 0, "a")).toBeNull();
  });
});
