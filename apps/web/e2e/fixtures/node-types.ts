import type { Route } from "@playwright/test";
import { splitInfraEnv } from "../../lib/node-types";
import type { NodeType } from "../../types";

/**
 * An MCE's InfraEnvs (`GET /mces/{mce}/infraenvs`, Edit cluster's list) and
 * its node types (`GET /mces/{mce}/node-types`, the create form's, ADR-0072):
 * one route for both, so a spec names the InfraEnvs once.
 */
export const INFRA_ENVS = /\/api\/day1\/mces\/[^/]+\/(infraenvs|node-types)(\?.*)?$/;

/** The node types `names` make, as day1 groups them: by the name less its zone, the zone from the name. */
function nodeTypesOf(names: readonly string[]): NodeType[] {
  const types = new Map<string, NodeType>();
  for (const name of names) {
    const { nodeType, zone } = splitInfraEnv(name);
    const type = types.get(nodeType) ?? { name: nodeType, zones: [] };
    type.zones.push({ zone, infra_env: name });
    types.set(nodeType, type);
  }
  return [...types.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the route answers for `names`: the names themselves, or the node types they make. */
export const infraEnvsBody = (route: Route, names: readonly string[]): unknown =>
  new URL(route.request().url()).pathname.endsWith("/node-types") ? nodeTypesOf(names) : names;
