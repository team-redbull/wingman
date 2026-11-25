import type { Page, Route } from "@playwright/test";
import { json } from "./api-handlers";
import { addonDetailOf } from "./addon-detail";
import { changeOf } from "./authoring";
import { HOSTED_ID, TWIN_IDS, problem } from "./day2";
import type { AddonDetail, AuthoringPlan, DestinationImpact } from "../../types/day2";

/**
 * An add-on's OCP-version pins (ADR-0043's 2026-11-25 amendment), mocked as
 * the service answers them (docs/notes/2026-11-12-day2-addon-authoring-api.md
 * §8): `POST /addons/{team}/{addon}/ocp-versions`, `PUT` and `DELETE
 * .../ocp-versions/{version}`, each a dry run first, then the write
 * confirming the dry run's `needs_confirmation` and `digest`.
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

function impactOf(detail: AddonDetail, version: string): DestinationImpact[] {
  return detail.scopes
    .flatMap((s) => s.destinations)
    .filter((d) => d.deployed && d.ocp_version === version)
    .map((d) => ({
      cluster: d.id,
      name: d.name,
      kind: d.kind,
      effect: "changed",
      app_name: `${detail.team}-${d.name}-${detail.name}-deploy`,
      changes: [{ stack: "deploy", key: "targetRevision", before: "2.45.0", after: "2.44.0" }],
      orphaned: false,
    }));
}

function pinPlan(method: string, detail: AddonDetail, version: string, body: Record<string, unknown>): AuthoringPlan {
  const folder = `operators/${detail.name}/ocp-versions/${version}`;
  const extra = method === "POST" ? ` (new: ${String(body.target_revision)})` : method === "DELETE" ? " (removed)" : "";
  const impact = impactOf(detail, version);
  return {
    team: detail.team,
    action: "update-default",
    chart: detail.name,
    scope: null,
    title: `[Wingman/Day2] Update addon ${detail.team}/${detail.name} OCP-version pin ${version}${extra}`,
    files: [
      method === "DELETE"
        ? { action: "delete", path: `${folder}/${detail.name}.yaml`, content: null, previous: "targetRevision: 2.44.0\n" }
        : { action: method === "POST" ? "create" : "update", path: `${folder}/${detail.name}.yaml`, content: `targetRevision: ${String(body.target_revision)}\n`, previous: null },
    ],
    reach: impact.map((i) => i.cluster),
    adopted: [],
    impact,
    excluded: [],
    needs_confirmation: impact.map((i) => i.cluster),
    warnings: [],
    notes: [`operators/${detail.name}/ocp-versions/${version}/ is read by every destination at OCP ${version} exactly.`],
    digest: `pin-digest-${method}-${version}`,
  };
}

/**
 * Route the pin writes, and the pinned add-ons' reads with the versions
 * above. Register after mockAddonDetail (route mocks match last registered first).
 */
export async function mockOcpPins(page: Page): Promise<PinRequests> {
  const seen: PinRequests = { writes: [] };
  await page.route(/\/api\/day2\/teams\/(observability\/addons\/prometheus|platform\/addons\/external-secrets)(\?.*)?$/, (r) => {
    const p = new URL(r.request().url()).pathname.split("/").map(decodeURIComponent);
    return json(r, withVersions(addonDetailOf(p[4], p[6]) as AddonDetail));
  });
  const write = (r: Route) => {
    const request = r.request();
    const url = new URL(request.url());
    const p = url.pathname.split("/").map(decodeURIComponent);
    const detail = withVersions(addonDetailOf(p[4], p[5]) as AddonDetail);
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    const dryRun = url.searchParams.get("dry_run") === "true";
    seen.writes.push({ method: request.method(), path: url.pathname, dryRun, body });
    const plan = pinPlan(request.method(), detail, p[7] ?? String(body.version), body);
    if (dryRun) return json(r, plan);
    if (body.expected_digest !== plan.digest || JSON.stringify(body.confirm_changes) !== JSON.stringify(plan.needs_confirmation))
      return r.fulfill(problem(422, "VALIDATION_ERROR", "confirm what the preview listed", { rule: "confirm-changes" }));
    return json(r, { ...changeOf(plan), impact: plan.impact, needs_confirmation: plan.needs_confirmation, digest: plan.digest }, request.method() === "POST" ? 201 : 200);
  };
  await page.route(/\/api\/day2\/addons\/[^/?]+\/[^/?]+\/ocp-versions(\?.*)?$/, write);
  await page.route(/\/api\/day2\/addons\/[^/?]+\/[^/?]+\/ocp-versions\/[^/?]+(\?.*)?$/, write);
  return seen;
}
