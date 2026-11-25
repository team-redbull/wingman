# ADR-0071: A new NodePool is named after its InfraEnv, `<InfraEnv>[-<suffix>]`, and an existing one keeps its name

Date: 2026-11-25
Status: Accepted

## Context

The user (2026-11-25): "Each nodepool should contain the name of the
infraenv it's pulling from. If I am creating 3 nodepools zone-a zone-b
zone-c the nodepool name couldn't be overridden but we can add some [part]
like c200-mtl-zone-a and call it the nodepool; that will let me create more
than 1 nodepool per zone." On the first proposal, `<cluster>-<InfraEnv>[-<suffix>]`:
"but why <cluster>? it's namespace scoped".

What there was:

- **The hostedclusters-setup chart** (`templates/nodepool.yaml`) renders one
  NodePool per `nodepool[]` entry, in the cluster's own namespace
  `hcp-<clusterName>`. Its name is the entry's `name`, else
  `<clusterName>-<infraEnvName>` (the InfraEnv is `infraEnvName`, else
  `agentLabelSelector.nodeLabelValue`). It fails on two entries that render
  one name unless both set `name`.
- **The specs project's template** writes `name:` from the input
  `nodepools[].nodepool_name` only when it is given ("Needed only when two
  nodepools share an InfraEnv"), and the create form offered that input as
  free text. Nearly every file Wingman wrote relies on the derived name, and
  hand-written ones have names of every shape (the fixtures' heron has
  `prod-heron-site1-dell-b` on a `dell-r660-…` InfraEnv).
- **A NodePool's name cannot change in place.** Another name is another
  NodePool: Argo CD deletes the old one, with its Machines, and the new one
  installs new nodes.
- **HyperShift's limits.** The control plane's node controller labels every
  Node with `hypershift.openshift.io/nodePool: <NodePool name>`, and the
  Node Tuning Operator's ConfigMaps carry the same label, so the name is a
  label value: a DNS-1123 label of at most 63 characters. The CAPI objects
  made from it add no tighter limit: the MachineDeployment has the
  NodePool's name, and its MachineSets, Machines and machine templates add a
  hash or a random part to object names of up to 253 characters, which
  HyperShift hashes when longer (`getName` in its nodepool controller).
- **The platform's acceptance tests** (kubevirt-workflows, Acceptance Tests
  §3) name NodePools `<cluster without ocp4->-<InfraEnv>`, the chart's
  derived name: P2's `test-eck-five-a-c200-mtl-az1/2/3`, and M1, M2 and M6
  scale them by that name. That is a known difference, raised with the team.
- **The platform's workflows** read a day1 entry as the chart does: `.name`,
  else `<clusterName>-<infraEnv>` (`activities/upgrade_gitops/day1_values.py`,
  the reader update-nodepool and upgrade-cluster share), so both shapes are
  found.

## Decision

1. **A new NodePool's name is `<InfraEnv>` or `<InfraEnv>-<suffix>`.** The
   InfraEnv part is the nodepool's `infraEnvName`, never typed. A person may
   add only the suffix: lowercase letters, digits and `-`, not starting or
   ending with `-`. The whole name is a DNS-1123 label of at most 63
   characters (the label value above) and the only one in the cluster, so
   two nodepools on one InfraEnv need different suffixes and at most one of
   them none. That is what lets several NodePools draw from one InfraEnv,
   one zone.
2. **No cluster prefix.** Each cluster's NodePools sit in its own namespace,
   `hcp-<clusterName>`, so a name need only be unique within the cluster,
   and the cluster's name would only repeat the namespace.
3. **Wingman writes the name.** Every agent nodepool of a new file has
   `name: <InfraEnv>[-<suffix>]`; the chart never derives one again. The
   create form's schema offers `nodepools[].name_suffix` where the template
   reads `nodepool_name` (`nodepool_names.form_schema`); day1 composes
   `nodepool_name` from `infra_env` and the suffix before the render
   (`nodepool_names.with_names`) and drops the suffix, which the template
   never sees. A request may still send `nodepool_name`, which must follow
   the rule. The rule is one pure module, `wingman_day1.domain.nodepool_names`,
   and the web mirrors what it shows before sending in
   `apps/web/lib/nodepool-names.ts`.
4. **Every path that writes a new NodePool:**
   - **create**, a tenant's from a flavor (`rendered_file.render_new_file`):
     each nodepool row has a **Name suffix** beside its InfraEnv, the whole
     name previewed; a clash, a bad suffix or a name over 63 is refused at
     its field (422) and shown before the request;
   - **a KV cluster's create** (ADR-0069), through the same render: its one
     NodePool is named after its bare-metal pool, `r760-mtl-az1`;
   - **a flavor** (`specs.rule_problems`): a nodepool may preset a
     `name_suffix`; a preset `nodepool_name` is refused, its InfraEnv part
     being the cluster's (a flavor already saved with one lists it as a
     warning), and the create takes the preset suffix like any preset;
   - **Edit cluster** (`cluster_file.edit_problems`): a NodePool the edit
     adds (an entry whose NodePool the file does not have, by either shape)
     must write `name: <infraEnvName>[-<suffix>]`; Edit's **NodePool names**
     panel writes it from a suffix;
   - **import and sync** add no NodePool: import writes the flavor link,
     sync sets locked values on the nodepools the file has.
5. **An existing NodePool keeps its name**, derived or written, whatever its
   shape. Wingman never renames one: nothing it writes changes a name, Edit
   shows each existing name read-only (with a quiet "older name" for one
   that does not follow the rule), and the rule is never applied to it. A
   person's text that removes a NodePool and adds another is the review's to
   see, as ADR-0064 left it; the panel says that merging deletes the one
   removed, and the one added follows the rule.
6. **Both shapes are found by one rule.** `nodepool_names.rendered_name`
   (`name`, else `<clusterName>-<InfraEnv>`) is what drift, the excluded
   Agent labels' merge request, used Agents, Scale and update-nodepool use.
   The edit rules (replicas, versions, scale-down policy, InfraEnvs,
   excluded labels) match an entry across two versions of a file by its
   NodePool (`nodepool_names.entry_key`), no longer by `name` else
   `infraEnvName`: a new NodePool named `c200-mtl-az1` is not the one the
   chart derives from the same InfraEnv. A duplicate is found with the
   chart's `clusterName` where day1 knows it. The cluster page matches the
   MCE's NodePools to the file by name first, then by selector only among
   the pools no entry took by name.
7. **A specs template that does not write the name refuses a create**, as
   for the other inputs that must be written as given: the rendered file
   must hold each `nodepool_name` as `name`, else 422 naming
   `docs/upgrade/3.65-to-3.66.md`. A KubeVirt nodepool without an InfraEnv
   draws from none, and its name is the file's, as before.

## Alternatives rejected

- **`<cluster>-<InfraEnv>[-<suffix>]`**, the first proposal: the user
  rejected the cluster part, the namespace already scopes the name.
- **Leaving one NodePool per InfraEnv to the chart's derived name**: the
  name would carry the cluster when alone and not when beside another, two
  shapes for one rule.
- **Renaming existing NodePools to the rule**, or a migration MR per
  cluster: every node of each would be replaced.
- **A free-text name with the InfraEnv as a hint**: nothing would keep the
  InfraEnv in it.
- **Refusing an edit that replaces a NodePool where another was**: ADR-0064
  leaves replacing a single-InfraEnv nodepool to the person; nothing asked
  to change that.

## Consequences

- Every new cluster file carries `name:` on each agent nodepool, and new
  names differ from the acceptance tests' `<cluster>-<InfraEnv>`. Existing
  clusters are unchanged.
- The specs project's `cluster-template.j2` must render `nodepool_name` as
  the nodepool's `name` (the reference template has since 3.0.0), and
  its comment above `name:`, which an older copy renders into the file as a
  YAML comment ("Needed only when two nodepools share an InfraEnv"), now
  says something false in every new file: the comment changes by merge
  request (`docs/upgrade/3.65-to-3.66.md`). Its behaviour need not change:
  Wingman always passes the name.
- Two or more NodePools on one InfraEnv are made on the create form, in a
  flavor and in Edit cluster, without a person typing a whole name.
- Scale, upgrade-cluster and update-nodepool take a NodePool by name and
  read both shapes, so nothing waits on the workflows.

## Verification

- `apps/day1-service/tests/unit/domain/test_nodepool_names.py`: the rule,
  the suffix, the 63 limit, a clash, a whole name sent, the form schema,
  the rendered-file guard, a flavor's presets, an edit that adds, keeps or
  renames, and both shapes matched.
- `apps/day1-service/tests/api/test_nodepool_names_api.py`: the form offers
  the suffix; a create writes `<InfraEnv>` and `<InfraEnv>-<suffix>`; the
  refusals at their fields; an older template refuses a create; a flavor's
  presets; an edit beside a derived NodePool, and heron's older name kept.
- `apps/day1-service/tests/api/test_fixture_template_contract.py`: the
  reference template's file, through the chart with `WINGMAN_TEST_CHART_DIR`,
  renders NodePools `dell-r660-site1-128c-1024gb-5tb-zone-a` and
  `hp-gen11-site1-64c`; `test_kv_create_api.py`: a KV cluster's NodePool.
- `apps/web/lib/nodepool-names.test.ts` and the mocked Playwright
  `nodepool-names.spec.ts`: the create form's suffix and its preview, a
  clash shown before sending, and Edit cluster with an existing NodePool
  read-only and an added one named from a suffix.
