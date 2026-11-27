/**
 * The flavor editor's collapsible parts and nodepools, and its add-ons
 * transfer list (`/specs/new`, `/specs/<name>/edit`): a part or a nodepool
 * collapses to one line with its problem count, a problem or the step bar
 * opens it again, and an add-on moves from Available to Selected and back
 * to its place. Every API is mocked.
 */

import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { go, injectAdminAuth, mockDashboardApis, mockMachineConfigs } from "../fixtures/api-handlers";
import { catalogEntry } from "../fixtures/addons";
import type { SpecDetail } from "../../types";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const chart = (team: string, name: string) =>
  catalogEntry({ team, name, current_version: "HEAD", available_versions: ["main"], default_values: {} });

/** Two teams; platform's add-ons in this order, which Available keeps. */
const CATALOG = [
  chart("platform", "cert-manager"),
  chart("platform", "external-secrets"),
  chart("platform", "trust-manager"),
  chart("observability", "prometheus"),
];

/** `agent-dell`, one nodepool of 2 replicas and one add-on. */
const AGENT_DELL: SpecDetail = {
  apiVersion: "wingman.io/v1",
  kind: "ClusterSpec",
  metadata: { name: "agent-dell", description: "Dell workers", version: "1.0.0", labels: { platform: "agent" } },
  spec: {
    day1: {
      variables: [],
      structure: { nodepools: [{}] },
      locked_paths: [],
      template: "owner: {}\n",
      values: { nodepools: [{ replicas: 2, configs: [{ name: "nm-conf", hardware: "dell" }, { name: "nic-ring-buffer" }] }] },
    },
    day2: { addons: [{ team: "platform", name: "cert-manager", version: "HEAD", overrideable: [] }] },
  },
  load_error: null,
  load_problems: [],
  warnings: [],
  last_commit_id: "aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa",
};

async function open(page: Page, path: string) {
  await injectAdminAuth(page);
  await mockDashboardApis(page);
  await page.route("**/api/day2/addons", (r) => json(r, CATALOG));
  await page.route("**/api/day1/specs/template", (r) => json(r, "# cluster-template.j2"));
  await page.route("**/api/day1/specs/template/schema**", (r) => json(r, []));
  await page.route("**/api/day1/machine-configs", (r) => json(r, mockMachineConfigs));
  await page.route("**/api/day1/specs/agent-dell", (r) => json(r, AGENT_DELL));
  await go(page, path);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(path.endsWith("/new") ? "New Flavor" : "Edit Flavor");
}

/** A part of the editor, and the button its header is. */
const part = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const toggle = (page: Page, name: string) => part(page, name).getByRole("button", { name, exact: true });
const line = (page: Page, id: string) => page.getByTestId(`part-${id}-line`);

const card = (page: Page, team: string, name: string) => page.getByTestId(`addon-card-${team}-${name}`);
const addButton = (page: Page, team: string, name: string) => card(page, team, name).getByRole("button", { name: "Add", exact: true });
const selected = (page: Page, team: string, name: string) => page.getByTestId(`selected-addon-${team}-${name}`);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not on screen");
  return b;
}

test.describe("Flavor editor: collapsible parts", () => {
  test("every part starts open, and its header collapses it to one line", async ({ page }) => {
    await open(page, "/specs/new");
    for (const name of ["Basics", "Nodepools", "Add-ons"]) await expect(toggle(page, name)).toHaveAttribute("aria-expanded", "true");
    // Review is what a save sends: it has no toggle
    await expect(part(page, "Review").getByRole("button", { name: "Review", exact: true })).toHaveCount(0);

    await page.getByTestId("spec-name-input").fill("agent-baseline");
    await page.getByTestId("nodepool-0").getByRole("textbox", { name: "Replicas" }).fill("3");

    await toggle(page, "Basics").click();
    await expect(toggle(page, "Basics")).toHaveAttribute("aria-expanded", "false");
    await expect(line(page, "basics")).toHaveText("agent-baseline · v1.0.0");
    await expect(page.getByTestId("spec-name-input")).toBeHidden();

    await toggle(page, "Nodepools").click();
    await expect(line(page, "nodepools")).toHaveText("1 nodepool · 3 replicas");
    await toggle(page, "Add-ons").click();
    await expect(line(page, "addons")).toHaveText("No add-ons");

    // Open again, as it was
    await toggle(page, "Basics").press("Enter");
    await expect(page.getByTestId("spec-name-input")).toHaveValue("agent-baseline");
    await expect(line(page, "basics")).toHaveText(/^What the flavor is/);
  });

  test("Collapse all and Expand all, and the step bar opens a collapsed part and goes to it", async ({ page }) => {
    await open(page, "/specs/new");
    const nav = page.getByRole("navigation", { name: "Flavor parts" });
    await nav.getByRole("button", { name: "Collapse all" }).click();
    for (const name of ["Basics", "Nodepools", "Add-ons"]) await expect(toggle(page, name)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("addons-available")).toBeHidden();

    await nav.getByRole("button", { name: /Add-ons$/ }).click();
    await expect(toggle(page, "Add-ons")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("addons-available")).toBeInViewport();
    await expect(toggle(page, "Basics")).toHaveAttribute("aria-expanded", "false");

    await nav.getByRole("button", { name: "Expand all" }).click();
    for (const name of ["Basics", "Nodepools", "Add-ons"]) await expect(toggle(page, name)).toHaveAttribute("aria-expanded", "true");
    await expect(nav.getByRole("button", { name: "Collapse all" })).toBeVisible();
  });

  test("a problem in a collapsed part or nodepool opens it, at its field", async ({ page }) => {
    await open(page, "/specs/new");
    await page.getByTestId("nodepool-0-toggle").click();
    await expect(page.getByTestId("nodepool-0").getByRole("textbox", { name: "Replicas" })).toBeHidden();
    await toggle(page, "Basics").click();
    await toggle(page, "Nodepools").click();

    // Nothing typed yet: the name's rule shows once a save is tried, the hardware's at once
    await expect(part(page, "Nodepools").locator("header").getByLabel("1 to fix")).toBeVisible();
    await page.getByRole("button", { name: /review & create/i }).click();

    // The first problem is the name: Basics opens, the cursor in the field
    await expect(toggle(page, "Basics")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("spec-name-input")).toBeFocused();

    // The nodepool's, from the list at the top: its part and its card open
    const problems = page.getByRole("alert").filter({ hasText: "before saving" });
    await problems.getByRole("button", { name: /^Nodepool 1/ }).click();
    await expect(toggle(page, "Nodepools")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nodepool-0-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nodepool-0-configs")).toBeInViewport();
  });

  test("a nodepool collapses to its summary and problem count; a new one opens", async ({ page }) => {
    await open(page, "/specs/new");
    const pool = page.getByTestId("nodepool-0");
    await pool.getByRole("textbox", { name: "Replicas" }).fill("3");
    await page.getByTestId("nodepool-0-toggle").click();
    await expect(page.getByTestId("nodepool-0-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("nodepool-0-line")).toHaveText("3 replicas · 3 machine configs");
    // nm-conf has no hardware yet
    await expect(page.getByTestId("nodepool-0-toggle").getByLabel("1 to fix")).toBeVisible();
    await expect(pool.getByRole("button", { name: "Remove nodepool 1" })).toBeVisible();

    await page.getByRole("button", { name: "Add nodepool" }).click();
    await expect(page.getByTestId("nodepool-1-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nodepool-1").getByRole("textbox", { name: "Replicas" })).toBeVisible();
    await expect(page.getByTestId("nodepool-0-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  test("on an existing flavor, the parts collapsed there stay collapsed the next time; a new flavor starts open", async ({ page }) => {
    await open(page, "/specs/agent-dell/edit");
    await toggle(page, "Add-ons").click();
    await expect(line(page, "addons")).toHaveText("1 add-on: cert-manager");

    await page.reload();
    await expect(toggle(page, "Add-ons")).toHaveAttribute("aria-expanded", "false");
    await expect(toggle(page, "Basics")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nodepool-0-line")).toHaveText("dell · 2 replicas · 2 machine configs");

    await go(page, "/specs/new");
    await expect(toggle(page, "Add-ons")).toHaveAttribute("aria-expanded", "true");
  });
});

test.describe("Flavor editor: the add-ons transfer list", () => {
  test("an added add-on leaves Available, and comes back to its place when it is removed", async ({ page }) => {
    await open(page, "/specs/new");
    const available = page.getByTestId("addons-available");
    await expect(page.getByTestId("addons-available-count")).toHaveText("(4)");
    await expect(page.getByTestId("addons-selected-count")).toHaveText("(0)");

    await addButton(page, "platform", "external-secrets").click();
    await expect(card(page, "platform", "external-secrets")).toHaveCount(0);
    await expect(selected(page, "platform", "external-secrets")).toBeVisible();
    await expect(page.getByTestId("addons-available-count")).toHaveText("(3)");
    await expect(page.getByTestId("addons-selected-count")).toHaveText("(1)");
    await expect(page.getByTestId("addons-announcement")).toHaveText("external-secrets added to Selected, 1 of 1.");
    await expect(available.getByRole("button", { name: /^platform/ })).toContainText("1 added");

    // The search counts what is left
    await page.getByRole("textbox", { name: "Search addons" }).fill("secrets");
    await expect(page.getByTestId("addons-available-count")).toHaveText("(0)");
    await expect(available).toContainText("Every add-on that matches is selected");
    await page.getByRole("textbox", { name: "Search addons" }).fill("");

    // A team with nothing left says so
    await addButton(page, "observability", "prometheus").click();
    await expect(page.getByTestId("addon-team-observability")).toHaveText("observability· All added");
    await expect(available.getByRole("button", { name: /^observability/ })).toHaveCount(0);

    await selected(page, "platform", "external-secrets").getByRole("button", { name: "Remove addon" }).click();
    await expect(selected(page, "platform", "external-secrets")).toHaveCount(0);
    // Back in its place, between the two it was between
    const cards = page.getByTestId("addon-team-platform").locator("[data-testid^='addon-card-']");
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((all) => all.map((c) => c.getAttribute("data-testid")))).toEqual([
      "addon-card-platform-cert-manager",
      "addon-card-platform-external-secrets",
      "addon-card-platform-trust-manager",
    ]);
    await expect(page.getByTestId("addons-announcement")).toHaveText("external-secrets removed from Selected, back in Available.");
    await expect(page.getByTestId("addons-available-count")).toHaveText("(3)");
  });

  test("from the keyboard, the focus stays in the list the add-on left", async ({ page }) => {
    await open(page, "/specs/new");
    await addButton(page, "platform", "cert-manager").focus();
    await page.keyboard.press("Enter");
    await expect(selected(page, "platform", "cert-manager")).toBeVisible();
    await expect(addButton(page, "platform", "external-secrets")).toBeFocused();

    await selected(page, "platform", "cert-manager").getByRole("button", { name: "Remove addon" }).focus();
    await page.keyboard.press("Enter");
    await expect(card(page, "platform", "cert-manager")).toBeVisible();
    // Nothing left in Selected: the search box
    await expect(page.getByRole("textbox", { name: "Search addons" })).toBeFocused();
  });

  test("the add-on travels from its card into Selected and back; under reduced motion it fades in where it lands", async ({ page }) => {
    // Every Web Animation the page starts, by the add-on it moves
    await page.addInitScript(() => {
      const animate = Element.prototype.animate;
      const log: { addon: string | null; keyframes: string }[] = [];
      Object.assign(window, { addonMoves: log });
      Element.prototype.animate = function (keyframes, options) {
        log.push({ addon: this.getAttribute("data-flight"), keyframes: JSON.stringify(keyframes) });
        return animate.call(this, keyframes, options);
      };
    });
    const moves = () => page.evaluate(() => (window as unknown as { addonMoves: { addon: string | null; keyframes: string }[] }).addonMoves.splice(0));
    await open(page, "/specs/new");

    await addButton(page, "platform", "cert-manager").click();
    await expect(selected(page, "platform", "cert-manager")).toBeVisible();
    let log = await moves();
    expect(log).toHaveLength(1);
    expect(log[0].addon).toBe("platform/cert-manager");
    expect(log[0].keyframes).toContain("translate(");

    await selected(page, "platform", "cert-manager").getByRole("button", { name: "Remove addon" }).click();
    await expect(card(page, "platform", "cert-manager")).toBeVisible();
    log = await moves();
    expect(log.map((m) => [m.addon, m.keyframes.includes("translate(")])).toEqual([["platform/cert-manager", true]]);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await addButton(page, "platform", "cert-manager").click();
    await expect(selected(page, "platform", "cert-manager")).toBeVisible();
    log = await moves();
    expect(log).toHaveLength(1);
    expect(log[0].keyframes).not.toContain("transform");
    expect(log[0].keyframes).toContain("opacity");
  });

  test("an arrow points from Available to Selected: across side by side, down stacked", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/specs/new");
    const arrow = page.getByTestId("addons-direction");
    await expect(arrow).toBeVisible();
    let [from, cue, to] = await Promise.all([box(page.getByTestId("addons-available")), box(arrow), box(page.getByTestId("addons-selected"))]);
    expect(from.x + from.width).toBeLessThanOrEqual(cue.x);
    expect(cue.x + cue.width).toBeLessThanOrEqual(to.x);

    await page.setViewportSize({ width: 800, height: 900 });
    await expect(arrow).toBeVisible();
    [from, cue, to] = await Promise.all([box(page.getByTestId("addons-available")), box(arrow), box(page.getByTestId("addons-selected"))]);
    expect(from.y + from.height).toBeLessThanOrEqual(cue.y);
    expect(cue.y + cue.height).toBeLessThanOrEqual(to.y);
  });
});
