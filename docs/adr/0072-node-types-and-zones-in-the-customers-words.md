# ADR-0072: A customer picks a node type and its zones; an InfraEnv is a node type in one zone

Date: 2026-11-27
Status: Accepted

## Context

The user (2026-11-27): "Node Type instead of InfraEnv for the customer view -
in order to talk in his type of words", and "the node type is r760-mtl but the
person should select and be given 3 different nodepools, 1 for each zone,
where each one contains the same config exactly. The infraenv + zone is just
for customer logic."

What there was:

- **The naming convention** (2026-11-22) names an InfraEnv
  `<flavor>-<size>-<zone>` (`r760-mtl-az1`; `<size>` is `mtl` or
  `kv<cpu>`) and labels it with its zone, `topology.kubernetes.io/zone`, in
  `spec.agentLabels`. InfraEnvs from before it (`dell-r660-site1-128c-1024gb-5tb`)
  name no zone.
- **Two parsers of the convention**: the web's Inventory Management filters
  (`lib/inventory/pool-filter.ts`) and day1's KV cluster create
  (`domain/kv_create.py`, bare metal only). Day1 read each InfraEnv's
  agentLabels (`infra_env_pools`) but never gave the zone to the web:
  `GET /mces/{mce}/infraenvs` lists names only.
- **"Node type" meant something else**: placement's name for the InfraEnv
  (or InfraEnvs, ADR-0064) a nodepool draws from, `node_type()` in
  `mce_capacity`, each candidate's `node_types` in `GET /placement`.
- **The customer's pages** (the Customers workspace, ADR-0067: Clusters,
  Flavors, Add-ons, Approvals, Audit, Lints, and the docs) said "InfraEnv" and
  "Infra Env" wherever a nodepool's servers were named.

## Decision

1. **A node type is an InfraEnv's name without its zone.** Under the
   convention, `r760-mtl-az1`, `r760-mtl-az2` and `r760-mtl-az3` are node
   type `r760-mtl` in zones `az1` to `az3`. A name off the convention is its
   own node type with one zone. The node type is always read from the name
   alone, so a cluster file's NodePools are grouped the same way whether the
   MCE is read or not.
2. **The zone is the hub's label where the hub is read**, the InfraEnv's
   `topology.kubernetes.io/zone` agentLabel, **else the name's**; a legacy
   name without the label has an unnamed zone (shown "one zone").
3. **One parser per side.** Day1's is `wingman_day1.domain.node_types`
   (`parse`, `split`, `zone_of`, `node_types`), which KV create now uses for
   its bare-metal pools; the web's is `apps/web/lib/node-types.ts`, which
   Inventory Management's filters now use. No third regex.
4. **`GET /api/day1/mces/{mce}/node-types`** (admins, 501 when live status
   is off, as `/infraenvs`) gives each node type with its zones,
   `[{name, zones: [{zone, infra_env}]}]`, sorted by name and zones in natural
   order. `/infraenvs` keeps its shape for its callers.
5. **Placement's concept is a server pool.** What placement called a node
   type is a **server pool**: the InfraEnvs a nodepool draws from (a zone of
   a node type, or several InfraEnvs, ADR-0064). `server_pool()`,
   `PoolSupply`, and each candidate's `server_pools` (was `node_types`) in
   `GET /placement`; "node type" has one meaning.
6. **The customer's words.** The Customers workspace and its docs say
   "node type" and "zone"; an InfraEnv is shown as `r760-mtl · az1`. The
   Infrastructure workspace (Inventory Management, MCEs, seeds and KV
   clusters) keeps "InfraEnv", where the objects are the platform's.

## Alternatives rejected

- **The node type from the zone label** (the name less `-<label>`): a cluster
  file has no labels, so its NodePools would group one way on the cluster page
  and another in drift.
- **Changing `/infraenvs` to objects**: every caller and every mocked test
  would change for a field only the create form needs.
- **Keeping placement's "node type"**: the same words would mean `r760-mtl`
  on the form and `r760-mtl-az1 + r760-mtl-az2` in the placement panel.

## Consequences

- `GET /placement`'s candidates carry `server_pools`, not `node_types`: a
  caller outside the web reading that field must follow
  (`docs/notes/2026-11-12-mce-placement-api.md`).
- An InfraEnv without the zone label and off the convention is one node type
  in one unnamed zone: nothing groups it with another.
- The dev fleet's `ocp4-prod-mce-site1-a` has `r760-mtl` in three zones.

## Verification

- `apps/day1-service/tests/unit/domain/test_node_types.py`: the convention,
  a legacy name, the label over the name, the grouping and its order.
- `apps/day1-service/tests/api/test_status_api.py`: `/node-types` groups an
  MCE's InfraEnvs by zone, 501 when live status is off, 403 for a viewer.
- `apps/web/lib/node-types.test.ts`: the parser, the labels, a node type
  found for an InfraEnv.
- The placement suites (`test_placement_api.py`, `mce-placement.spec.ts`)
  read `server_pools`.
