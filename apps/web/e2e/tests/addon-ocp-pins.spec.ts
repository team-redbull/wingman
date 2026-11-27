/**
 * An add-on's OCP-version pins (ADR-0043's 2026-11-25 amendment, ADR-0073),
 * mocked: the add-on page's pins card reads them, and its Add pin, Edit and
 * Remove open the add-on's editor on the pins, where every change goes in
 * Edit add-on's one PUT (a dry run first, then the write confirming it); the
 * fleet-default footgun is said above them, a read-only team's cannot be
 * changed, and a new add-on carries pins in its create MR, a revision or
 * values each (docs/notes/2026-11-12-day2-addon-authoring-api.md §8, §9).
 */

import { test, expect, type Page } from "@playwright/test";
import { go, injectAdminAuth, injectViewerAuth, mockDashboardApis } from "../fixtures/api-handlers";
import { HOSTED_ID, HOSTED_NAME, mockDay2World } from "../fixtures/day2";
import { mockAuthoring } from "../fixtures/authoring";
import { mockAddonDetail, type AddonRequests } from "../fixtures/addon-detail";
import { DEPLOYING_TWIN, NEXT_VERSION, mockOcpPins, type PinRequests } from "../fixtures/ocp-pins";

let addons: AddonRequests;
let pins: PinRequests;

async function world(page: Page) {
  await mockDashboardApis(page);
  await mockDay2World(page);
  await mockAuthoring(page);
  addons = await mockAddonDetail(page);
  pins = await mockOcpPins(page);
}

const card = (page: Page) => page.getByRole("region", { name: "OCP-version pins" });
const formDialog = (page: Page) => page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Preview changes" }) });
const reviewDialog = (page: Page) => page.getByRole("dialog").filter({ has: page.getByTestId("authoring-plan") });
const realPinWrites = () => pins.writes.filter((w) => !w.dryRun);

/** Preview from the form; the review dialog with its plan. */
async function preview(page: Page) {
  await formDialog(page).getByRole("button", { name: "Preview changes" }).click();
  const review = reviewDialog(page);
  await expect(review.getByTestId("authoring-plan")).toBeVisible();
  return review;
}

test.describe("The add-on page's OCP-version pins", () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await world(page);
  });

  test("are listed with what each reaches, and added in the editor from the versions the destinations run", async ({ page }) => {
    await go(page, "/addons/observability/prometheus");
    const pin = card(page).getByTestId("ocp-pin-4.18.22");
    await expect(pin).toContainText("targetRevision 2.44.0");
    await expect(pin).toContainText("1 destination");

    await card(page).getByRole("button", { name: "Add pin" }).click();
    const form = formDialog(page);
    await expect(form.getByRole("heading", { name: "Edit add-on observability/prometheus" })).toBeVisible();
    // The editor opens on a new pin, its version focused.
    const fresh = form.getByTestId("editor-pin-new-1");
    const version = fresh.getByLabel("OpenShift version", { exact: true });
    await expect(version).toBeFocused();
    const previewButton = form.getByRole("button", { name: "Preview changes" });
    await expect(previewButton).toHaveAttribute("title", "The new pin: Give the OpenShift version");
    await version.fill("4.19");
    await expect(previewButton).toBeDisabled();
    await expect(fresh).toContainText("A pin is keyed by the full version, 4.19.<patch>");
    // The pinned version is not offered again; the one a twin runs with prometheus is, first.
    const offered = fresh.getByRole("group", { name: "Versions the destinations run" });
    await expect(offered.getByRole("button")).toHaveCount(1);
    await offered.getByRole("button", { name: new RegExp(`^${NEXT_VERSION.replaceAll(".", "\\.")}`) }).click();
    await expect(version).toHaveValue(NEXT_VERSION);
    // A pin needs a revision or values (no longer a revision alone).
    await expect(previewButton).toHaveAttribute("title", `OCP ${NEXT_VERSION}: A pin needs a chart revision or values`);
    await fresh.getByRole("textbox", { name: `Contents of operators/prometheus/ocp-versions/${NEXT_VERSION}/values.yaml` }).fill("scrapeInterval: 1m");
    await expect(previewButton).toBeEnabled();
    await fresh.getByRole("combobox", { name: "Chart revision (targetRevision)" }).fill("2.45.0");
    await expect(fresh.getByTestId("pin-reach")).toContainText(`1 destination that gets prometheus runs OCP ${NEXT_VERSION}`);

    const review = await preview(page);
    await expect(review.getByTestId("plan-title")).toHaveText(`[Wingman/Day2] Update addon observability/prometheus OCP-version pins ${NEXT_VERSION} (new)`);
    await review.getByRole("checkbox", { name: "I understand the app on twin changes as listed" }).click();
    await review.getByRole("button", { name: /Create MR/ }).click();
    await expect(page.getByRole("region", { name: "Opened merge requests" })).toContainText(`OCP-version pins ${NEXT_VERSION}`);

    expect(pins.writes[0]).toMatchObject({ method: "PUT", dryRun: true, path: "/api/day2/addons/observability/prometheus" });
    expect(realPinWrites()).toHaveLength(1);
    expect(realPinWrites()[0].body).toEqual({
      last_commit_id: "observability-catalog-1",
      ocp_versions: [{ version: NEXT_VERSION, target_revision: "2.45.0", values: { scrapeInterval: "1m" } }],
      confirm_changes: [DEPLOYING_TWIN],
      expected_digest: `edit-digest-prometheus-${NEXT_VERSION}-${NEXT_VERSION}`,
    });
  });

  test("are edited in the editor: only what changes is sent, guarded by the entry's read", async ({ page }) => {
    await go(page, "/addons/observability/prometheus");
    await card(page).getByRole("button", { name: "Edit the pin for OCP 4.18.22" }).click();
    const form = formDialog(page);
    const pin = form.getByTestId("editor-pin-4.18.22");
    await expect(pin.getByLabel("OpenShift version", { exact: true })).toBeFocused();
    const revision = pin.getByRole("combobox", { name: "Chart revision (targetRevision)" });
    await expect(revision).toHaveValue("2.44.0");
    await expect(form.getByRole("button", { name: "Preview changes" })).toHaveAttribute("title", "No changes yet");
    await revision.fill("2.45.0");

    const review = await preview(page);
    await expect(review.getByTestId("plan-title")).toHaveText("[Wingman/Day2] Update addon observability/prometheus OCP-version pins 4.18.22");
    await review.getByRole("checkbox", { name: `I understand the app on ${HOSTED_NAME} changes as listed` }).click();
    await review.getByRole("button", { name: /Create MR/ }).click();
    await expect(page.getByRole("region", { name: "Opened merge requests" })).toBeVisible();

    const real = realPinWrites()[0];
    expect(real.method).toBe("PUT");
    expect(real.path).toBe("/api/day2/addons/observability/prometheus");
    expect(real.body).toEqual({
      last_commit_id: "observability-catalog-1",
      ocp_versions: [{ version: "4.18.22", from_version: "4.18.22", target_revision: "2.45.0" }],
      confirm_changes: [HOSTED_ID],
      expected_digest: "edit-digest-prometheus-4.18.22-4.18.22",
    });
  });

  test("are removed in the editor, with undo, and the removal is confirmed", async ({ page }) => {
    await go(page, "/addons/observability/prometheus");
    await card(page).getByRole("button", { name: "Remove the pin for OCP 4.18.22" }).click();
    const form = formDialog(page);
    const removed = form.getByTestId("editor-pin-4.18.22");
    await expect(removed).toContainText("its destination gets the add-on's revision and Sig values again");
    await removed.getByRole("button", { name: "Undo removing the pin for OCP 4.18.22" }).click();
    await expect(form.getByRole("button", { name: "Preview changes" })).toHaveAttribute("title", "No changes yet");
    await form.getByRole("button", { name: "Remove the pin for OCP 4.18.22" }).click();

    const review = await preview(page);
    await expect(review.getByTestId("plan-title")).toHaveText(/OCP-version pins 4\.18\.22 \(removed\)$/);
    await review.getByRole("checkbox", { name: `I understand the app on ${HOSTED_NAME} changes as listed` }).click();
    await review.getByRole("button", { name: /Create MR/ }).click();
    await expect(page.getByRole("region", { name: "Opened merge requests" })).toBeVisible();

    const real = realPinWrites()[0];
    expect(real.method).toBe("PUT");
    expect(real.body).toEqual({
      last_commit_id: "observability-catalog-1",
      remove_ocp_versions: ["4.18.22"],
      confirm_changes: [HOSTED_ID],
      expected_digest: "edit-digest-prometheus-4.18.22",
    });
  });

  test("say when a fleet default's own revision overrides every pin", async ({ page }) => {
    await go(page, "/addons/platform/external-secrets");
    await expect(card(page).getByTestId("pin-fleet-override")).toContainText(
      "defaults/hosted-clusters/external-secrets/external-secrets.yaml sets targetRevision: 0.9.0, which overrides every pin: on every hosted cluster",
    );
    await expect(card(page)).toContainText("None: every OCP version gets the add-on's revision.");
  });

  test("of a read-only team cannot be changed", async ({ page }) => {
    await go(page, "/addons/security/kyverno");
    await expect(card(page).getByRole("button", { name: "Add pin" })).toBeDisabled();
  });
});

test("A viewer reads the pins with no way to change them", async ({ page }) => {
  await injectAdminAuth(page);
  await injectViewerAuth(page);
  await world(page);
  await go(page, "/addons/observability/prometheus");
  await expect(card(page).getByTestId("ocp-pin-4.18.22")).toContainText("targetRevision 2.44.0");
  await expect(card(page).getByRole("button", { name: /Add pin|Edit the pin|Remove the pin/ })).toHaveCount(0);
});

test("A new add-on is created with a pin, in the same merge request", async ({ page }) => {
  await injectAdminAuth(page);
  await world(page);
  await go(page, "/addons/new?team=platform");
  const form = page.getByTestId("new-addon-form");
  await form.getByRole("textbox", { name: /^Name/ }).fill("podinfo");
  const previewButton = form.getByRole("button", { name: "Preview changes" });

  await form.getByRole("button", { name: "Add a pin" }).click();
  const first = form.getByTestId("new-pin-0");
  await first.getByRole("button", { name: /^4\.18\.22/ }).click();
  await expect(first.getByLabel("OpenShift version", { exact: true })).toHaveValue("4.18.22");
  await expect(previewButton).toHaveAttribute("title", "Pin 1: A pin needs a chart revision or values");
  await first.getByRole("combobox", { name: "Chart revision (targetRevision)" }).fill("1.0.0");
  // A second pin of the same version is refused before anything is sent, and the version is not offered again.
  await form.getByRole("button", { name: "Add a pin" }).click();
  const second = form.getByTestId("new-pin-1");
  await expect(second.getByRole("group", { name: "Versions the destinations run" })).toHaveCount(0);
  await second.getByLabel("OpenShift version", { exact: true }).fill("4.18.22");
  await expect(previewButton).toHaveAttribute("title", "Pin 1: OCP 4.18.22 is pinned already");
  await second.getByRole("button", { name: "Remove pin 2" }).click();
  await expect(previewButton).toBeEnabled();

  await previewButton.click();
  const review = reviewDialog(page);
  await expect(review).toContainText("operators/podinfo/ocp-versions/4.18.22/podinfo.yaml");
  await review.getByRole("button", { name: /Create MR/ }).click();
  await expect(page.getByRole("region", { name: "Opened merge requests" })).toContainText("Create addon platform/podinfo");

  const writes = addons.writes.filter((w) => w.path === "/api/day2/addons/platform");
  expect(writes.map((w) => w.dryRun)).toEqual([true, false]);
  for (const w of writes) expect(w.body.ocp_versions).toEqual([{ version: "4.18.22", target_revision: "1.0.0", values: {} }]);
});
