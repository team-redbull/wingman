import type { Page, Route } from "@playwright/test";
import { json } from "./api-handlers";
import { addonDetailOf } from "./addon-detail";
import { changeOf } from "./authoring";
import { HOSTED_ID, TWIN_IDS, problem } from "./day2";
import type { AddonDetail, AuthoringPlan, DestinationImpact, PinEditIn, PlannedFileChange } from "../../types/day2";

/**
 * An add-on's OCP-version pins (ADR-0043's 2026-11-25 amendment), edited in
 * Edit add-on's one `PUT /addons/{team}/{addon}` (ADR-0073), mocked as the
 * service answers it (docs/notes/2026-11-12-day2-addon-authoring-api.md §9):
 * a dry run first, then the write confirming the dry run's
 * `needs_confirmation` and `digest`.
 *
 * observability/prometheus is the pinned add-on of the mocked world
 * (4.18.22 on 2.44.0). Here its destinations run two versions: the hosted
 * cluster and the MCE 4.18.22, the twins 4.19.10 (one of them with
 * prometheus). platform/external-secrets' default on every hosted cluster
 * sets its own revision, the footgun the pins card warns of.
 */

export const NEXT_VERSION = "4.19.10";
export const DEPLOYING_TWIN = TWIN_IDS[0];

function withVersions(detail: AddonDetail): AddonDetail {
  if (detail.team === "platform" && detail.name === "external-secrets") {
    return {
      ...detail,
      scopes: detail.scopes.map((s) =>
        s.scope === "hosted-clusters" ? { ...s, deploy_config: { ...s.deploy_config, exists: true, text: "targetRevision: 0.9.0\n", values: { targetRevision: "0.9.0" } } } : s,
      ),
    };
  }
  if (detail.team !== "observability" || detail.name !== "prometheus") return detail;
  return {
    ...detail,
    scopes: detail.scopes.map((s) => ({
      ...s,
      destinations: s.destinations.map((d) =>
        TWIN_IDS.includes(d.id)
          ? { ...d, ocp_version: NEXT_VERSION, deployed: d.id === DEPLOYING_TWIN }
          : d.id === HOSTED_ID
            ? { ...d, deployed: true }
            : d,
      ),
    })),
  };
}

/** What the mocked page sent. */
export interface PinRequests {
  writes: { method: string; path: string; dryRun: boolean; body: Record<string, unknown> }[];
}

type Body = Record<string, unknown>;

const SIG_KEYS = ["repourl", "target_revision", "path", "project_namespace", "sync", "ignore_differences", "values", "operator"];

/** The versions a body's pins touch: each one's version, the folder it moves from, and each removal. */
function touched(body: Body): string[] {
  const pins = (body.ocp_versions as PinEditIn[] | undefined) ?? [];
  return [...pins.flatMap((p) => [p.version, p.from_version ?? p.version]), ...((body.remove_ocp_versions as string[] | undefined) ?? [])];
}

/** The MR title, as §9 gives it. */
function titleOf(detail: AddonDetail, body: Body): string {
  const pins = ((body.ocp_versions as PinEditIn[] | undefined) ?? []).map((p) =>
    !p.from_version ? `${p.version} (new)` : p.from_version !== p.version ? `${p.version} (moved from ${p.from_version})` : p.version,
  );
  const parts = [...pins, ...((body.remove_ocp_versions as string[] | undefined) ?? []).map((v) => `${v} (removed)`)];
  const sig = SIG_KEYS.some((k) => k in body);
  const what = [sig ? "Sig values" : "", parts.length > 0 ? `OCP-version pins ${parts.join(", ")}` : ""].filter(Boolean).join(" and ");
  return `[Wingman/Day2] Update addon ${detail.team}/${detail.name} ${what}`;
}

function filesOf(detail: AddonDetail, body: Body): PlannedFileChange[] {
  const op = `operators/${detail.name}`;
  const pins = (body.ocp_versions as PinEditIn[] | undefined) ?? [];
  const removed = (body.remove_ocp_versions as string[] | undefined) ?? [];
  return [
    ...(SIG_KEYS.some((k) => k in body) ? [{ action: "update", path: `${op}/values.yaml`, content: "# the team's values\n", previous: null }] : []),
    ...pins.map((p) => ({ action: p.from_version ? "update" : "create", path: `${op}/ocp-versions/${p.version}/values.yaml`, content: "{}\n", previous: null })),
    ...removed.map((v) => ({ action: "delete", path: `${op}/ocp-versions/${v}/${detail.name}.yaml`, content: null, previous: "targetRevision: 2.44.0\n" })),
  ];
}

/**
 * The plan of Edit add-on's PUT: the title and files from the body, and
 * each app it changes: every one for a Sig change, else those at the
 * versions its pins touch.
 */
function editPlan(detail: AddonDetail, body: Body): AuthoringPlan {
  const versions = touched(body);
  const sig = SIG_KEYS.some((k) => k in body);
  const impact: DestinationImpact[] = detail.scopes
    .flatMap((s) => s.destinations)
    .filter((d) => d.deployed && (sig || versions.includes(d.ocp_version ?? "")))
    .map((d) => ({
      cluster: d.id,
      name: d.name,
      kind: d.kind,
      effect: "changed",
      app_name: `${detail.team}-${d.name}-${detail.name}-deploy`,
      changes: [{ stack: "values", key: "operator-olm.subscription.channel", before: "stable-v1", after: "stable-v1.15" }],
      orphaned: false,
    }));
  return {
    team: detail.team,
    action: "update-team-default",
    chart: detail.name,
    scope: null,
    title: titleOf(detail, body),
    files: filesOf(detail, body),
    reach: impact.map((i) => i.cluster),
    adopted: [],
    impact,
    excluded: [],
    needs_confirmation: impact.map((i) => i.cluster),
    warnings: [],
    notes: versions.map((v) => `operators/${detail.name}/ocp-versions/${v}/ is read by every destination at OCP ${v} exactly.`),
    digest: `edit-digest-${detail.name}-${versions.join("-")}`,
  };
}

/** Answer a PUT of Edit add-on for `detail`: the plan, or the MR once its preview is confirmed. */
export function answerEdit(r: Route, detail: AddonDetail, seen: PinRequests) {
  const request = r.request();
  const url = new URL(request.url());
  const body = (request.postDataJSON() ?? {}) as Body;
  const dryRun = url.searchParams.get("dry_run") === "true";
  seen.writes.push({ method: request.method(), path: url.pathname, dryRun, body });
  const plan = editPlan(detail, body);
  if (dryRun) return json(r, plan);
  if (body.expected_digest !== plan.digest || JSON.stringify(body.confirm_changes) !== JSON.stringify(plan.needs_confirmation))
    return r.fulfill(problem(422, "VALIDATION_ERROR", "confirm what the preview listed", { rule: "confirm-changes" }));
  return json(r, { ...changeOf(plan), impact: plan.impact, needs_confirmation: plan.needs_confirmation, digest: plan.digest });
}

/**
 * Route the pinned add-ons' reads with the versions above, and their Edit
 * add-on PUTs that carry pins. Register after mockAddonDetail (route mocks
 * match last registered first).
 */
export async function mockOcpPins(page: Page): Promise<PinRequests> {
  const seen: PinRequests = { writes: [] };
  const pinned = /\/api\/day2\/teams\/(observability\/addons\/prometheus|platform\/addons\/external-secrets)(\?.*)?$/;
  await page.route(pinned, (r) => {
    const p = new URL(r.request().url()).pathname.split("/").map(decodeURIComponent);
    return json(r, withVersions(addonDetailOf(p[4], p[6]) as AddonDetail));
  });
  await page.route(/\/api\/day2\/addons\/(observability\/prometheus|platform\/external-secrets)(\?.*)?$/, (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Body;
    if (r.request().method() !== "PUT" || !("ocp_versions" in body || "remove_ocp_versions" in body)) return r.fallback();
    const p = new URL(r.request().url()).pathname.split("/").map(decodeURIComponent);
    return answerEdit(r, withVersions(addonDetailOf(p[4], p[5]) as AddonDetail), seen);
  });
  return seen;
}
