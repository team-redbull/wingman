import { describe, expect, it } from "vitest";
import type { NodeType } from "@/types";
import { logicalPools } from "./logical-pools";
import { formNameProblems } from "./nodepool-names";
import { placementNeeds } from "./placement";
import {
  chooseNodeType,
  setZoneReplicas,
  spreadOverZones,
  withPool,
  withZoneInfraEnvs,
  zonedRequest,
  zoneInfraEnvs,
  zoneProblems,
  zoneValue,
} from "./zone-form";

const R760: NodeType = {
  name: "r760-mtl",
  zones: ["az1", "az2", "az3"].map((zone) => ({ zone, infra_env: `r760-mtl-${zone}` })),
};
const G12: NodeType = { name: "g12-mtl", zones: [{ zone: "az1", infra_env: "g12-mtl-az1" }] };
const TYPES = [G12, R760];
const CONFIGS = [{ name: "worker-kubeletconfig-reserved" }];
const free = { fixed: () => false, locked: () => false };

describe("a logical nodepool on the create form", () => {
  it("is picked by node type: its zones start at the nodepool's replicas", () => {
    const pool = chooseNodeType({ infra_env: "old", replicas: 2, zone_replicas: { x: 1 } }, "r760-mtl", TYPES);
    expect(pool).toEqual({ infra_env: "", replicas: 2, node_type: "r760-mtl" });
    expect(zoneValue(pool, "r760-mtl-az2", false)).toBe(2);
    const set = setZoneReplicas(pool, "r760-mtl-az2", 0);
    expect(zoneValue(set, "r760-mtl-az2", false)).toBe(0);
    expect(zoneValue(set, "r760-mtl-az2", true)).toBe(2);
  });

  it("in one zone is that zone's InfraEnv, one NodePool as before", () => {
    expect(chooseNodeType({ replicas: 2 }, "g12-mtl", TYPES)).toEqual({ replicas: 2, node_type: "g12-mtl", infra_env: "g12-mtl-az1" });
    const sent = zonedRequest({ nodepools: [{ node_type: "g12-mtl", infra_env: "", replicas: 3 }] }, TYPES, free);
    expect(sent.nodepools).toEqual([{ infra_env: "g12-mtl-az1", replicas: 3 }]);
  });

  it("is sent as its config, its node type and every zone's replicas, a zone at 0 included", () => {
    const pool = setZoneReplicas({ node_type: "r760-mtl", infra_env: "", replicas: 2, configs: CONFIGS, name_suffix: "gpu" }, "r760-mtl-az2", 0);
    const sent = zonedRequest({ owner_anaf: "56", nodepools: [pool, { infra_env: "dell-a", replicas: 1 }] }, TYPES, free);
    expect(sent.nodepools).toEqual([
      {
        configs: CONFIGS,
        name_suffix: "gpu",
        node_type: "r760-mtl",
        zones: [
          { infra_env: "r760-mtl-az1", replicas: 2 },
          { infra_env: "r760-mtl-az2", replicas: 0 },
          { infra_env: "r760-mtl-az3", replicas: 2 },
        ],
      },
      { infra_env: "dell-a", replicas: 1 },
    ]);
    expect(placementNeeds(sent.nodepools)).toEqual(["r760-mtl-az1:2", "r760-mtl-az3:2", "dell-a:1"]);
  });

  it("under a ratio or a lock has the nodepool's replicas in every zone, and a lock sends them", () => {
    const pool = setZoneReplicas({ node_type: "r760-mtl", replicas: 4 }, "r760-mtl-az1", 9);
    const sent = zonedRequest({ nodepools: [pool] }, TYPES, { fixed: () => true, locked: () => true });
    expect(sent.nodepools).toEqual([
      { replicas: 4, node_type: "r760-mtl", zones: R760.zones.map((z) => ({ infra_env: z.infra_env, replicas: 4 })) },
    ]);
  });

  it("is one NodePool without the MCE's list, or on a flavor's older InfraEnv until it is spread", () => {
    const typed = zonedRequest({ nodepools: [{ node_type: "r760-mtl", infra_env: "r760-mtl-az1", replicas: 2 }] }, null, free);
    expect(typed.nodepools).toEqual([{ infra_env: "r760-mtl-az1", replicas: 2 }]);
    expect(spreadOverZones({ infra_env: "r760-mtl-az2", replicas: 2 }, TYPES)).toEqual({ infra_env: "", replicas: 2, node_type: "r760-mtl" });
  });

  it("names a NodePool per zone, finds a clash, and fills the required InfraEnv", () => {
    const form = { nodepools: [{ node_type: "r760-mtl" }, { infra_env: "r760-mtl-az2" }] };
    expect(zoneInfraEnvs(form.nodepools[0], TYPES)).toEqual(R760.zones.map((z) => z.infra_env));
    expect(formNameProblems(form.nodepools, (p) => zoneInfraEnvs(p, TYPES))).toEqual({
      1: "Nodepool 1 is named r760-mtl-az2 already: give one of them another suffix",
    });
    expect((withZoneInfraEnvs(form, TYPES).nodepools as Record<string, unknown>[])[0].infra_env).toBe("r760-mtl-az1");
    expect(withPool(form, 1, { infra_env: "x" }).nodepools[1]).toEqual({ infra_env: "x" });
  });

  it("stops the review for a node type the MCE lacks, a zone's bad replicas, or none at all", () => {
    const form = {
      nodepools: [
        { node_type: "c200-mtl" },
        setZoneReplicas({ node_type: "r760-mtl", replicas: 1 }, "r760-mtl-az3", "x"),
        { node_type: "r760-mtl", replicas: 0 },
        { node_type: "r760-mtl", replicas: 1 },
      ],
    };
    expect(zoneProblems(form, TYPES, () => false)).toEqual({
      0: "This MCE has no node type c200-mtl: pick one it has",
      1: "az3: replicas are a whole number of at least 0",
      2: "Every zone has 0 replicas: give one at least a replica",
    });
    expect(zoneProblems(form, null, () => false)).toEqual({});
  });
});

describe("a cluster file's NodePools", () => {
  const read = (e: { name?: string; infraEnvName?: string }) => ({ name: e.name, infraEnv: e.infraEnvName });

  it("group by node type and suffix, read from their names, where the first of each is", () => {
    const entries = [
      ...R760.zones.map((z) => ({ infraEnvName: z.infra_env, name: `${z.infra_env}-gpu` })),
      { infraEnvName: "g12-mtl-az1" },
      ...R760.zones.map((z) => ({ infraEnvName: z.infra_env, name: z.infra_env })),
      { infraEnvName: "dell-a", name: "prod-heron-site1-dell-b" },
    ];
    const pools = logicalPools(entries, read, TYPES);
    expect(pools.map((p) => [p.nodeType, p.suffix, p.members.map((m) => [m.index, m.zone])])).toEqual([
      ["r760-mtl", "gpu", [[0, "az1"], [1, "az2"], [2, "az3"]]],
      ["g12-mtl", "", [[3, "az1"]]],
      ["r760-mtl", "", [[4, "az1"], [5, "az2"], [6, "az3"]]],
      [null, "", [[7, null]]],
    ]);
  });
});
