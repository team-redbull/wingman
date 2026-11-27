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

### Logical and physical NodePools

7. **A logical nodepool is a node type, one config and replicas per zone.**
   What the customer sees and edits; behind it, one **physical** NodePool per
   zone of that node type on the cluster's MCE, each with exactly the same
   config (configs, node labels, tuning profiles, scale-down policy, name
   suffix), `infraEnvName` its zone's InfraEnv, and its own replicas. Each is
   named `<InfraEnv>[-<suffix>]` (ADR-0071), the suffix the group's:
   `r760-mtl-az1-gpu`, `r760-mtl-az2-gpu`, ...
8. **The create request carries it; day1 spreads it.** A create's
   `nodepools[i]` may give `node_type` and `zones: [{infra_env, replicas}]`
   (`wingman_day1.domain.zone_inputs`). The flavor's positions, presets,
   locks and ratio stay logical: `nodepools[i]` is the logical nodepool. Day1
   checks it (the zones are InfraEnvs of one node type, each once, replicas
   whole and at least 0, one at least in all; no `infra_env` or other
   InfraEnvs beside `zones`), names each zone's NodePool and finds a clash
   across nodepools, then spreads it into physical nodepools in zone order
   before the render. The template and the cluster file see physical
   nodepools only: **no new key in the cluster file**. A nodepool without
   `zones` is physical, as before.
9. **Every zone is written, 0 replicas allowed.** The specs template writes
   `replicas: 0` as given (`default(2)` applies only to a missing key),
   placement leaves a 0 out of its needs (the web's `need` and day1's
   `file_needs`), the provision-cluster workflow checks a nodepool's list and
   configs but not its replicas, and HyperShift runs a NodePool at 0. So the
   group always has its full shape, and a zone can grow later without adding
   a NodePool.
10. **Locks and the ratio hold per zone.** A flavor's locked `replicas` on a
    logical nodepool fixes every zone's (`zone_inputs.lock_conflicts`); its
    configs, node labels and scale-down policy are the group's one config. A
    ratio (ADR-0040) sizes every zone of a sized nodepool: each zone gets
    `ratio[i] × size`, and the zones grow together. Without a ratio, each zone
    starts at the flavor's preset replicas (else the template's 2) and the
    customer sets each.
11. **A flavor presets a node type, never zones.** `nodepools[i].node_type` is
    a preset (a DNS label that is not an InfraEnv of the convention, and not
    beside an `infra_env`); `zones` are the MCE's and refused at save
    (`zone_inputs.flavor_problems`). A flavor that presets an `infra_env`
    (before node types) still works: that nodepool is physical, in that one
    zone.
12. **Drift, sync and import group by logical nodepool.** The group is read
    from the file's names alone (`wingman_day1.domain.logical_pools`): entries
    whose InfraEnvs are one node type and whose names carry one suffix (a
    derived name has none) are one logical nodepool, in first-seen order; an
    entry named off the rule, or drawing from no InfraEnv, is one alone. A
    flavor position's lock holds on every NodePool of the file's logical
    nodepool there, so a zone-spread cluster shows no false drift, each
    drifted zone is its own line (by its NodePool), and a sync sets every zone
    alike and keeps the group's shape (it adds and removes no NodePool). While
    the file has fewer groups than the flavor has nodepools (a cluster made
    before node types from a flavor that preset one zone's InfraEnv per
    position), each position stays one entry, as before.
13. **The create form.** A nodepool's **Node type** picker lists the MCE's
    node types with their zones; a node type in several zones gives a row per
    zone with its replicas (starting at the nodepool's, 0 allowed, read-only
    under a ratio or a lock) and its NodePool's name, and the request carries
    `node_type` and every zone. A node type in one zone is one NodePool, sent
    as that zone's InfraEnv exactly as before. The node types are those of the
    MCE placement picked last: placement checks the servers each zone needs,
    so a new pick has every zone the last needs named and the needs settle.
    Without the MCE's list (live status off, or the read failed) the node type
    is typed with its zone, one NodePool, and the form says so; a flavor's
    older InfraEnv preset is one zone until **Use every zone** spreads it.
14. **The cluster page.** The Node pools card shows a logical nodepool as one
    row (node type, suffix, each zone's replicas) with its NodePools under it;
    Edit cluster's **Nodepools by node type** lists them and says when a
    zone's configuration is no longer the others'. The Scale views, a scale
    run and the uninstall dialog name each NodePool's node type and zone.

### Left for later

- **Editing a logical nodepool's configuration at once** in Edit cluster:
  the YAML editor edits each NodePool, and the panel only warns when zones
  differ; a group-wide edit (configs, labels, tuning, policy written to every
  zone's entry) is the next step.
- **Scale by logical nodepool**: update-nodepool scales one NodePool a run,
  so Scale stays per zone's NodePool.
- **A zone the MCE gains later** gets no NodePool: sync adds none (ADR-0037);
  Edit cluster can add one by hand.
- **Placement per candidate's own zones**: the needs are the last pick's
  zones; day1 resolving a node type's zones on each candidate MCE would let
  MCEs with other zone names compete.
- **Drift lines grouped by logical nodepool** in the web: each zone's
  difference is its own line today, by its NodePool.

## Alternatives rejected

- **The node type from the zone label** (the name less `-<label>`): a cluster
  file has no labels, so its NodePools would group one way on the cluster page
  and another in drift.
- **Changing `/infraenvs` to objects**: every caller and every mocked test
  would change for a field only the create form needs.
- **Keeping placement's "node type"**: the same words would mean `r760-mtl`
  on the form and `r760-mtl-az1 + r760-mtl-az2` in the placement panel.
- **The web spreading the zones** and sending physical nodepools: a flavor's
  locks, presets and ratio name positions, which would no longer be the
  flavor's, and every check would need the group back.
- **A key in the cluster file for the group** (an annotation or a label): the
  file is the chart's values file, and the names already carry the group.
- **Omitting a zone at 0 replicas**: the group's shape would change with its
  size, and a zone grown later would be a new NodePool to add by hand.

## Consequences

- `GET /placement`'s candidates carry `server_pools`, not `node_types`: a
  caller outside the web reading that field must follow
  (`docs/notes/2026-11-12-mce-placement-api.md`).
- An InfraEnv without the zone label and off the convention is one node type
  in one unnamed zone: nothing groups it with another.
- The dev fleet's `ocp4-prod-mce-site1-a` has `r760-mtl` in three zones.
- A specs template that drops a 0 (`default(2, true)`) refuses a create with
  a zone at 0 (`zone_inputs.rendered_problems`, `docs/upgrade/3.69-to-3.70.md`),
  rather than write the template's 2.
- A new cluster's file has more NodePools than its flavor has nodepools: one
  per zone. A 0-replica NodePool is a NodePool still: it shows on the
  cluster page and on the MCE, with no node.
- Two hand-made NodePools of one node type and suffix (an older cluster's
  derived names, `<clusterName>-r760-mtl-az1` and `-az2`) are one logical
  nodepool: a position's lock that held only the first now holds both.

## Verification

- `apps/day1-service/tests/unit/domain/test_node_types.py`: the convention,
  a legacy name, the label over the name, the grouping and its order.
- `apps/day1-service/tests/api/test_status_api.py`: `/node-types` groups an
  MCE's InfraEnvs by zone, 501 when live status is off, 403 for a viewer.
- `apps/web/lib/node-types.test.ts`: the parser, the labels, a node type
  found for an InfraEnv.
- The placement suites (`test_placement_api.py`, `mce-placement.spec.ts`)
  read `server_pools`.
- `apps/day1-service/tests/unit/domain/test_zone_inputs.py`: the spread,
  each zone's replicas, the checks, a locked replicas per zone, the ratio per
  zone, the zone names and a clash, a flavor's node type.
- `apps/day1-service/tests/unit/domain/test_logical_pools.py`: the grouping
  by node type and suffix, a flavor's positions (and an older cluster's),
  drift on a zone-spread file.
- `apps/day1-service/tests/api/test_logical_nodepools_api.py`: a flavor's
  node type, a create written as three NodePools (one at 0), in sync with
  its flavor, two zones' drift by NodePool, a sync; the locked replicas and
  a nodepool with no replica refused.
- `apps/web/lib/zone-form.test.ts`: the form's pick, each zone's replicas,
  the request (a one-zone node type as its InfraEnv, a ratio or a lock in
  every zone, the typed fallback), the names and a clash, the review's
  problems, placement's needs, and the file's grouping.
- The mocked Playwright `logical-nodepools.spec.ts`: the create form's node
  type, zones, names, request and needs; a preset node type with locked
  replicas; an older InfraEnv spread; the typed fallback; the Node pools card
  and Edit cluster's panel.
