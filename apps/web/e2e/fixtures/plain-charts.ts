import type { Page, Route } from "@playwright/test";
import type { AddonChart, AddonOperator } from "../../types/day2";

/**
 * ADR-0073's two reads, which every add-on page, the Addons list's dialog
 * and New add-on make: unless a test says otherwise (e2e/fixtures/operator.ts),
 * every add-on is a plain chart, and a new add-on's chart repo has one branch.
 * Imports nothing from api-handlers.ts, which registers it.
 */

/** `GET /addons/{team}/{addon}/operator` of a chart with no OLM Subscription in its values. */
function plainOperator(team: string, chart: string): AddonOperator {
  return {
    team,
    chart,
    is_operator: false,
    editable: false,
    reason: `The chart's values hold no OLM Subscription: ${chart} is a plain chart.`,
    revision: "HEAD",
    key_path: null,
    subchart: null,
    chart_values_problem: null,
    sig: null,
    pins: [],
    versions: [],
    catalog: { configured: false, source: null, minors: [] },
    warnings: [],
  };
}

const fulfill = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The chart repo a `repourl` names on the mocked GitLab: `team/helm-charts/x`. */
export function projectOf(repourl: string): string | null {
  try {
    return new URL(repourl).pathname.replace(/^\//, "").replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
}

export async function mockPlainCharts(page: Page) {
  await page.route(/\/api\/day2\/addons\/[^/?]+\/[^/?]+\/operator(\?.*)?$/, (r) => {
    const [team, chart] = new URL(r.request().url()).pathname.split("/").slice(4, 6).map(decodeURIComponent);
    return fulfill(r, plainOperator(team, chart));
  });
  await page.route(/\/api\/day2\/teams\/[^/?]+\/addon-chart(\?.*)?$/, (r) => {
    const url = new URL(r.request().url());
    const team = decodeURIComponent(url.pathname.split("/")[4]);
    const repourl = url.searchParams.get("repourl") ?? "";
    const project = projectOf(repourl);
    const answer: AddonChart = {
      repourl,
      project,
      revisions: project ? ["main"] : [],
      problem: project ? null : "Not a chart repo on this GitLab.",
      operator: plainOperator(team, project?.split("/").at(-1) ?? ""),
    };
    return fulfill(r, answer);
  });
}
