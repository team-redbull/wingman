/**
 * The clusters list's MCE filter, and Customer MCEs' cluster counts that open
 * it (mocked; ADR-0018's 2026-11-27 amendment). The MCEs offered are the
 * Site filter's, each with its count; the site and the MCE are kept in the
 * URL (`?site=&mce=`), so a reload keeps them and a link opens them; a site
 * that lacks the MCE drops it; an MCE no cluster is on says so; Clear filters
 * clears both. A viewer's rows have no MCE: no filter, and the URL's is
 * ignored.
 */

import { test, expect, type Page } from "@playwright/test";
import { MCES, openOverview, SITE1_A, SITE1_B, SITE2_A, UPGRADES_OFF } from "../fixtures/overview";
import { json } from "../fixtures/api-handlers";

const rows = (page: Page) => page.locator("[data-testid^=cluster-row-]");
const mceFilter = (page: Page) => page.getByTestId("mce-filter");
const sitePill = (page: Page, site: string) =>
  page.getByRole("group", { name: "Site filters" }).getByRole("button", { name: site, exact: true });

async function pickMce(page: Page, mce: string) {
  await mceFilter(page).click();
  await page.getByRole("option").filter({ hasText: mce }).click();
}

test.describe("The clusters list's MCE filter", () => {
  test("offers each MCE with its count, by site, and narrows the list; a reload keeps it", async ({ page }) => {
    await openOverview(page, { clusters: UPGRADES_OFF, path: "/clusters" });
    await expect(rows(page)).toHaveCount(5);
    await expect(mceFilter(page)).toContainText("Any MCE");

    await mceFilter(page).click();
    await expect(page.getByRole("option")).toHaveText([
      "Any MCE",
      `${SITE1_A}3 clusters`,
      `${SITE1_B}1 cluster`,
      `${SITE2_A}1 cluster`,
    ]);
    await expect(page.getByText("site2", { exact: true }).last()).toBeVisible(); // the group's label
    await page.getByRole("option").filter({ hasText: SITE1_A }).click();

    await expect(page).toHaveURL(new RegExp(`/clusters\\?mce=${SITE1_A}$`));
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByTestId("cluster-row-ocp4-prod-wren-site1")).toHaveCount(0);
    await expect(page.getByText("3 of 5 clusters (filtered)")).toBeVisible();

    await page.reload();
    await expect(mceFilter(page)).toContainText(SITE1_A);
    await expect(rows(page)).toHaveCount(3);
  });

  test("follows the Site filter: a site that lacks the MCE drops it, All keeps it, and Clear filters clears both", async ({ page }) => {
    await openOverview(page, { clusters: UPGRADES_OFF, path: `/clusters?mce=${SITE1_A}` });
    await expect(rows(page)).toHaveCount(3);

    await sitePill(page, "site2").click();
    await expect(page).toHaveURL(/\/clusters\?site=site2$/);
    await expect(mceFilter(page)).toContainText("Any MCE");
    await expect(rows(page)).toHaveCount(1);

    await mceFilter(page).click();
    await expect(page.getByRole("option")).toHaveText(["Any MCE", `${SITE2_A}1 cluster`]);
    await page.getByRole("option").filter({ hasText: SITE2_A }).click();
    await expect(page).toHaveURL(new RegExp(`/clusters\\?site=site2&mce=${SITE2_A}$`));

    await sitePill(page, "All").click();
    await expect(page).toHaveURL(new RegExp(`/clusters\\?mce=${SITE2_A}$`));
    await expect(rows(page)).toHaveCount(1);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/clusters$/);
    await expect(mceFilter(page)).toContainText("Any MCE");
    await expect(rows(page)).toHaveCount(5);
  });

  test("Any MCE shows every MCE again, the site kept", async ({ page }) => {
    await openOverview(page, { clusters: UPGRADES_OFF, path: `/clusters?site=site1&mce=${SITE1_B}` });
    await expect(rows(page)).toHaveCount(1);
    await expect(sitePill(page, "site1")).toHaveAttribute("aria-pressed", "true");

    await pickMce(page, "Any MCE");
    await expect(page).toHaveURL(/\/clusters\?site=site1$/);
    await expect(rows(page)).toHaveCount(4);
  });

  test("an MCE no cluster is on says so, and Show every MCE clears it", async ({ page }) => {
    const gone = "ocp4-prod-mce-site9-z";
    await openOverview(page, { clusters: UPGRADES_OFF, path: `/clusters?mce=${gone}` });

    const stale = page.getByTestId("clusters-stale-mce");
    await expect(stale).toContainText(`No clusters on ${gone}`);
    await expect(mceFilter(page)).toContainText(gone);
    await stale.getByRole("button", { name: "Show every MCE" }).click();
    await expect(page).toHaveURL(/\/clusters$/);
    await expect(rows(page)).toHaveCount(5);
  });

  test("a viewer has no MCE filter, and the URL's MCE is ignored", async ({ page }) => {
    const viewerRows = UPGRADES_OFF.map((c) => ({ ...c, mce: null }));
    await openOverview(page, { clusters: viewerRows, viewer: true, path: `/clusters?mce=${SITE1_A}` });

    await expect(rows(page)).toHaveCount(5);
    await expect(mceFilter(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  });
});

test.describe("Customer MCEs' clusters", () => {
  test("a row's cluster count opens its hosted clusters on the list, not Inventory", async ({ page }) => {
    await openOverview(page, { clusters: UPGRADES_OFF, path: "/mces" });

    const link = page.locator(`[data-mce="${SITE1_A}"]`).getByTestId("mce-clusters-link");
    await expect(link).toHaveText("3 clusters");
    await expect(link).toHaveAccessibleName(`3 clusters on ${SITE1_A}`);
    await expect(link).toHaveAttribute("href", `/clusters?site=site1&mce=${SITE1_A}`);
    await link.click();

    await expect(page).toHaveURL(new RegExp(`/clusters\\?site=site1&mce=${SITE1_A}$`));
    await expect(rows(page)).toHaveCount(3);
    await expect(mceFilter(page)).toContainText(SITE1_A);
    await expect(sitePill(page, "site1")).toHaveAttribute("aria-pressed", "true");
  });

  test("the count is reached from the keyboard, and an MCE with no cluster has none to open", async ({ page }) => {
    const empty = { ...MCES[2], name: "ocp4-prod-mce-site2-b", letter: "b", cluster_count: 0 };
    await openOverview(page, {
      clusters: UPGRADES_OFF,
      path: "/mces",
      before: (p) => p.route("**/api/day1/mces", (route) => json(route, [...MCES, empty])),
    });

    const quiet = page.locator(`[data-mce="${empty.name}"]`);
    await expect(quiet.getByTestId("mce-clusters-none")).toHaveText("0 clusters");
    await expect(quiet.getByTestId("mce-clusters-link")).toHaveCount(0);

    const link = page.locator(`[data-mce="${SITE1_B}"]`).getByTestId("mce-clusters-link");
    await expect(link).toHaveText("1 cluster");
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/clusters\\?site=site1&mce=${SITE1_B}$`));
    await expect(rows(page)).toHaveCount(1);
  });

  test("on a phone the count alone is the link, and the row still opens Inventory", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openOverview(page, { clusters: UPGRADES_OFF, path: "/mces" });

    const row = page.locator(`[data-mce="${SITE1_A}"]`);
    const link = row.getByTestId("mce-clusters-link");
    await expect(link).toHaveText("3", { useInnerText: true });
    await expect(link).toHaveAccessibleName(`3 clusters on ${SITE1_A}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // A tap under the name (its env and hub version) is still the row's
    const box = (await row.boundingBox())!;
    const facts = (await row.getByTestId("mce-row-facts").boundingBox())!;
    await row.click({ position: { x: facts.x - box.x + 8, y: facts.y - box.y + facts.height / 2 } });
    await expect(page).toHaveURL(new RegExp(`/inventory\\?mce=${SITE1_A}$`));
  });
});
