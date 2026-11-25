/**
 * The install dialog's server picker over a long list (mocked; ADR-0057's
 * 2026-11-25 amendment): a search on the name, the hardware and why a server
 * is held back; the status and hardware pills; the chosen ones only; picking
 * every server shown, never one that is not offered and never past the most
 * one install takes; and the dialog wide enough to read the list.
 */

import { test, expect, type Page } from "@playwright/test";
import { go } from "../fixtures/api-handlers";
import { R650, R650_NAMES, SITE1_A, setUpInventory } from "../fixtures/inventory";
import type { Candidate, Candidates } from "../../types/inventory";

const server = (n: number, overrides: Partial<Candidate> = {}): Candidate => ({
  id: `srv_${n}`, name: `${R650_NAMES}fch${String(n).padStart(4, "0")}`, vendor: "dell", model: "PowerEdge R650",
  health: "HEALTHY", lock: null, offered: true, why_not: null, ready: true, health_problems: [], ...overrides,
});
const name = (n: number) => server(n).name;

/** 30 servers: 20 Dell ready, 6 HPE ready, 2 needing a fix, 2 in maintenance. */
const MANY: Candidates = {
  mce: SITE1_A,
  infra_env: R650,
  server_prefix: R650_NAMES,
  label_problems: [],
  candidates: [
    ...Array.from({ length: 20 }, (_, i) => server(i + 1)),
    ...Array.from({ length: 6 }, (_, i) => server(i + 21, { vendor: "hpe", model: "ProLiant DL380 Gen11" })),
    server(27, { health: "CRITICAL", ready: false, health_problems: ["health CRITICAL", "BMC unreachable"] }),
    server(28, { health: "MAJOR", ready: false, health_problems: ["health MAJOR"] }),
    server(29, { offered: false, ready: false, why_not: "in maintenance" }),
    server(30, { offered: false, ready: false, why_not: "in maintenance" }),
  ],
};

const dialog = (page: Page) => page.getByTestId("add-servers-dialog");
const listed = (page: Page) => dialog(page).getByTestId("candidate");

async function openPicker(page: Page) {
  const calls = await setUpInventory(page, { candidates: MANY });
  await go(page, "/inventory");
  await page.locator(`section[data-mce="${SITE1_A}"] tr[data-pool="${R650}"]`).getByRole("button", { name: `Install servers into ${R650}` }).click();
  await dialog(page).getByRole("tab", { name: "Choose servers" }).click();
  await expect(listed(page)).toHaveCount(30);
  return calls;
}

test.describe("Choosing servers from a long list", () => {
  test("the dialog uses the screen's width", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPicker(page);
    const box = await dialog(page).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(800);
  });

  test("a search narrows by name, hardware or problem; Escape clears it and leaves the dialog open", async ({ page }) => {
    await openPicker(page);
    const search = dialog(page).getByRole("searchbox", { name: "Search the servers" });
    await search.fill("fch001");
    await expect(listed(page)).toHaveCount(10);
    await expect(dialog(page).getByTestId("candidate-count")).toHaveText("10 of 30 servers");
    await search.fill("proliant");
    await expect(listed(page)).toHaveCount(6);
    await search.fill("bmc");
    await expect(listed(page)).toHaveCount(1);
    await search.fill("nothing-like-this");
    await expect(dialog(page).getByTestId("candidates-none-shown")).toBeVisible();
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(dialog(page)).toBeVisible();
    await expect(listed(page)).toHaveCount(30);
  });

  test("the status and hardware pills narrow together, each with its count", async ({ page }) => {
    await openPicker(page);
    await expect(dialog(page).getByTestId("candidate-group-filter-ready")).toContainText("26");
    await dialog(page).getByTestId("candidate-group-filter-needs-fix").click();
    await expect(listed(page)).toHaveCount(2);
    await dialog(page).getByTestId("candidate-group-filter-ready").click();
    await dialog(page).getByTestId("candidate-hardware-hpe ProLiant DL380 Gen11").click();
    await expect(listed(page)).toHaveCount(6);
  });

  test("picking the shown servers takes only those that can be picked, then the chosen-only view shows them", async ({ page }) => {
    await openPicker(page);
    await dialog(page).getByRole("searchbox", { name: "Search the servers" }).fill("maintenance");
    await expect(dialog(page).getByRole("button", { name: "Pick the shown" })).toBeDisabled();
    await dialog(page).getByRole("searchbox", { name: "Search the servers" }).fill("proliant");
    await dialog(page).getByRole("button", { name: "Pick the 6 shown" }).click();
    await expect(dialog(page).getByRole("button", { name: "Install 6" })).toBeEnabled();
    await dialog(page).getByRole("searchbox", { name: "Search the servers" }).fill("");
    await dialog(page).getByTestId("candidate-chosen-only").click();
    await expect(listed(page)).toHaveCount(6);
    await dialog(page).getByTestId("candidate-chosen-only").click();
    await dialog(page).getByTestId("candidate-group-filter-needs-fix").click();
    await expect(dialog(page).getByTestId("candidate-hidden-chosen")).toHaveText("6 chosen servers are hidden by the filters");
  });

  test("never past the most one install takes, and Unpick all clears the choice", async ({ page }) => {
    const calls = await openPicker(page);
    await dialog(page).getByRole("checkbox", { name: `Install ${name(1)}` }).click();
    await dialog(page).getByRole("button", { name: "Pick the first 19 shown" }).click();
    await expect(dialog(page).getByRole("button", { name: "Install 20" })).toBeEnabled();
    await expect(dialog(page).getByRole("button", { name: "Pick the shown" })).toBeDisabled();
    await dialog(page).getByRole("button", { name: "Unpick all" }).click();
    await expect(dialog(page).getByRole("button", { name: "Install", exact: true })).toBeDisabled();
    await dialog(page).getByRole("searchbox", { name: "Search the servers" }).fill("fch0021");
    await dialog(page).getByRole("checkbox", { name: `Install ${name(21)}` }).click();
    await dialog(page).getByRole("button", { name: "Install 1" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(calls.starts).toEqual([{ server_names: [name(21)] }]);
  });
});
