import { describe, expect, it } from "vitest";
import type { NodeType } from "@/types";
import {
  describeNodeType, infraEnvsOf, nodeTypeFor, nodeTypeOf, parseInfraEnvName, placedLabel, sizeLabel, splitInfraEnv, zoneLabel, zoneOf,
} from "./node-types";

const LEGACY = "dell-r660-site1-128c-1024gb-5tb";
const R760: NodeType = {
  name: "r760-mtl",
  zones: [
    { zone: "az1", infra_env: "r760-mtl-az1" },
    { zone: "az2", infra_env: "r760-mtl-az2" },
  ],
};
const OLD: NodeType = { name: LEGACY, zones: [{ zone: "az3", infra_env: LEGACY }] };

describe("an InfraEnv's name", () => {
  it("is read as flavor, size and zone under the platform's convention", () => {
    expect(parseInfraEnvName("c200-mtl-az1")).toEqual({ flavor: "c200", size: "mtl", zone: "az1" });
    expect(parseInfraEnvName("c200-kv32-az2")).toEqual({ flavor: "c200", size: "kv32", zone: "az2" });
  });

  it("off the convention is not guessed: the workflows' grammar exactly", () => {
    const off = [LEGACY, "hp-gen12-site1-64c-512gb", "c200-kv-az1", "c200-gpu-az1", "C200-MTL-AZ1", "c200-mtl", "760-mtl-az1", "c200-kv0-az1", "c200-kv032-az1", "c200-mtl-zone1", "c200-mtl-az0"];
    for (const name of off) expect(parseInfraEnvName(name)).toBeNull();
    expect(splitInfraEnv("c200-mtl-zone-a")).toEqual({ nodeType: "c200-mtl-zone-a", zone: null });
  });

  it("keeps a flavor's variant letter: another node type", () => {
    expect(parseInfraEnvName("c200n-mtl-az12")).toEqual({ flavor: "c200n", size: "mtl", zone: "az12" });
    expect(nodeTypeOf("c200d-kv16-az2")).toBe("c200d-kv16");
  });
});

describe("a node type", () => {
  it("is an InfraEnv's name without its zone, or the whole name off the convention", () => {
    expect(splitInfraEnv("r760-mtl-az1")).toEqual({ nodeType: "r760-mtl", zone: "az1" });
    expect(nodeTypeOf("c200-kv32-az2")).toBe("c200-kv32");
    expect(splitInfraEnv(LEGACY)).toEqual({ nodeType: LEGACY, zone: null });
  });

  it("names an InfraEnv in a customer's words", () => {
    expect(placedLabel("r760-mtl-az1")).toBe("r760-mtl · az1");
    expect(placedLabel(LEGACY)).toBe(LEGACY);
    expect(placedLabel(LEGACY, "az3")).toBe(`${LEGACY} · az3`);
    expect(zoneLabel(null)).toBe("one zone");
  });

  it("is found for an InfraEnv by the hub's zones first, then by name", () => {
    expect(nodeTypeFor("r760-mtl-az2", [OLD, R760])).toBe(R760);
    expect(nodeTypeFor(LEGACY, [OLD, R760])).toBe(OLD);
    expect(nodeTypeFor("r760-mtl-az9", [R760])).toBe(R760);
    expect(nodeTypeFor("g12-mtl-az1", [R760])).toBeNull();
    expect(nodeTypeFor("r760-mtl-az1", null)).toBeNull();
  });

  it("says what the convention means: bare metal or a VM's vCPUs, and the zones", () => {
    expect(sizeLabel("mtl")).toBe("bare metal");
    expect(sizeLabel("kv32")).toBe("VM · 32 vCPU");
    expect(describeNodeType(R760)).toBe("bare metal · az1 · az2");
    expect(describeNodeType({ name: "c200-kv32", zones: [{ zone: "az1", infra_env: "c200-kv32-az1" }] })).toBe("VM · 32 vCPU · az1");
    expect(describeNodeType(OLD)).toBe("az3");
    expect(describeNodeType({ name: LEGACY, zones: [{ zone: null, infra_env: LEGACY }] })).toBeUndefined();
  });

  it("gives a zone from the hub when it lists the InfraEnv, else from the name", () => {
    expect(zoneOf(LEGACY, [OLD])).toBe("az3");
    expect(zoneOf(LEGACY)).toBeNull();
    expect(zoneOf("r760-mtl-az4", [R760])).toBe("az4");
    expect(infraEnvsOf([OLD, R760])).toEqual([LEGACY, "r760-mtl-az1", "r760-mtl-az2"]);
  });
});
