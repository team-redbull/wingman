import { describe, expect, it } from "vitest";
import type { AddonDrift, AddonInstalls, Day2Install, SyncPreview } from "@/types";
import {
  NO_INSTALLS, day2Ref, hasDay2News, installsSummary, leftToInstall, mayHaveOpened, syncInstalls,
} from "./addon-installs";

const ROLES: AddonDrift = {
  addon_name: "cluster-roles", team: "redbull", reason: "missing", expected_version: "main", override_values: { replicas: 2 },
};
const METRICS: AddonDrift = { ...ROLES, addon_name: "metrics", team: "orca", override_values: {} };
const REDBULL_MR: Day2Install = {
  team: "redbull", iid: 9, title: "[Wingman/Day2] Install addon redbull/cluster-roles on lark", web_url: "https://x/9", charts: ["cluster-roles"],
};

const answer = (overrides: Partial<AddonInstalls>): AddonInstalls => ({ ...NO_INSTALLS, ...overrides });

describe("what day2 answered for a sync's or an import's missing add-ons", () => {
  it("addresses a day2 install MR by its team and iid", () => {
    expect(day2Ref(REDBULL_MR)).toEqual({ repo: "day2", team: "redbull", iid: 9 });
  });

  it("all opened: nothing left, one line", () => {
    const ok = answer({ missing: [ROLES], opened: [REDBULL_MR] });
    expect(hasDay2News(ok)).toBe(true);
    expect(leftToInstall(ok)).toEqual([]);
    expect(installsSummary(ok)).toBe("1 day2 MR opened");
  });

  it("partly refused: what was not opened is left to install by hand", () => {
    const partial = answer({
      missing: [ROLES, METRICS], opened: [REDBULL_MR], failed: ["orca: orca hasn't given Wingman write access"], not_opened: [METRICS],
    });
    expect(leftToInstall(partial)).toEqual([METRICS]);
    expect(mayHaveOpened(partial)).toBe(false);
    expect(installsSummary(partial)).toBe("1 day2 MR opened · 1 add-on not opened");
  });

  it("an unconfirmed install says it may have opened", () => {
    const unconfirmed = answer({ missing: [ROLES], failed: ["redbull: day2 did not confirm it: its merge request may have opened"], not_opened: [ROLES] });
    expect(mayHaveOpened(unconfirmed)).toBe(true);
  });

  it("day2 not answering: not asked, everything left", () => {
    const down = answer({ missing: [ROLES], not_asked: "day2 did not answer: timeout", not_opened: [ROLES] });
    expect(leftToInstall(down)).toEqual([ROLES]);
    expect(installsSummary(down)).toBe("1 add-on missing, day2 not asked");
  });

  it("unknown add-ons: news, but nothing to install", () => {
    const unknown = answer({ not_asked: "day2 did not answer, so missing add-ons are unknown" });
    expect(hasDay2News(unknown)).toBe(true);
    expect(leftToInstall(unknown)).toEqual([]);
    expect(installsSummary(unknown)).toBe("add-ons unknown: day2 did not say what is installed");
  });

  it("nothing missing: no news", () => {
    expect(hasDay2News(NO_INSTALLS)).toBe(false);
    expect(installsSummary(NO_INSTALLS)).toBe("no add-on missing");
  });

  it("a day1 that sends no addons: the preview's, none asked", () => {
    const preview = { addons_to_install: [ROLES], addons_error: null } as unknown as SyncPreview;
    expect(syncInstalls(undefined, preview)).toEqual(answer({ missing: [ROLES], not_opened: [ROLES] }));
    const sent = answer({ missing: [ROLES], opened: [REDBULL_MR] });
    expect(syncInstalls(sent, preview)).toBe(sent);
  });
});
