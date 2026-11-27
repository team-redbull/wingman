import { describe, expect, it } from "vitest";
import { clusterHref, clusterQuery, clustersHref, listPlaceOf, placeOf, withListPlace } from "./clusters";

const MCE = "ocp4-prod-mce-site1-a";

describe("a cluster's link and reads (ADR-0068)", () => {
  it("pin an admin's cluster by its site and MCE", () => {
    expect(clusterHref({ name: "ocp4-prod-lark-site1", site: "site1", mce: MCE })).toBe(
      `/clusters/ocp4-prod-lark-site1?site=site1&mce=${MCE}`
    );
    expect(clusterQuery("site1", MCE)).toBe(`?site=site1&mce=${MCE}`);
  });

  it("are a viewer's cluster's name alone: it has no MCE, and day1 finds it by its name", () => {
    expect(clusterHref({ name: "ocp4-prod-lark-site1", site: "site1", mce: null })).toBe("/clusters/ocp4-prod-lark-site1");
    expect(clusterQuery("site1", null)).toBe("");
    expect(clusterQuery("site1", "")).toBe("");
  });

  it("say where a cluster is: the site and MCE for an admin, the site for a viewer", () => {
    expect(placeOf({ site: "site1", mce: MCE })).toBe(`site1 / ${MCE}`);
    expect(placeOf({ site: "site1", mce: null })).toBe("site1");
  });
});

describe("the clusters list's site and MCE in the URL", () => {
  const at = (search: string, hash = "") => ({ pathname: "/clusters", search, hash });

  it("reads ?site= and ?mce=; a missing or blank one is every one", () => {
    expect(listPlaceOf(`?site=site1&mce=${MCE}`)).toEqual({ site: "site1", mce: MCE });
    expect(listPlaceOf(`?upgrade=available&mce=${MCE}`)).toEqual({ site: null, mce: MCE });
    expect(listPlaceOf("")).toEqual({ site: null, mce: null });
    expect(listPlaceOf("?site=%20&mce=")).toEqual({ site: null, mce: null });
  });

  it("writes them, keeping the rest of the URL, and every site or MCE leaves no trace", () => {
    expect(withListPlace(at(""), { site: "site1", mce: MCE })).toBe(`/clusters?site=site1&mce=${MCE}`);
    expect(withListPlace(at("?upgrade=upgrading", "#top"), { site: null, mce: MCE })).toBe(
      `/clusters?upgrade=upgrading&mce=${MCE}#top`
    );
    expect(withListPlace(at(`?site=site1&mce=${MCE}&upgrade=available`), { site: "site2", mce: null })).toBe(
      "/clusters?site=site2&upgrade=available"
    );
    expect(withListPlace(at(`?site=site1&mce=${MCE}`), { site: null, mce: null })).toBe("/clusters");
  });

  it("links to one MCE's clusters, and reads back what it wrote", () => {
    const href = clustersHref({ site: "site 1", mce: MCE });
    expect(href).toBe(`/clusters?site=site+1&mce=${MCE}`);
    expect(listPlaceOf(href.slice(href.indexOf("?")))).toEqual({ site: "site 1", mce: MCE });
    expect(clustersHref({ site: null, mce: null })).toBe("/clusters");
  });
});
