import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "@/types";
import { addonKey, availableAddons } from "./addon-transfer";

const entry = (team: string, name: string) => ({ team, name, current_version: "HEAD", available_versions: [] }) as unknown as CatalogEntry;

const CATALOG = [
  entry("platform", "cert-manager"),
  entry("observability", "prometheus"),
  entry("platform", "external-secrets"),
  entry("platform", "trust-manager"),
  entry("observability", "grafana"),
];

const names = (teams: { team: string; addons: CatalogEntry[] }[]) => teams.map((t) => [t.team, t.addons.map((a) => a.name)]);
const pick = (team: string, name: string) => ({ team, name, version: "HEAD", overrideable: [] });

describe("availableAddons", () => {
  it("is the catalog by team, teams by name and add-ons in the catalog's order", () => {
    const { teams, count } = availableAddons(CATALOG, []);
    expect(names(teams)).toEqual([
      ["observability", ["prometheus", "grafana"]],
      ["platform", ["cert-manager", "external-secrets", "trust-manager"]],
    ]);
    expect(count).toBe(5);
  });

  it("leaves out a selected add-on and counts it as added", () => {
    const { teams, count } = availableAddons(CATALOG, [pick("platform", "external-secrets")]);
    expect(names(teams)[1]).toEqual(["platform", ["cert-manager", "trust-manager"]]);
    expect(teams[1].added).toBe(1);
    expect(teams[0].added).toBe(0);
    expect(count).toBe(4);
  });

  it("puts a removed add-on back in its place, whatever order the selection had", () => {
    const selected = [pick("platform", "trust-manager"), pick("platform", "external-secrets"), pick("platform", "cert-manager")];
    const removed = selected.filter((a) => a.name !== "external-secrets");
    expect(names(availableAddons(CATALOG, removed).teams)[1]).toEqual(["platform", ["external-secrets"]]);
    expect(names(availableAddons(CATALOG, []).teams)[1]).toEqual(["platform", ["cert-manager", "external-secrets", "trust-manager"]]);
  });

  it("keeps a team whose add-ons are all selected, with none left", () => {
    const { teams, count } = availableAddons(CATALOG, [pick("observability", "grafana"), pick("observability", "prometheus")]);
    expect(teams[0]).toEqual({ team: "observability", addons: [], added: 2 });
    expect(count).toBe(3);
  });

  it("narrows to a search on the add-on's or the team's name, trimmed and in any case", () => {
    expect(names(availableAddons(CATALOG, [], "  MANAGER ").teams)).toEqual([["platform", ["cert-manager", "trust-manager"]]]);
    expect(names(availableAddons(CATALOG, [], "observ").teams)).toEqual([["observability", ["prometheus", "grafana"]]]);
    expect(availableAddons(CATALOG, [], "nothing").teams).toEqual([]);
  });

  it("counts what the search leaves, and a selected match as added", () => {
    const { teams, count } = availableAddons(CATALOG, [pick("platform", "cert-manager")], "manager");
    expect(names(teams)).toEqual([["platform", ["trust-manager"]]]);
    expect(teams[0].added).toBe(1);
    expect(count).toBe(1);
  });

  it("ignores a selected add-on the catalog does not have", () => {
    expect(availableAddons(CATALOG, [pick("security", "kyverno")]).count).toBe(5);
  });
});

describe("addonKey", () => {
  it("names an add-on by its team and chart", () => {
    expect(addonKey({ team: "platform", name: "cert-manager" })).toBe("platform/cert-manager");
  });
});
