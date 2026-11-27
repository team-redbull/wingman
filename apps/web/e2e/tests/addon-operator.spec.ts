/**
 * An add-on that installs an OLM operator (ADR-0073), mocked: its page shows
 * the Subscription as OperatorHub does; Edit add-on offers the update channel
 * and version from the mirrored catalog of every OCP minor its destinations
 * run, Manual disabled with why, each pin's own channel from its minor's
 * catalog, and sends the add-on, its operator settings and its pins in one
 * PUT; without a catalog the fields are free text and say why; New add-on
 * reads the chart its address names (its branches, its operator); and the
 * editor fits a phone (docs/notes/2026-11-12-day2-addon-authoring-api.md §9).
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { go, injectAdminAuth, mockDashboardApis } from "../fixtures/api-handlers";
import { mockDay2World } from "../fixtures/day2";
import { mockAuthoring } from "../fixtures/authoring";
import { mockAddonDetail, type AddonRequests } from "../fixtures/addon-detail";
import { BRANCHES, EYAL, HERZI, mockOperator } from "../fixtures/operator";
import type { PinRequests } from "../fixtures/ocp-pins";

const MANUAL_REASON =
  "Manual stalls the GitOps sync: the Subscription waits at InstallPlanPending, Argo CD reports it Progressing and no later sync wave runs. The platform has no InstallPlan approver.";

let addons: AddonRequests;
let edits: PinRequests;

async function world(page: Page, options: { catalog?: boolean } = {}) {
  await injectAdminAuth(page);
  await mockDashboardApis(page);
  await mockDay2World(page);
  await mockAuthoring(page);
  addons = await mockAddonDetail(page);
  edits = await mockOperator(page, options);
}

const formDialog = (page: Page) => page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Preview changes" }) });
const reviewDialog = (page: Page) => page.getByRole("dialog").filter({ has: page.getByTestId("authoring-plan") });

/** One term of a definition list, with its value. */
const fact = (scope: Locator, term: string) => scope.locator("div.contents").filter({ has: scope.page().locator("dt").getByText(term, { exact: true }) });

/** Open the select named `name` in `scope`; its options (the open list's only). */
async function openSelect(scope: Locator, name: string) {
  await scope.getByRole("combobox", { name, exact: true }).click();
  return scope.page().getByRole("listbox").getByRole("option");
}

/** Pick the option labelled exactly `label`, and wait for its list to close. */
async function choose(page: Page, label: string) {
  await page.getByRole("listbox").getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function editAddon(page: Page) {
  await go(page, "/addons/redbull/cert-manager");
  await page.getByRole("region", { name: "Add-on" }).getByRole("button", { name: "Edit add-on" }).click();
  const form = formDialog(page);
  await expect(form.getByRole("textbox", { name: "Chart repo URL (repourl)" })).toBeFocused();
  return form;
}

test.describe("An operator add-on", () => {
  test("shows its Subscription as OperatorHub does, on its page, its pins and the Addons list", async ({ page }) => {
    await world(page);
    await go(page, "/addons/redbull/cert-manager");
    const view = page.getByRole("region", { name: "Add-on" }).getByTestId("operator-view");
    await expect(view).toContainText("operator-olm.subscription");
    const expected: [string, string][] = [
      ["Update channel", "stable-v1"],
      ["Version", "Latest in the channel"],
      ["Update approval", "Automatic (operator-olm's default)"],
      ["Package", "openshift-cert-manager-operator"],
      ["Install namespace", "cert-manager-operator"],
      ["Installation mode", "A specific namespace: cert-manager-operator"],
      ["Catalog source", "generic-cs in openshift-marketplace (operator-olm's default)"],
    ];
    for (const [term, value] of expected) await expect(fact(view, term)).toContainText(value);

    const pins = page.getByRole("region", { name: "OCP-version pins" });
    await expect(pins.getByTestId(`ocp-pin-${HERZI.version}`)).toContainText("targetRevision 1.14.0");
    await expect(pins.getByTestId(`ocp-pin-${HERZI.version}`)).toContainText("channel stable-v1.14");
    await expect(pins.getByTestId(`ocp-pin-${EYAL.version}`)).toContainText("values only");
    await expect(pins.getByTestId(`ocp-pin-${EYAL.version}`)).toContainText("channel stable-v1.15");

    await go(page, "/addons?team=redbull");
    await page.getByTestId("team-redbull").getByRole("button", { name: /^cert-manager/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Operator" }).click();
    await expect(fact(dialog, "Update channel")).toContainText("stable-v1");
    await expect(dialog.getByTestId(`operator-pin-${HERZI.version}`)).toContainText("1.14.0");
    await expect(dialog.getByTestId(`operator-pin-${HERZI.version}`)).toContainText("stable-v1.14");
    await expect(dialog.getByTestId(`operator-pin-${EYAL.version}`)).toContainText("values only");
    await expect(dialog.getByTestId(`operator-pin-${EYAL.version}`)).toContainText("stable-v1.15");
  });

  test("is edited as OperatorHub has it, with its pins, in one merge request", async ({ page }) => {
    await world(page);
    const form = await editAddon(page);
    const sig = form.getByTestId("operator-section");

    // The Sig level: the channels of every minor its destinations run (4.16 and 4.20), each marked where it is missing.
    const channels = await openSelect(sig, "Update channel");
    await expect(channels).toHaveText(["The chart's (stable-v1)", "stable-v1 (default)", "stable-v1.14 · not in 4.20", "stable-v1.15 · not in 4.16"]);
    await choose(page, "stable-v1.15 · not in 4.16");
    // Its versions, newest first, the head marked; Latest first.
    const versions = await openSelect(sig, "Version");
    await expect(versions).toHaveText([
      "The chart's (Latest in the channel)",
      "Latest in the channel",
      "cert-manager-operator.v1.15.1 (head)",
      "cert-manager-operator.v1.15.0",
    ]);
    await choose(page, "Latest in the channel");
    await expect(sig).toContainText("The version of the first install only: with Automatic approval, OLM then follows the channel.");
    // Manual is shown, disabled, with why.
    await expect(sig.getByRole("radio", { name: "Automatic" })).toBeChecked();
    await expect(sig.getByRole("radio", { name: "Manual" })).toBeDisabled();
    await expect(sig).toContainText(MANUAL_REASON);
    await expect(fact(sig, "Installation mode")).toContainText("A specific namespace: cert-manager-operator");

    // A pin's own channel, from its minor's catalog; the first option inherits the Sig values' as edited.
    const recent = form.getByTestId(`editor-pin-${EYAL.version}`);
    const pinChannels = await openSelect(recent, "Update channel");
    await expect(pinChannels).toHaveText(["Inherit the Sig values' (stable-v1.15)", "stable-v1 (default)", "stable-v1.15"]);
    await choose(page, "stable-v1 (default)");

    await form.getByRole("button", { name: `Remove the pin for OCP ${HERZI.version}` }).click();
    await expect(form.getByTestId(`editor-pin-${HERZI.version}`)).toContainText("is removed");
    await form.getByRole("button", { name: "Add pin" }).click();
    const fresh = form.getByTestId("editor-pin-new-1");
    await fresh.getByLabel("OpenShift version", { exact: true }).fill("4.20.10");
    await expect(fresh.getByTestId("pin-reach")).toContainText("the pin waits for the first cluster day1 moves there");
    await openSelect(fresh, "Update channel");
    await choose(page, "stable-v1.15");

    await form.getByRole("button", { name: "Preview changes" }).click();
    const review = reviewDialog(page);
    await expect(review.getByTestId("plan-title")).toHaveText(
      `[Wingman/Day2] Update addon redbull/cert-manager Sig values and OCP-version pins ${EYAL.version}, 4.20.10 (new), ${HERZI.version} (removed)`,
    );
    const dryRuns = edits.writes.filter((w) => w.dryRun);
    expect(dryRuns).toHaveLength(1);
    expect(dryRuns[0]).toMatchObject({ method: "PUT", path: "/api/day2/addons/redbull/cert-manager" });
    expect(dryRuns[0].body).toEqual({
      last_commit_id: "redbull-catalog-1",
      operator: { channel: "stable-v1.15", starting_csv: "" },
      ocp_versions: [
        { version: EYAL.version, from_version: EYAL.version, operator: { channel: "stable-v1" } },
        { version: "4.20.10", operator: { channel: "stable-v1.15" } },
      ],
      remove_ocp_versions: [HERZI.version],
    });

    await review.getByRole("checkbox", { name: /change as listed/ }).click();
    await review.getByRole("button", { name: /Create MR/ }).click();
    await expect(page.getByRole("region", { name: "Opened merge requests" })).toBeVisible();
    const real = edits.writes.filter((w) => !w.dryRun);
    expect(real).toHaveLength(1);
    expect(real[0].body).toMatchObject({ ...dryRuns[0].body, confirm_changes: [HERZI.id, EYAL.id] });
    expect(real[0].body.expected_digest).toMatch(/^edit-digest-cert-manager/);
  });

  test("without a mirrored catalog takes free text, and says why", async ({ page }) => {
    await world(page, { catalog: false });
    const form = await editAddon(page);
    const sig = form.getByTestId("operator-section");
    const channel = sig.getByRole("textbox", { name: "Update channel" });
    await expect(channel).toHaveValue("stable-v1");
    await expect(sig).toContainText("No mirrored catalog is configured in Wingman, so there is no list.");
    const previewButton = form.getByRole("button", { name: "Preview changes" });
    await channel.fill("stable v1");
    await expect(previewButton).toHaveAttribute("title", /^Sig values: Update channel: "stable v1" is no channel name/);
    await channel.fill("stable-v1.15");
    // A version, typed: its CSV name.
    await openSelect(sig, "Version");
    await choose(page, "Another version: type its CSV name");
    await sig.getByRole("textbox", { name: "CSV name" }).fill("cert-manager-operator.v1.15.0");
    await previewButton.click();
    await expect(reviewDialog(page).getByTestId("authoring-plan")).toBeVisible();
    expect(edits.writes[0].body).toEqual({
      last_commit_id: "redbull-catalog-1",
      operator: { channel: "stable-v1.15", starting_csv: "cert-manager-operator.v1.15.0" },
    });
  });

  test("is created with its channel and a values-only pin, from the chart its address names", async ({ page }) => {
    await world(page);
    await go(page, "/addons/new?team=redbull");
    const form = page.getByTestId("new-addon-form");
    await form.getByRole("textbox", { name: /^Name/ }).fill("cert-manager");
    // The chart is read once its address settles: an operator, with its branches.
    const operator = form.getByRole("region", { name: "Operator" });
    await expect(operator.getByRole("combobox", { name: "Update channel", exact: true })).toBeVisible();
    await expect(form.locator(`datalist`).first().locator("option")).toHaveCount(BRANCHES.length);
    await openSelect(operator, "Update channel");
    await choose(page, "stable-v1 (default)");

    await form.getByRole("button", { name: "Add a pin" }).click();
    const pin = form.getByTestId("new-pin-0");
    await pin.getByLabel("OpenShift version", { exact: true }).fill(EYAL.version);
    const revisions = pin.locator("datalist option");
    await expect(revisions).toHaveCount(BRANCHES.length);
    expect(await revisions.evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toEqual(BRANCHES);
    await openSelect(pin, "Update channel");
    await choose(page, "stable-v1.15");

    await form.getByRole("button", { name: "Preview changes" }).click();
    await expect(reviewDialog(page).getByTestId("authoring-plan")).toBeVisible();
    const create = addons.writes.find((w) => w.path === "/api/day2/addons/redbull" && w.dryRun);
    expect(create?.body).toMatchObject({
      name: "cert-manager",
      operator: { channel: "stable-v1" },
      ocp_versions: [{ version: EYAL.version, values: {}, operator: { channel: "stable-v1.15" } }],
    });
    expect((create?.body.ocp_versions as Record<string, unknown>[])[0]).not.toHaveProperty("target_revision");
  });

  test("fits a phone: nothing overflows the editor at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await world(page);
    const form = await editAddon(page);
    await expect(form.getByTestId("operator-section")).toBeVisible();
    await form.getByRole("button", { name: "Add pin" }).click();
    const fits = await form.evaluate((el) => {
      const wide = [...el.querySelectorAll<HTMLElement>("*")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5);
      return { scroll: el.scrollWidth <= el.clientWidth, page: document.documentElement.scrollWidth <= window.innerWidth, wide: wide.map((e) => e.outerHTML.slice(0, 80)) };
    });
    expect(fits).toEqual({ scroll: true, page: true, wide: [] });
  });
});
