import type { Page } from "@playwright/test";
import { json } from "./api-handlers";
import { catalogEntry } from "./addons";
import { MANUAL, TEAMS } from "./authoring";
import { day2Catalog } from "./day2";
import { answerEdit, type PinRequests } from "./ocp-pins";
import { projectOf } from "./plain-charts";
import type {
  AddonChart,
  AddonDetail,
  AddonOperator,
  CatalogEntry,
  CatalogMinor,
  FleetScope,
  OperatorFacts,
  OperatorPin,
  OperatorSettings,
  RepoFile,
  ScopeDestination,
  ScopePanel,
  Team,
} from "../../types/day2";

/**
 * An add-on that installs an OLM operator (ADR-0073), shaped like day2's
 * answers (docs/notes/2026-11-12-day2-addon-authoring-api.md §9) and like the
 * service's dev fixture: redbull/cert-manager vendors operator-olm
 * (`operator-olm.subscription`: openshift-cert-manager-operator in
 * cert-manager-operator, own-namespace, channel stable-v1). Its Sig values
 * set stable-v1; pin 4.16.27 pins chart 1.14.0 and stable-v1.14, pin 4.20.9
 * is values only, on stable-v1.15. herzi runs 4.16.27, eyal 4.20.9. The
 * mirrored catalog has 4.16 (an ImageSetConfiguration: channels, no
 * versions) and 4.20 (with the file-based catalog: versions too).
 */

const TEAM = "redbull";
const CHART = "cert-manager";
export const HERZI = { id: "hosted:site1:prod:ocp4-prod-mce-site1-a:ocp4-prod-herzi-site1", name: "ocp4-prod-herzi-site1", version: "4.16.27" };
export const EYAL = { id: "hosted:site1:prep:ocp4-prep-mce-site1-a:ocp4-prep-eyal-site1", name: "ocp4-prep-eyal-site1", version: "4.20.9" };
export const BRANCHES = ["main", "1.15.0", "1.14.0"];

const SIG_VALUES = { "operator-olm": { subscription: { channel: "stable-v1" } } };
const PIN_4_20_VALUES = { "operator-olm": { subscription: { channel: "stable-v1.15" } } };
const commit = `${TEAM}-repo-1`;

const OPERATOR_ENTRY: CatalogEntry = catalogEntry({
  team: TEAM,
  name: CHART,
  current_version: "HEAD",
  available_versions: BRANCHES,
  default_values: SIG_VALUES,
  ocp_version_pins: [
    { version: HERZI.version, target_revision: "1.14.0" },
    { version: EYAL.version, target_revision: null },
  ],
  fleet_defaults: ["hosted-clusters"],
  argocd_metadata: {
    projectNamespace: "cert-manager-operator",
    repourl: `https://gitlab.example.com/${TEAM}/helm-charts/${CHART}.git`,
    targetRevision: "HEAD",
    syncPolicy: { syncOptions: ["CreateNamespace=true"] },
    path: ".",
  },
});

const REDBULL: Team = { ...TEAMS[2], name: TEAM, project_id: 9, path_with_namespace: `sigs/${TEAM}`, web_url: `https://gitlab.example.com/sigs/${TEAM}` };

function file(path: string, text: string | null, values: Record<string, unknown> = {}): RepoFile {
  return { path, exists: text !== null, text, values, last_commit_id: text !== null ? commit : null, problem: null };
}

function destination(d: typeof HERZI): ScopeDestination {
  const [, site, env, mce] = d.id.split(":");
  return {
    id: d.id,
    name: d.name,
    kind: "hosted",
    site,
    env,
    mce,
    ocp_version: d.version,
    renders: true,
    state: "default",
    deployed: true,
    app_name: `${TEAM}-${d.name}-${CHART}-deploy`,
    override: file(`defaults/hosted-clusters/${CHART}/values-${d.name}.yaml`, null),
    override_shared_with: [],
    own_folder: null,
    own_deploy: null,
  };
}

function panel(scope: FleetScope, label: string, destinations: ScopeDestination[]): ScopePanel {
  const folder = `defaults/${scope}/${CHART}`;
  const isDefault = destinations.length > 0;
  return {
    scope,
    label,
    noun: scope,
    is_default: isDefault,
    folder,
    values_file: file(`${folder}/values.yaml`, isDefault ? "{}\n" : null),
    deploy_config: file(`${folder}/${CHART}.yaml`, null),
    sync: MANUAL,
    sync_overridden: false,
    env_files: [],
    exclusions: scope === "hub" ? null : { path: `defaults/${scope}/exclusions.yaml`, exists: false, names: [], unknown_names: [], last_commit_id: commit },
    destinations,
    unregistered: [],
    last_commit_id: commit,
  };
}

/** `GET /teams/redbull/addons/cert-manager`. */
function operatorDetail(): AddonDetail {
  const op = `operators/${CHART}`;
  return {
    team: TEAM,
    name: CHART,
    in_catalog: true,
    writable: true,
    read_only_reason: null,
    catalog: OPERATOR_ENTRY,
    deploy_config: file(`${op}/${CHART}.yaml`, `repourl: ${OPERATOR_ENTRY.argocd_metadata.repourl}\nprojectNamespace: cert-manager-operator\n`),
    values_file: file(`${op}/values.yaml`, "# the channel every cluster gets, unless its version's pin says otherwise\noperator-olm:\n  subscription:\n    channel: stable-v1\n", SIG_VALUES),
    ocp_versions: [
      {
        version: HERZI.version,
        target_revision: "1.14.0",
        deploy_config: file(`${op}/ocp-versions/${HERZI.version}/${CHART}.yaml`, "targetRevision: 1.14.0\n", { targetRevision: "1.14.0" }),
        values_file: file(`${op}/ocp-versions/${HERZI.version}/values.yaml`, "operator-olm:\n  subscription:\n    channel: stable-v1.14\n", {
          "operator-olm": { subscription: { channel: "stable-v1.14" } },
        }),
        last_commit_id: commit,
      },
      {
        version: EYAL.version,
        target_revision: null,
        deploy_config: file(`${op}/ocp-versions/${EYAL.version}/${CHART}.yaml`, null),
        values_file: file(`${op}/ocp-versions/${EYAL.version}/values.yaml`, "operator-olm:\n  subscription:\n    channel: stable-v1.15\n", PIN_4_20_VALUES),
        last_commit_id: commit,
      },
    ],
    scopes: [
      panel("hosted-clusters", "every hosted cluster", [destination(HERZI), destination(EYAL)]),
      panel("mces", "every MCE", []),
      panel("hub", "the hub", []),
      panel("upi", "every UPI cluster", []),
    ],
    warnings: [],
  };
}

function facts(channel: string, defaults: boolean): OperatorFacts {
  return {
    package: "openshift-cert-manager-operator",
    namespace: "cert-manager-operator",
    channel,
    starting_csv: "",
    install_plan_approval: defaults ? "Automatic" : null,
    source: defaults ? "generic-cs" : null,
    source_namespace: defaults ? "openshift-marketplace" : null,
    install_mode: "own-namespace",
    target_namespaces: ["cert-manager-operator"],
    defaulted: defaults ? ["install_plan_approval", "source", "source_namespace"] : [],
  };
}

const own = (channel: string | null): OperatorSettings => ({ channel, starting_csv: null, install_plan_approval: null });

function pin(version: string, revision: string | null, channel: string): OperatorPin {
  return {
    version,
    minor: version.split(".").slice(0, 2).join("."),
    target_revision: revision,
    path: `operators/${CHART}/ocp-versions/${version}/values.yaml`,
    own: own(channel),
    effective: facts(channel, true),
    destinations: 1,
  };
}

const VERSIONS_4_20 = ["cert-manager-operator.v1.15.1", "cert-manager-operator.v1.15.0", "cert-manager-operator.v1.14.2"];

const MINORS: CatalogMinor[] = [
  {
    minor: "4.16",
    files: ["mirror/imageset-config-4.16.yaml"],
    problems: [],
    package: {
      name: "openshift-cert-manager-operator",
      default_channel: "stable-v1",
      channels: [
        { name: "stable-v1", is_default: true, head: null, versions: [], min_version: null, max_version: null },
        { name: "stable-v1.14", is_default: false, head: null, versions: [], min_version: null, max_version: null },
      ],
    },
  },
  {
    minor: "4.20",
    files: ["mirror/imageset-config-4.20.yaml", "catalogs/4.20/catalog.json"],
    problems: [],
    package: {
      name: "openshift-cert-manager-operator",
      default_channel: "stable-v1",
      channels: [
        { name: "stable-v1", is_default: true, head: VERSIONS_4_20[0], versions: VERSIONS_4_20, min_version: "1.14.0", max_version: null },
        { name: "stable-v1.15", is_default: false, head: VERSIONS_4_20[0], versions: VERSIONS_4_20.slice(0, 2), min_version: "1.15.0", max_version: null },
      ],
    },
  },
];

/** `GET /addons/redbull/cert-manager/operator`; `catalog: false` is Wingman without the catalog setting. */
function operatorOf({ catalog = true, sigOwn = own("stable-v1"), pins = true }: { catalog?: boolean; sigOwn?: OperatorSettings; pins?: boolean } = {}): AddonOperator {
  return {
    team: TEAM,
    chart: CHART,
    is_operator: true,
    editable: true,
    reason: null,
    revision: "HEAD",
    key_path: "operator-olm.subscription",
    subchart: "operator-olm",
    chart_values_problem: null,
    chart_level: facts("stable-v1", false),
    sig: { path: `operators/${CHART}/values.yaml`, own: sigOwn, effective: facts(sigOwn.channel ?? "stable-v1", true) },
    pins: pins ? [pin(HERZI.version, "1.14.0", "stable-v1.14"), pin(EYAL.version, null, "stable-v1.15")] : [],
    versions: [
      { version: HERZI.version, minor: "4.16", destinations: 1, pinned: pins },
      { version: EYAL.version, minor: "4.20", destinations: 1, pinned: pins },
    ],
    catalog: catalog
      ? { configured: true, source: "redbull/operator-catalog@main: mirror/imageset-config-{minor}.yaml, catalogs/{minor}/catalog.json", minors: MINORS }
      : { configured: false, source: null, minors: [] },
    warnings: [],
  };
}

/**
 * Route redbull/cert-manager: the team, the catalog with it, its page, its
 * operator, its Edit add-on PUT, and a New add-on's chart read for any chart
 * named cert-manager. Register after mockAddonDetail (LIFO).
 */
export async function mockOperator(page: Page, { catalog = true }: { catalog?: boolean } = {}): Promise<PinRequests> {
  const seen: PinRequests = { writes: [] };
  await page.route("**/api/day2/teams", (r) => json(r, [...TEAMS, REDBULL]));
  await page.route("**/api/day2/addons", (r) => json(r, [...day2Catalog, OPERATOR_ENTRY]));
  await page.route(/\/api\/day2\/teams\/redbull\/addons\/cert-manager(\?.*)?$/, (r) => json(r, operatorDetail()));
  await page.route(/\/api\/day2\/addons\/redbull\/cert-manager\/operator(\?.*)?$/, (r) => json(r, operatorOf({ catalog })));
  await page.route(/\/api\/day2\/addons\/redbull\/cert-manager(\?.*)?$/, (r) =>
    r.request().method() === "PUT" ? answerEdit(r, operatorDetail(), seen) : r.fallback(),
  );
  await page.route(/\/api\/day2\/teams\/[^/?]+\/addon-chart(\?.*)?$/, (r) => {
    const repourl = new URL(r.request().url()).searchParams.get("repourl") ?? "";
    const project = projectOf(repourl);
    if (!project?.endsWith(`/${CHART}`)) return r.fallback();
    const answer: AddonChart = { repourl, project, revisions: BRANCHES, problem: null, operator: operatorOf({ catalog, sigOwn: own(null), pins: false }) };
    return json(r, answer);
  });
  return seen;
}
