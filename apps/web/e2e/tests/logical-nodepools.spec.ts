/**
 * Logical nodepools (ADR-0072, mocked): the customer picks a node type and
 * sets each zone's replicas; the request carries `node_type` and `zones`, and
 * day1 writes a NodePool per zone with one configuration.
 * - the create form: the Node type picker, a row per zone (0 allowed), the
 *   NodePools' names, the request and placement's needs; a flavor's preset
 *   node type and locked replicas; a flavor's older InfraEnv spread over every
 *   zone; the typed fallback without the MCE's list;
 * - the cluster page: the Node pools tab and Edit cluster group the NodePools
 *   of one node type and suffix;
 * - the flavor editor: a nodepool presets its node type.
 * Invented names only.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { go, injectAdminAuth, mockDashboardApis, mockMachineConfigs, placementAnswer } from "../fixtures/api-handlers";
import { INFRA_ENVS, infraEnvsBody } from "../fixtures/node-types";
import { ClusterNewPage } from "../pages/cluster-new.page";
import type { ClusterDetail, ClusterPreview, CreateClusterRequest, Mce, SpecEntry, TemplateField } from "../../types";

const AZ = ["r760-mtl-az1", "r760-mtl-az2", "r760-mtl-az3"];
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
      { name: "infra_env", type: "string", required: true, example: AZ[0] },
      { name: "name_suffix", type: "string", required: false, default: "" },
      { name: "replicas", type: "string", required: false, default: 2 },
      { name: "configs", type: "list", required: false, default: [], fields: [{ name: "name", type: "string", required: true }] },
    ],
  },
];

const flavor = (pool: Record<string, unknown>, locked: string[] = []): SpecEntry => ({
  apiVersion: "wingman.io/v1",
  kind: "ClusterSpec",
  metadata: { name: "zoned", description: "One logical nodepool", version: "1.0.0", labels: {} },
  spec: {
    day1: { variables: [], structure: { nodepools: [{}] }, locked_paths: locked, template: "# template", values: { nodepools: [{ configs: STATIC, ...pool }] } },
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

async function base(page: Page, typesOff = false) {
  await injectAdminAuth(page);
  await mockDashboardApis(page);
  await page.route("**/api/day1/specs/template/schema**", (r) => json(r, SCHEMA));
  await page.route(INFRA_ENVS, (r) =>
    typesOff
      ? json(r, { type: "about:blank", title: "Not Implemented", status: 501, detail: "Live cluster status is disabled", code: "FEATURE_DISABLED", details: {} }, 501)
      : json(r, infraEnvsBody(r, [...AZ, "g12-mtl-az1"]))
  );
  await page.route("**/api/day1/machine-configs", (r) => json(r, mockMachineConfigs));
  await page.route(/\/api\/day1\/mces(\?.*)?$/, (r) => json(r, MCES));
  await page.route("**/api/day2/addons", (r) => json(r, []));
}

async function openCreate(page: Page, spec: SpecEntry, typesOff = false) {
  const previews: CreateClusterRequest[] = [];
  const needs: string[][] = [];
  await base(page, typesOff);
  await page.route("**/api/day1/specs", (r) => json(r, [spec]));
  await page.route("**/api/day1/sites", (r) => json(r, [SITE]));
  await page.route("**/api/day1/placement**", (r) => {
    const query = new URL(r.request().url()).searchParams;
    needs.push(query.getAll("need"));
    return json(r, placementAnswer(query));
  });
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
  return { form, previews, needs };
}

const zone = (page: Page, infraEnv: string) => page.getByTestId(`nodepool-0-zone-${infraEnv}`);
const sent = (previews: CreateClusterRequest[]) => (previews.at(-1)?.variables.nodepools as Record<string, unknown>[])[0];

test.describe("A logical nodepool on the create form", () => {
  test("is a node type and a NodePool per zone, each with its replicas, a zone at 0 included", async ({ page }) => {
    const { form, previews, needs } = await openCreate(page, flavor({}));
    await page.getByTestId("infra-env-select-nodepools[0].infra_env").click();
    await form.option("r760-mtl").click();
    await expect(page.getByTestId("nodepool-0-zones-note")).toContainText("In 3 zones on this MCE (az1, az2, az3): one NodePool in each");
    for (const infraEnv of AZ) await expect(zone(page, infraEnv).getByRole("spinbutton")).toHaveValue("2");
    await zone(page, AZ[1]).getByRole("spinbutton").fill("0");
    await page.getByLabel("Nodepool 1 name suffix").fill("gpu");
    await expect(page.getByTestId("nodepool-0-name-preview")).toContainText(`NodePools ${AZ.map((z) => `${z}-gpu`).join(", ")}`);
    await expect(zone(page, AZ[2])).toContainText(`${AZ[2]}-gpu`);
    await expect(page.getByTestId("nodepool-0-zones-total")).toContainText("4 nodes in 3 NodePools");
    await expect.poll(() => needs.at(-1)).toEqual([`${AZ[0]}:2`, `${AZ[2]}:2`]);

    await form.review();
    await expect(form.reviewDialog).toBeVisible();
    expect(sent(previews)).toEqual({
      name_suffix: "gpu",
      configs: STATIC,
      node_type: "r760-mtl",
      zones: [
        { infra_env: AZ[0], replicas: 2 },
        { infra_env: AZ[1], replicas: 0 },
        { infra_env: AZ[2], replicas: 2 },
      ],
    });
  });

  test("a node type in one zone is one NodePool, sent as that InfraEnv", async ({ page }) => {
    const { form, previews } = await openCreate(page, flavor({}));
    await page.getByTestId("infra-env-select-nodepools[0].infra_env").click();
    await form.option("g12-mtl").click();
    await expect(page.getByTestId("nodepool-0-zones-note")).toHaveText("In one zone on this MCE (az1): one NodePool.");
    await expect(page.getByTestId("nodepool-0-zones")).toHaveCount(0);
    await form.review();
    await expect(form.reviewDialog).toBeVisible();
    expect(sent(previews)).toMatchObject({ infra_env: "g12-mtl-az1", replicas: 2 });
    expect(sent(previews)).not.toHaveProperty("zones");
  });

  test("a flavor's node type is preset, and its locked replicas hold in every zone", async ({ page }) => {
    const { form, previews } = await openCreate(page, flavor({ node_type: "r760-mtl", replicas: 3 }, ["nodepools[0].replicas"]));
    for (const infraEnv of AZ) {
      await expect(zone(page, infraEnv).getByRole("spinbutton")).toHaveValue("3");
      await expect(zone(page, infraEnv).getByRole("spinbutton")).toHaveAttribute("readonly", "");
    }
    await expect(page.getByTestId("nodepool-0-zones-total")).toContainText("every zone the same: locked by the flavor");
    await form.review();
    await expect(form.reviewDialog).toBeVisible();
    expect(sent(previews)).toMatchObject({ replicas: 3, node_type: "r760-mtl", zones: AZ.map((z) => ({ infra_env: z, replicas: 3 })) });
  });

  test("a flavor's older InfraEnv is one zone until it is spread over every zone", async ({ page }) => {
    await openCreate(page, flavor({ infra_env: AZ[1] }));
    await expect(page.getByTestId("nodepool-0-one-zone")).toContainText("Only r760-mtl · az2: the flavor names this one InfraEnv");
    await expect(page.getByTestId("nodepool-0-zones")).toHaveCount(0);
    await page.getByTestId("nodepool-0-spread").click();
    await expect(page.getByTestId("nodepool-0-zones")).toBeVisible();
    await expect(zone(page, AZ[0])).toBeVisible();
  });

  test("without the MCE's list the node type is typed with its zone, one NodePool", async ({ page }) => {
    const { form, previews } = await openCreate(page, flavor({ node_type: "r760-mtl" }), true);
    await expect(page.getByTestId("infraenv-off")).toBeVisible();
    await expect(page.getByTestId("nodepool-0-typed-node-type")).toContainText("The flavor's node type is r760-mtl: type one of its zones as one name.");
    await page.getByLabel("Nodepool 1 node type and zone").fill(AZ[0]);
    await form.review();
    await expect(form.reviewDialog).toBeVisible();
    expect(sent(previews)).toMatchObject({ infra_env: AZ[0], replicas: 2 });
    expect(sent(previews)).not.toHaveProperty("node_type");
  });
});

// ── The cluster page ─────────────────────────────────────────────────────────

const NAME = "ocp4-prod-zoned-site1-a";
const YAML = `owner:
  merkaz: "1"
mastertag: 4.16.27-x86_64
nodepool:
${AZ.map((z, i) => `- infraEnvName: ${z}\n  name: ${z}-gpu\n  replicas: ${[2, 0, 1][i]}\n  configs:\n  - name: workers-chrony-configuration\n`).join("")}- infraEnvName: g12-mtl-az1
  name: g12-mtl-az1
  replicas: 1
`;
const filePool = (infra: string, poolName: string, replicas: number) => ({
  name: poolName, infra_env_name: infra, additional_infra_env_names: [], replicas, allow_deletion: false,
  configs: ["workers-chrony-configuration"], node_labels: {}, tuning_config: null,
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
    nodepools: [...AZ.map((z, i) => filePool(z, `${z}-gpu`, [2, 0, 1][i])), filePool("g12-mtl-az1", "g12-mtl-az1", 1)],
    network: { vlan_id: null, dhcp_network: null, segment: null },
    cluster_name: null,
    automation_keys: [],
  },
  hosted_cluster: { cluster_name: "prod-zoned-site1-a", name: "openshift-prod-zoned-site1-a", namespace: "hcp-prod-zoned-site1-a" },
  naming: { follows_convention: true, env: "prod", short_name: "zoned", sequence: "a", problems: [] },
  mce_default_mastertag: "4.16.27-x86_64",
  problems: [],
  segments_manager: null,
};

async function openCluster(page: Page) {
  await base(page);
  await page.route(/\/api\/day1\/clusters\/[^/]+\/status\?/, (r) => json(r, {}, 501));
  await page.route(`**/api/day1/clusters/${NAME}?**`, (r) => json(r, DETAIL));
  await page.route(`**/api/day1/clusters/${NAME}/drift?**`, (r) => json(r, { cluster: NAME, site: SITE, mce: MCE, state: "not_linked", is_drifted: false, spec_name: null, spec_version: null, current_spec_version: null, value_drift: [], addon_drift: [], version_differences: [], error: null, update: null }));
  await page.route(`**/api/day2/clusters/${NAME}/**`, (r) => json(r, r.request().url().includes("/history") ? [] : { cluster: NAME, mce: MCE, id: `hosted:${SITE}:prod:${MCE}:${NAME}`, kind: "hosted", site: SITE, env: "prod", ocp_version: "4.16.27", installed: [], excluded: [], warnings: [], argocd_note: "" }));
  await go(page, `/clusters/${NAME}?site=${SITE}&mce=${MCE}`);
}

test.describe("A logical nodepool on the cluster page", () => {
  test("is one group on the Node pools card, each zone's NodePool under it", async ({ page }) => {
    await openCluster(page);
    const group = page.getByTestId("nodepool-group-0");
    await expect(group).toContainText("r760-mtl · gpu");
    await expect(group).toContainText("3 zones, 3 nodes: az1 2 · az2 0 · az3 1, one configuration");
    await expect(page.getByTestId("nodepool-group-3")).toHaveCount(0);
    await expect(page.getByTestId("nodepool-row-1")).toContainText("r760-mtl · az2");
  });

  test("is shown in Edit cluster, and a zone whose configuration differs is said", async ({ page }) => {
    await openCluster(page);
    await page.getByRole("button", { name: "Edit" }).click();
    const panel = page.getByTestId("edit-logical-pools");
    await expect(panel.getByTestId("edit-logical-pool-0")).toContainText("r760-mtl · gpu · 3 zones: az1 2 · az2 0 · az3 1");
    await page.getByLabel("Cluster file").fill(YAML.replace("replicas: 0\n  configs:\n  - name: workers-chrony-configuration", "replicas: 0\n  configs:\n  - name: nic-ring-buffer"));
    await expect(panel.getByRole("status")).toContainText(`${AZ[1]}-gpu has another configuration than the first zone's`);
  });
});
