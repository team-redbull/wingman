import { describe, expect, it } from "vitest";
import { labelledZone, ownZone, withZoneLabel, ZONE_LABEL, zoneLabelProblem } from "./zone-labels";

const HEAD = `owner:
  merkaz: "1"
mastertag: 4.18.22-x86_64
nodepool:
- infraEnvName: r760-mtl-az1
  name: r760-mtl-az1
  replicas: 2
`;
const TAIL = "vlanId: 1412\n# === Added by CI ===\nmcFiles: []\n";
const file = (added: string) => `${HEAD}${added}${TAIL}`;

describe("a new NodePool's zone label", () => {
  it("is its InfraEnv's zone under the convention, and none off it", () => {
    expect(ownZone("r760-mtl-az3")).toBe("az3");
    expect(ownZone("dell-r660-site1-128c-1024gb-5tb")).toBeNull();
    expect(ownZone(null)).toBeNull();
    expect(labelledZone({ nodeLabels: { [ZONE_LABEL]: "az1", tier: "gpu" } })).toBe("az1");
    expect(labelledZone({ nodeLabels: { tier: "gpu" } })).toBeNull();
    expect(labelledZone({})).toBeNull();
  });

  it("says what is missing or wrong", () => {
    expect(zoneLabelProblem("r760-mtl-az3", null)).toBe(`A new NodePool labels its Nodes with its zone: add ${ZONE_LABEL}: az3 to its nodeLabels`);
    expect(zoneLabelProblem("r760-mtl-az3", "az1")).toBe(`Its nodeLabels give ${ZONE_LABEL}: az1, but its zone is az3`);
    expect(zoneLabelProblem("r760-mtl-az3", "az3")).toBeNull();
    expect(zoneLabelProblem("dell-r660-site1-128c-1024gb-5tb", null)).toBeNull();
  });
});

describe("withZoneLabel", () => {
  it("adds a nodeLabels line at the end of an entry without one, as the template writes it", () => {
    const text = file("- infraEnvName: r760-mtl-az3\n  name: r760-mtl-az3\n  replicas: 1  # the new one\n\n");
    expect(withZoneLabel(text, 1, "az3")).toBe(
      file(`- infraEnvName: r760-mtl-az3\n  name: r760-mtl-az3\n  replicas: 1  # the new one\n  nodeLabels: {"${ZONE_LABEL}": "az3"}\n\n`)
    );
  });

  it("merges it into a flow mapping, every other label kept", () => {
    const text = file('- infraEnvName: r760-mtl-az3\n  nodeLabels: {"tier": "gpu"}  # labels\n  replicas: 1\n');
    expect(withZoneLabel(text, 1, "az3")).toBe(
      file(`- infraEnvName: r760-mtl-az3\n  nodeLabels: {"tier": "gpu", "${ZONE_LABEL}": "az3"}  # labels\n  replicas: 1\n`)
    );
    expect(withZoneLabel(file("- infraEnvName: r760-mtl-az3\n  nodeLabels: {}\n"), 1, "az3")).toBe(
      file(`- infraEnvName: r760-mtl-az3\n  nodeLabels: {"${ZONE_LABEL}": "az3"}\n`)
    );
  });

  it("adds it to a block mapping, or replaces another zone there", () => {
    const block = file("- infraEnvName: r760-mtl-az3\n  nodeLabels:\n    tier: gpu\n  replicas: 1\n");
    expect(withZoneLabel(block, 1, "az3")).toBe(
      file(`- infraEnvName: r760-mtl-az3\n  nodeLabels:\n    tier: gpu\n    ${ZONE_LABEL}: az3\n  replicas: 1\n`)
    );
    const wrong = file(`- infraEnvName: r760-mtl-az3\n  nodeLabels:\n    "${ZONE_LABEL}": az1  # copied\n    tier: gpu\n`);
    expect(withZoneLabel(wrong, 1, "az3")).toBe(wrong.replace(`"${ZONE_LABEL}": az1`, `"${ZONE_LABEL}": az3`));
    const empty = file("- infraEnvName: r760-mtl-az3\n  nodeLabels:\n  replicas: 1\n");
    expect(withZoneLabel(empty, 1, "az3")).toBe(file(`- infraEnvName: r760-mtl-az3\n  nodeLabels:\n    ${ZONE_LABEL}: az3\n  replicas: 1\n`));
  });

  it("leaves a layout it does not edit to the person", () => {
    expect(withZoneLabel(file("- nodeLabels: {}\n  infraEnvName: r760-mtl-az3\n"), 1, "az3")).toBeNull();
    expect(withZoneLabel(file('- infraEnvName: r760-mtl-az3\n  nodeLabels: {"tier":\n    "gpu"}\n'), 1, "az3")).toBeNull();
    expect(withZoneLabel(file("- infraEnvName: r760-mtl-az3\n  nodeLabels: [a]\n"), 1, "az3")).toBeNull();
    expect(withZoneLabel(file(""), 1, "az3")).toBeNull();
    expect(withZoneLabel("a: [", 0, "az3")).toBeNull();
  });
});
