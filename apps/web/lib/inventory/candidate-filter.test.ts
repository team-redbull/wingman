import { describe, expect, it } from "vitest";
import type { Candidate } from "@/types/inventory";
import {
  NO_CANDIDATE_FILTER, addableCount, candidateFacets, filterCandidates, hiddenChosen, isFiltering, withShown,
  type CandidateFilter,
} from "./candidate-filter";

const candidate = (name: string, overrides: Partial<Candidate> = {}): Candidate => ({
  id: `srv_${name}`, name, vendor: "dell", model: "PowerEdge R650", health: "HEALTHY", lock: null,
  offered: true, why_not: null, ready: true, health_problems: [], ...overrides,
});
const sick = (name: string) => candidate(name, { health: "CRITICAL", ready: false, health_problems: ["health CRITICAL", "BMC unreachable"] });
const locked = (name: string) => candidate(name, { offered: false, ready: false, why_not: "in maintenance" });
const hp = (name: string) => candidate(name, { vendor: "hpe", model: "ProLiant DL380 Gen11" });

const SERVERS = [candidate("ocp-r650-mtl-site1-aa01"), sick("ocp-r650-mtl-site1-aa02"), locked("ocp-r650-mtl-site1-aa03"), hp("ocp-r650-mtl-site1-bb04")];
const names = (found: Candidate[]) => found.map((c) => c.name.slice(-4));
const filter = (overrides: Partial<CandidateFilter>): CandidateFilter => ({ ...NO_CANDIDATE_FILTER, ...overrides });

describe("the picker's filters", () => {
  it("keep every server with none set", () => {
    expect(isFiltering(NO_CANDIDATE_FILTER)).toBe(false);
    expect(names(filterCandidates(SERVERS, NO_CANDIDATE_FILTER, []))).toEqual(["aa01", "aa02", "aa03", "bb04"]);
  });

  it("search each word in the name, the hardware and why a server needs a fix or is not offered, ignoring case", () => {
    expect(names(filterCandidates(SERVERS, filter({ search: "AA0" }), []))).toEqual(["aa01", "aa02", "aa03"]);
    expect(names(filterCandidates(SERVERS, filter({ search: "bmc" }), []))).toEqual(["aa02"]);
    expect(names(filterCandidates(SERVERS, filter({ search: "maintenance" }), []))).toEqual(["aa03"]);
    expect(names(filterCandidates(SERVERS, filter({ search: "proliant  bb" }), []))).toEqual(["bb04"]);
    expect(names(filterCandidates(SERVERS, filter({ search: "proliant aa" }), []))).toEqual([]);
    expect(isFiltering(filter({ search: "   " }))).toBe(false);
  });

  it("narrow by group, hardware and the chosen ones, together", () => {
    expect(names(filterCandidates(SERVERS, filter({ group: "ready" }), []))).toEqual(["aa01", "bb04"]);
    expect(names(filterCandidates(SERVERS, filter({ group: "ready", hardware: "dell PowerEdge R650" }), []))).toEqual(["aa01"]);
    expect(names(filterCandidates(SERVERS, filter({ chosenOnly: true }), ["ocp-r650-mtl-site1-aa02"]))).toEqual(["aa02"]);
  });

  it("offer the groups in the list's order and the hardware most servers first, each with its count", () => {
    const facets = candidateFacets(SERVERS);
    expect(facets.groups.map((g) => [g.label, g.count])).toEqual([["Ready", 2], ["Needs fix", 1], ["Not offered", 1]]);
    expect(facets.hardware.map((h) => [h.value, h.count])).toEqual([["dell PowerEdge R650", 3], ["hpe ProLiant DL380 Gen11", 1]]);
    expect(candidateFacets([candidate("a")]).groups.map((g) => g.value)).toEqual(["ready"]);
  });
});

describe("picking the servers shown", () => {
  it("adds the shown ones that can be picked, after those chosen, never a server that is not offered", () => {
    expect(withShown(["x"], SERVERS, 20)).toEqual(["x", "ocp-r650-mtl-site1-aa01", "ocp-r650-mtl-site1-aa02", "ocp-r650-mtl-site1-bb04"]);
    expect(addableCount(["ocp-r650-mtl-site1-aa01"], SERVERS, 20)).toBe(2);
  });

  it("stops at the most one install takes", () => {
    expect(withShown(["x", "y"], SERVERS, 3)).toEqual(["x", "y", "ocp-r650-mtl-site1-aa01"]);
    expect(addableCount(["x", "y", "z"], SERVERS, 3)).toBe(0);
  });

  it("counts the chosen servers the filters hide", () => {
    const shown = filterCandidates(SERVERS, filter({ group: "ready" }), []);
    expect(hiddenChosen(["ocp-r650-mtl-site1-aa01", "ocp-r650-mtl-site1-aa02"], shown)).toBe(1);
  });
});
