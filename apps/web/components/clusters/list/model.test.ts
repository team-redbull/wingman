import { describe, expect, it } from "vitest";
import type { ClusterStatus } from "@/types";
import { compareBy, compareOwner, countBy, filterOf, matchesSearch, mceFacet, sortRows } from "./model";

const cluster = (over: Partial<ClusterStatus>): ClusterStatus =>
  ({ name: "ocp4-prod-a-site1", site: "site1", mce: "mce-prod-1", spec_name: null, mastertag: null, created_at: null, ...over }) as ClusterStatus;

describe("the clusters list model", () => {
  it("finds a cluster by any of its columns, owner numbers included", () => {
    const c = cluster({ spec_name: "Web", mastertag: "4.18.22", owner: { merkaz: "12", anaf: "", mador: "345" } });
    for (const q of ["prod-a", "site1", "mce-prod", "web", "4.18", "345"]) expect(matchesSearch(c, q)).toBe(true);
    expect(matchesSearch(c, "lab")).toBe(false);
  });

  it("sorts mastertags as numbers and puts a cluster without an owner number last", () => {
    const older = cluster({ mastertag: "4.9.1" });
    const newer = cluster({ mastertag: "4.18.0" });
    expect(compareBy("mastertag", older, newer)).toBeLessThan(0);
    expect(compareOwner("", "7")).toBe(1);
    expect(compareOwner("10", "9")).toBeGreaterThan(0);
  });

  it("counts an update and an open update MR under one filter", () => {
    expect(filterOf("update_available")).toBe("update");
    expect(filterOf("update_mr_open")).toBe("update");
    expect(filterOf("drifted")).toBe("drifted");
    expect([...countBy(["a", "b", "a"], (x) => x)]).toEqual([["a", 2], ["b", 1]]);
  });

  it("offers each MCE the rows are on, with its site and count, by site and name, and only the site's when one is picked", () => {
    const rows = [
      cluster({ site: "site2", mce: "ocp4-prod-mce-site2-a" }),
      cluster({ mce: "ocp4-prod-mce-site1-b" }),
      cluster({ mce: "ocp4-prod-mce-site1-a" }),
      cluster({ mce: "ocp4-prod-mce-site1-a" }),
      cluster({ mce: "ocp4-prod-mce-site1-a" }),
    ];
    expect(mceFacet(rows, null)).toEqual([
      { mce: "ocp4-prod-mce-site1-a", site: "site1", count: 3 },
      { mce: "ocp4-prod-mce-site1-b", site: "site1", count: 1 },
      { mce: "ocp4-prod-mce-site2-a", site: "site2", count: 1 },
    ]);
    expect(mceFacet(rows, "site2")).toEqual([{ mce: "ocp4-prod-mce-site2-a", site: "site2", count: 1 }]);
    expect(mceFacet(rows, "site3")).toEqual([]);
  });

  it("offers no MCE for a viewer's rows, which have none (ADR-0068)", () => {
    expect(mceFacet([cluster({ mce: null }), cluster({ mce: null })], null)).toEqual([]);
  });

  it("orders the rows by a column, within each owner group when grouped", () => {
    const a = cluster({ name: "a", owner: { merkaz: "2", anaf: "", mador: "" } });
    const b = cluster({ name: "b", owner: { merkaz: "1", anaf: "", mador: "" } });
    const c = cluster({ name: "c", owner: { merkaz: "2", anaf: "", mador: "" } });
    expect(sortRows([c, a, b], "none", "name", "asc").map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(sortRows([c, a, b], "merkaz", "name", "desc").map((r) => r.name)).toEqual(["b", "c", "a"]);
  });
});
