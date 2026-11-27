/**
 * A NodePool's name (ADR-0071, mocked): `<InfraEnv>` or `<InfraEnv>-<suffix>`.
 * Day1's template schema offers `nodepools[].name_suffix` where the template
 * writes the name, so:
 * - the create form's **Name suffix** beside the InfraEnv, the whole name
 *   previewed, a clash shown before day1 is asked, and a flavor's preset
 *   suffix prefilled;
 * - Edit cluster's **NodePool names**: existing NodePools read-only, by either
 *   shape, and an added one named from a suffix, written into the file's text.
 * Invented names only.
 */

import { test, expect, type Page, type Route, type Request } from "@playwright/test";
import { go, injectAdminAuth, mockDashboardApis, mockMachineConfigs, mockMR, placementAnswer } from "../fixtures/api-handlers";
import { ClusterNewPage } from "../pages/cluster-new.page";
import type { ClusterDetail, ClusterPreview, CreateClusterRequest, Mce, SpecEntry, TemplateField } from "../../types";
import { INFRA_ENVS, infraEnvsBody } from "../fixtures/node-types";

const DELL = "dell-r660-site1-128c-1024gb-5tb";
const SITE = "site1";
const MCE = "ocp4-prod-mce-site1-a";
const STATIC = [{ name: "workers-chrony-configuration" }];

const SCHEMA: TemplateField[] = [
  { name: "owner_merkaz", type: "string", required: true, example: "1234" },
  { name: "owner_anaf", type: "string", required: true, example: "56" },
  { name: "owner_mador", type: "string", required: true, example: "7" },
  {
    name: "nodepools",
    type: "list",
    required: true,
    fields: [
      { name: "infra_env", type: "string", required: true, example: DELL },
      { name: "name_suffix", type: "string", required: false, default: "" },
      { name: "replicas", type: "string", required: false, default: 2 },
      { name: "configs", type: "list", required: false, default: [], fields: [{ name: "name", type: "string", required: true }] },
    ],
  },
];

const flavor = (pools: Record<string, unknown>[]): SpecEntry => ({
  apiVersion: "wingman.io/v1",
  kind: "ClusterSpec",
  metadata: { name: "zoned", description: "Two nodepools", version: "1.0.0", labels: {} },
  spec: {
    day1: {
      variables: [],
      structure: { nodepools: pools.map(() => ({})) },
      locked_paths: [],
      template: "# template",
      values: { nodepools: pools.map((p) => ({ configs: STATIC, ...p })) },
    },
    day2: { addons: [] },
  },
  load_error: null,
  load_problems: [],
  warnings: [],
});

const MCES: Mce[] = [
  {
    name: MCE, site: SITE, env: "prod", letter: "a", follows_convention: true, naming_problems: [],
    default_mastertag: "4.16.27-x86_64", hub_version: "4.16.27-x86_64", cluster_count: 4, stray_files: [], problems: [],
  },
];

const PREVIEW: ClusterPreview = { yaml: "mastertag: 4.16.27-x86_64\n", path: `sites/${SITE}/mces/${MCE}/hostedClusters/ocp4-prod-zoned-site1-a.yaml` };

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: status >= 400 ? "application/problem+json" : "application/json", body: JSON.stringify(body) });

async function base(page: Page) {
  await injectAdminAuth(page);
  await mockDashboardApis(page);
  await page.route("**/api/day1/specs/template/schema**", (r) => json(r, SCHEMA));
  await page.route(INFRA_ENVS, (r) => json(r, infraEnvsBody(r, [DELL])));
  await page.route("**/api/day1/machine-configs", (r) => json(r, mockMachineConfigs));
  await page.route(/\/api\/day1\/mces(\?.*)?$/, (r) => json(r, MCES));
  await page.route("**/api/day2/addons", (r) => json(r, []));
}

// ── The create form ──────────────────────────────────────────────────────────

async function openCreate(page: Page, spec: SpecEntry): Promise<{ form: ClusterNewPage; previews: CreateClusterRequest[] }> {
  const previews: CreateClusterRequest[] = [];
  await base(page);
  await page.route("**/api/day1/specs", (r) => json(r, [spec]));
  await page.route("**/api/day1/sites", (r) => json(r, [SITE]));
  await page.route("**/api/day1/placement**", (r) => json(r, placementAnswer(new URL(r.request().url()).searchParams)));
  await page.route("**/api/day1/clusters/name-suggestion**", (r) =>
    json(r, { name: "ocp4-prod-zoned-site1-a", env: "prod", short_name: "zoned", sequence: "a", problems: [] })
  );
  await page.route("**/api/day1/clusters/preview", (r) => {
    previews.push(r.request().postDataJSON());
    return json(r, PREVIEW);
  });
  const form = new ClusterNewPage(page);
  await form.goto();
  await form.chooseSpec(spec.metadata.name);
  await form.place({ site: SITE, env: "prod", version: "4.16.27" });
  for (const owner of ["1234", "56", "7"]) await form.templateInput(owner).fill(owner);
  for (let i = 0; i < (spec.spec.day1.values?.nodepools as unknown[]).length; i++) {
    await page.getByTestId(`infra-env-select-nodepools[${i}].infra_env`).click();
    await form.option(DELL).click();
  }
  return { form, previews };
}

const sentPools = (previews: CreateClusterRequest[]) => previews.at(-1)?.variables.nodepools as Record<string, unknown>[];
const name = (page: Page, i: number) => page.getByTestId(`nodepool-${i}-name`);

test.describe("A NodePool's name on the create form", () => {
  test("is its InfraEnv, then a suffix; a clash shows before day1 is asked", async ({ page }) => {
    const { form, previews } = await openCreate(page, flavor([{}, {}]));
    await expect(page.locator('[data-field-path="nodepools[0].name_suffix"]')).toContainText("Name suffix");
    await expect(name(page, 0).getByTestId("nodepool-0-name-preview")).toContainText(`NodePool ${DELL}:`);
    await expect(name(page, 1).getByTestId("nodepool-1-name-problem")).toHaveText(
      `Nodepool 1 is named ${DELL} already: give one of them another suffix`
    );

    await form.review();
    await expect(page.getByText(/Name suffix: Nodepool 1 is named .* already/i)).toBeVisible();
    expect(previews).toHaveLength(0);

    await name(page, 1).getByLabel("Nodepool 2 name suffix").fill("Gpu");
    await expect(name(page, 1).getByTestId("nodepool-1-name-problem")).toHaveText(/^Lowercase letters/);
    await name(page, 1).getByLabel("Nodepool 2 name suffix").fill("gpu");
    await expect(name(page, 1).getByTestId("nodepool-1-name-preview")).toContainText(`NodePool ${DELL}-gpu:`);
    await expect(name(page, 1).getByTestId("nodepool-1-name-problem")).toHaveCount(0);

    await form.review();
    await expect(form.reviewDialog).toBeVisible();
    expect(sentPools(previews).map((p) => [p.infra_env, p.name_suffix])).toEqual([
      [DELL, ""],
      [DELL, "gpu"],
    ]);
  });

  test("starts from a flavor's preset suffix", async ({ page }) => {
    const { form, previews } = await openCreate(page, flavor([{ name_suffix: "storage" }]));
    await expect(name(page, 0).getByLabel("Nodepool 1 name suffix")).toHaveValue("storage");
    await expect(name(page, 0).getByTestId("nodepool-0-name-preview")).toContainText(`NodePool ${DELL}-storage:`);
    await form.review();
    await expect(form.reviewDialog).toBeVisible();
    expect(sentPools(previews)[0].name_suffix).toBe("storage");
  });
});

// ── Edit cluster ─────────────────────────────────────────────────────────────

const NAME = "ocp4-prod-lark-site1";
const YAML = `owner:
  merkaz: "1"
mastertag: 4.16.27-x86_64
nodepool:
- infraEnvName: ${DELL}
  replicas: 2
  labels:
    allowDeletion: false
- name: storage
  infraEnvName: dell-r760-site1-64c-512gb-20tb
  replicas: 1
`;
const ADDED = `${YAML}- infraEnvName: ${DELL}
  replicas: 1
`;
const pool = (infra: string, poolName: string | null) => ({
  name: poolName, infra_env_name: infra, additional_infra_env_names: [], replicas: 1, allow_deletion: false, configs: [], node_labels: {}, tuning_config: null,
});
const DETAIL: ClusterDetail = {
  name: NAME,
  site: SITE,
  mce: MCE,
  yaml: YAML,
  gitlab_url: "https://gitlab.example.com/gitops-day1/platform-config/-/blob/main/x.yaml",
  path: `sites/${SITE}/mces/${MCE}/hostedClusters/${NAME}.yaml`,
  last_commit_id: "0c904bfafde4c4ed24416190ea224ee25cdcf738",
  metadata: { spec_name: null, spec_version: null, created_by: "alice", created_at: null, site: SITE, mce: MCE, variables: {}, immutable_paths: [], requested_addons: [] },
  values: {
    owner: { merkaz: "1", anaf: "2", mador: "3" },
    mastertag: "4.16.27-x86_64",
    platform: "agent",
    nodepools: [pool(DELL, null), pool("dell-r760-site1-64c-512gb-20tb", "storage")],
    network: { vlan_id: null, dhcp_network: null, segment: null },
    cluster_name: null,
    automation_keys: [],
  },
  hosted_cluster: { cluster_name: "prod-lark-site1", name: "openshift-prod-lark-site1", namespace: "hcp-prod-lark-site1" },
  naming: { follows_convention: true, env: "prod", short_name: "lark", sequence: null, problems: [] },
  mce_default_mastertag: "4.16.27-x86_64",
  problems: [],
  segments_manager: null,
};

async function openEdit(page: Page) {
  await base(page);
  await page.route(/\/api\/day1\/clusters\/[^/]+\/status\?/, (r) => json(r, {}, 501));
  await page.route(`**/api/day1/clusters/${NAME}?**`, (r) =>
    r.request().method() === "PATCH" ? json(r, mockMR({ iid: 66, title: `[Wingman/Day1] Modify cluster ${NAME}` })) : json(r, DETAIL)
  );
  await page.route(`**/api/day1/clusters/${NAME}/drift?**`, (r) => json(r, { cluster: NAME, site: SITE, mce: MCE, state: "not_linked", is_drifted: false, spec_name: null, spec_version: null, current_spec_version: null, value_drift: [], addon_drift: [], version_differences: [], error: null, update: null }));
  await page.route(`**/api/day2/clusters/${NAME}/**`, (r) => json(r, r.request().url().includes("/history") ? [] : { cluster: NAME, mce: MCE, id: `hosted:${SITE}:prod:${MCE}:${NAME}`, kind: "hosted", site: SITE, env: "prod", ocp_version: "4.16.27", installed: [], excluded: [], warnings: [], argocd_note: "" }));
  await go(page, `/clusters/${NAME}?site=${SITE}&mce=${MCE}`);
  await page.getByRole("button", { name: "Edit" }).click();
}

test.describe("NodePool names in Edit cluster", () => {
  test("shows every existing NodePool read-only, by either shape", async ({ page }) => {
    await openEdit(page);
    const panel = page.getByTestId("edit-nodepool-names");
    await expect(panel.getByTestId("edit-nodepool-name-0-value")).toHaveText(`prod-lark-site1-${DELL}`);
    await expect(panel.getByTestId("edit-nodepool-name-0")).toContainText("derived by the chart, kept: renaming it would replace every node");
    await expect(panel.getByTestId("edit-nodepool-name-1-value")).toHaveText("storage");
    await expect(panel.getByTestId("edit-nodepool-name-1")).toContainText("older name");
    await expect(panel.getByRole("textbox")).toHaveCount(0);
  });

  test("names a nodepool the edit adds from a suffix, every other line kept", async ({ page }) => {
    await openEdit(page);
    await page.getByLabel("Cluster file").fill(ADDED);
    const added = page.getByTestId("edit-nodepool-name-2");
    await expect(added.getByTestId("edit-nodepool-name-2-problem")).toHaveText(`A new NodePool is named ${DELL} or ${DELL}-<suffix>: name it`);

    await added.getByTestId("edit-nodepool-name-2-write").click();
    const named = ADDED.replace(`- infraEnvName: ${DELL}\n  replicas: 1\n`, `- infraEnvName: ${DELL}\n  name: ${DELL}\n  replicas: 1\n`);
    await expect(page.getByLabel("Cluster file")).toHaveValue(named);
    await expect(added.getByTestId("edit-nodepool-name-2-problem")).toHaveCount(0);

    await added.getByLabel("Nodepool 3 name suffix").fill("b");
    const suffixed = named.replace(`  name: ${DELL}\n`, `  name: ${DELL}-b\n`);
    await expect(page.getByLabel("Cluster file")).toHaveValue(suffixed);
    await expect(added.getByTestId("edit-nodepool-name-2-preview")).toContainText(`NodePool ${DELL}-b`);
    await expect(page.getByTestId("edit-nodepool-name-0")).toHaveAttribute("data-existing", "");

    const patch = page.waitForRequest((req: Request) => req.method() === "PATCH");
    await page.getByRole("button", { name: /review & submit/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /confirm/i }).click();
    expect((await patch).postDataJSON().updated_yaml).toBe(suffixed);
  });

  test("says that merging deletes a NodePool the text renames", async ({ page }) => {
    await openEdit(page);
    await page.getByLabel("Cluster file").fill(YAML.replace("- name: storage\n", "- name: dell-r760-site1-64c-512gb-20tb\n"));
    await expect(page.getByTestId("edit-nodepool-names-removed")).toHaveText("Merging deletes NodePool storage and its nodes.");
    await expect(page.getByTestId("edit-nodepool-name-1")).toHaveAttribute("data-added", "");
  });
});
