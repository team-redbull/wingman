# ADR-0073: An add-on whose chart installs an OLM operator is edited as OperatorHub does: its update channel, version and approval, set per OCP version, checked against the mirrored catalog when one is configured

Date: 2026-11-27
Status: Accepted

## Context

The user, 2026-11-27: "I want to handle the operator version as Red Hat
[does] with the release Channel at the OperatorHub", and "we should be able
to edit an operator and add an OCP-version pin."

In Wingman operators are add-ons (one view per thing): a chart in a team's
`sigs/<team>` repo, `operators/<chart>/{<chart>.yaml, values.yaml}`, with
OCP-version pins `operators/<chart>/ocp-versions/<X.Y.Z>/` (ADR-0043's
2026-11-25 amendment). An add-on's "version" was only its chart's
`targetRevision`, a frozen branch of the chart repo. Nothing in Wingman knew
that a chart installs an operator.

How the platform installs an operator (the public `team-redbull/redbull-platform`,
`gitops/charts/operator-olm` and `gitops/OLM.md`): a consumer chart vendors the
`operator-olm` subchart, which renders an OperatorGroup (sync wave 0) and a
Subscription (wave 1) from the consumer's values under its key:

```yaml
operator-olm:
  subscription:
    name: kubevirt-hyperconverged     # the OLM package
    namespace: openshift-cnv
    channel: stable
    startingCSV: ""                   # empty: the channel head
  operatorGroup:
    targetNamespaces: [openshift-cnv] # empty: AllNamespaces
```

The subchart's own defaults are `channel: stable`, `source: generic-cs`,
`sourceNamespace: openshift-marketplace` (one CatalogSource per OpenShift
version, the mirrored index), `installPlanApproval: Automatic` and
`startingCSV: ""`. Its README says what OperatorHub's install page says, and
two things it does not:

- `startingCSV` "pins the FIRST install only; Automatic approval still
  upgrades within the channel" (Red Hat's behaviour too).
- "Manual STALLS UNDER GITOPS": the Subscription sits at
  `InstallPlanPending`, Argo CD's Subscription health check reports
  Progressing, and no later sync wave runs, so the chart's config CRs are
  never applied. Nothing on the platform approves an InstallPlan, by design.

What an OperatorHub user picks on the install page, in order: **Update
channel**, **Version**, **Installation mode** (All namespaces / A specific
namespace), **Installed Namespace** and **Update approval** (Automatic /
Manual), shown with the package and its catalog source. The channels and
versions come from the cluster's PackageManifest, which is live cluster state
Wingman does not read (day2 has no Kubernetes client; GitLab is its only
store, ADR-0002). What the platform mirrors is in Git: oc-mirror's
`ImageSetConfiguration` (`kind: ImageSetConfiguration`, `mirror.operators[]`
with a `catalog` and `packages[].{name, channels[].{name, minVersion?,
maxVersion?}}`), one file per OCP minor; a file-based catalog (FBC: the
`opm render` stream of `olm.package`, `olm.channel` and `olm.bundle` objects,
or oc-mirror v2's filtered catalog) has every channel's entries and versions.
Each OCP minor's catalog differs: a channel such as `stable-v1.14` may exist
for 4.16 and be gone for 4.20.

## Decision

### An add-on is an operator when its chart says so

An add-on is an **OLM operator** when its chart's own `values.yaml` at the
add-on's revision (`chart_values`, ADR-0024) holds a Subscription block: a
mapping `subscription` holding `name` and at least one of `channel`,
`namespace`, `source`, `sourceNamespace`, `startingCSV` or
`installPlanApproval`, at the top level (a chart that templates its own
Subscription) or under one top-level key (a subchart: `operator-olm`, or an
alias). Wingman records that **key path** (`operator-olm.subscription`) and
writes the operator settings there, in the add-on's own values files. A chart
with no such block is a plain chart and nothing changes for it. A chart with
two (two aliases of `operator-olm` in one chart) is an operator Wingman shows
but does not edit: its values are edited by hand, and the reason says so.
Detection is the server's, at every read and every write; the web never
decides it.

The settings read for a level are the chart's values, then the Sig values
(`operators/<chart>/values.yaml`), then the pin's values
(`ocp-versions/<v>/values.yaml`), merged as Helm merges them. Under the key
`operator-olm`, a setting no file sets is the platform subchart's default
(`stable`, `generic-cs` in `openshift-marketplace`, `Automatic`, `""`), and is
marked as such; under any other key it is "the chart's default", not known.
Higher layers (site, fleet default, MCE, cluster values) may set the same
keys; Wingman shows the add-on's levels and leaves those to the values
preview (ADR-0021).

### OperatorHub's fields, in OperatorHub's order

On the add-on, for an operator: **Update channel**; **Version**
(`startingCSV`; "Latest in the channel" is `""`), with the one line Red Hat
gives: the version of the first install only, after which Automatic approval
follows the channel; **Update approval**, Automatic, with Manual shown
disabled and its reason (it stalls the GitOps sync: the platform has no
InstallPlan approver). Read-only beside them: **Package**
(`subscription.name`), **Install namespace** (`subscription.namespace`),
**Installation mode** (All namespaces when `operatorGroup.targetNamespaces`
is empty or the namespace is `openshift-operators`; "A specific namespace"
when it names the install namespace alone; the namespaces otherwise; the
namespace's own OperatorGroup when `operatorGroup.enabled` is false) and
**Catalog source** (`source` in `sourceNamespace`). Those are the chart's
business: the OLM package and namespace a chart installs are not a setting a
person flips from a portal.

Wingman writes three keys and nothing else: `channel`, `startingCSV`,
`installPlanApproval`. Each, per level: absent leaves it, `null` removes it
from that level (it inherits), a value sets it. A channel is
`[A-Za-z0-9][A-Za-z0-9._-]*` (refused otherwise, `olm-channel-invalid`); a
version is a CSV name, a DNS subdomain ending `.v<semver>`
(`cert-manager-operator.v1.14.1`; refused otherwise, `olm-starting-csv-invalid`;
the package name and the CSV's prefix may differ, as CNV's do). Manual
approval is refused on write (`olm-manual-approval`): Wingman never writes a
setting that stalls the sync. One that is there already is shown as Manual,
linted (warning `olm-manual-approval`) and kept until someone sets Automatic.

### Per OCP version: a pin may set its own channel

The Sig values set the channel for every cluster; an OCP-version pin may set
its own channel and version in its `values.yaml`, because each OCP minor's
catalog differs. A pin that sets values and no revision (**a values-only
pin**) is now accepted for every add-on (a revision, values or operator
settings, else `pin-empty`); `pin-revision-missing` is gone.

Why it existed: ADR-0043's amendment wrote pins in the platform's documented
shape (a pin is a `targetRevision`), and tolerated a hand-written values-only
layer. The folder is what the rest of Wingman keys on: `ocp-version-pin-missing`
and `GET /clusters/{id}/upgrade-check` treat **any** `ocp-versions/<v>/`
folder as "this add-on is pinned per OCP version", so every new version,
z-streams included, needs its folder before day1 flips a `mastertag`, or the
cluster silently falls back to the Sig values. That stays true and stays
said for a values-only pin: an operator whose channel differs per minor needs
exactly that warning. Nothing else depended on a revision: the platform's
stacks read both files of the folder as optional (`ignoreMissingValueFiles`),
and the oracle renders a values-only pin like any other. A pin's revision can
also be dropped now (`target_revision: ""`), which leaves it values-only, and
its version changed, which moves its folder.

### The catalog: an optional setting, off by default

`DAY2_OPERATOR_CATALOG_PROJECT` (a GitLab project id or path; empty: off),
`DAY2_OPERATOR_CATALOG_REF` (default `main`) and
`DAY2_OPERATOR_CATALOG_PATHS` (default `mirror/imageset-config-{minor}.yaml`;
one or more comma-separated path templates, each with `{minor}`, `4.16`).
Read through `GitLabPort` and a day2 port, `OperatorCatalogFiles`, cached
like the chart repos (kept for the TTL, answered stale while refreshed,
ADR-0041): no new external system. Each file a template names for a minor is
read and recognised by its content:

- an **ImageSetConfiguration** (oc-mirror v1 `v1alpha2` or v2 `v2alpha1`):
  `mirror.operators[].packages[]`, each package's `defaultChannel` when given
  and its `channels[]` with `minVersion`/`maxVersion` (a package's own
  `minVersion`/`maxVersion` apply to every channel); a package with no
  channels mirrors its default channel only;
- a **file-based catalog**, a JSON stream (as `opm render` writes it) or a
  YAML stream: `olm.package` (`defaultChannel`), `olm.channel` (`entries[]`
  with `replaces`/`skips`) and `olm.bundle` (the `olm.package` property's
  `version`). A channel's head is the entry no other entry replaces or skips.

Several files for one minor are merged: an ImageSetConfiguration says which
channels and range are mirrored, an FBC gives the versions, filtered to that
range. With the setting on, the editor offers OperatorHub's dropdowns for a
package the minor's catalog has: the channels, the default one marked, and
the versions newest first, "Latest in the channel" first. The Sig level
offers the channels of every minor its destinations run (each marked where
it is missing), a pin those of its own minor. Without the setting, or for a
package the catalog lacks, the fields are free text, checked as above, and
the editor says why there is no list.

Lints, on the add-on's read (`GET /addons/{team}/{addon}/operator`) and on
every write's plan, all warnings unless said: `olm-channel-not-in-catalog`
(the channel a destination's version gets is not in its minor's catalog: the
Subscription would sit at ResolutionFailed; the finding names the versions to
pin), `olm-version-not-in-channel` (a `startingCSV` not among the channel's
versions, or outside its mirrored `minVersion`/`maxVersion`),
`olm-package-not-in-catalog` (the minor's catalog files exist and none has
the package), `olm-catalog-missing` (info: the setting is on and no file
exists for a minor the add-on runs on) and `olm-manual-approval`. None of
them refuses a write: the catalog in Git may lag the registry.

### Editing: one editor, one merge request

`PUT /api/day2/addons/{team}/{addon}` carries, beside the deploy config, sync
options and Sig values it already took: `operator` (the Sig level's three
settings) and the pins, `ocp_versions` (each `{version, from_version?,
target_revision?, values?, operator?}`: no `from_version` adds a pin, the
same one changes it, another moves its folder) and `remove_ocp_versions`, all
in **one MR** with the rest, as a create carries its pins. The single-pin
routes stay and take `operator` too. The MR is titled
`[Wingman/Day2] Update addon <team>/<chart> Sig values[ and OCP-version pins <v>[ (new| (moved from <v>)| (removed)], ...]`,
or `... OCP-version pins ...` alone; label and footer action stay
`update-default` (ADR-0007: parsed as every `Update addon`). The guards are
ADR-0043's: admins, a writable team, the read's `last_commit_id` on every file
it changes, moves or deletes (ADR-0006, never retried), the platform's lints
on the tree it produces, and confirmation against the preview's digest
(ADR-0053).

### Values files: only the keys that change

ADR-0043 replaces a values file whole when a person edits its values, and
that stays: the Sig values and a pin's values edited as YAML are written
whole, as before. Operator settings are three keys in a file a person wrote,
often with comments explaining them (the platform's consumer charts are
mostly comments): when only they change, Wingman edits the file in place
with `domain.yaml_text.edit_mapping_text`, ADR-0043's deploy-config editor,
now also used for values (rule `values-layout`). Only the changed keys'
lines change; a new key goes after the last key of its mapping, an emptied
mapping on the path is removed; the result must read back as exactly the
intended document and keep every comment line, else the edit is refused
with the reason and the person edits the YAML instead. When the same request
also replaces the values whole, the settings are set in that document and
it is written whole.

### Create

`POST /addons/{team}` takes `operator` (written into `values.yaml` at the key
path the chart's values at the chosen revision give) and each pin's
`operator`; a pin's `target_revision` may be left out. The New add-on form
reads `GET /api/day2/teams/{team}/addon-chart?repourl=&revision=&path=`: the
chart repo's branches (for the add-on's and its pins' revision fields) and
the operator, if it is one, with the catalog for the OCP minors the team's
destinations run.

## Alternatives rejected

- **A separate Operators page or "operator" flag on the add-on.** Operators
  are add-ons; the add-on page and its editor gain the fields
  (one view per thing).
- **Reading the PackageManifest from the clusters.** Day2 has no cluster
  client and would need one per MCE and hosted cluster; the mirrored catalog
  is in Git already, and Git is what the GitOps repos follow.
- **Offering Manual approval.** It stalls every sync wave after the
  Subscription; an approver Job defeats the point of Manual (the platform's
  own rule). Shown, explained, never written.
- **A pin per OCP minor (`ocp-versions/4.16/`).** The platform keys the
  folder by the full version; a minor folder is never read. The lint names
  the full versions to pin instead.
- **A YAML round trip for operator settings.** It drops the comments that
  explain a consumer chart's values.
- **Refusing a write the catalog does not confirm.** The catalog in Git may
  be behind or ahead of the registry; a warning says what OLM will do.

## Consequences

- An add-on owner picks a channel and version from a list for each OCP minor
  their clusters run, when the air-gap keeps its ImageSetConfigurations (and,
  for versions, a filtered FBC) in a GitLab project Wingman can read. Off,
  everything works with free text.
- A values-only pin is a pin: the chart is "pinned per OCP version", and the
  upgrade check and `ocp-version-pin-missing` ask for a folder for every new
  version. For an operator that is the right question (the new minor's
  channel); for a chart that tracks `HEAD` with values per version, too.
- Left for later: an operator's settings in higher layers (a fleet default
  or a cluster's values setting the channel) are only in the values preview;
  the live CSV and Subscription state (Wingman reads no cluster); OLM v1
  `ClusterExtension`; editing `spec.config` of a Subscription.

## Verification

- `tests/unit/domain/test_olm.py`: detection (top level, subchart, alias,
  two subscriptions, none), the levels merged, the subchart's defaults, the
  installation modes, the field checks.
- `tests/unit/domain/test_olm_catalog.py`: an ImageSetConfiguration (v1 and
  v2), an FBC JSON stream and YAML stream, channel heads, versions newest
  first, the merge filtered to the mirrored range.
- `tests/unit/domain/test_values_text.py`: the in-place setter keeps every
  other line byte for byte (a property test over generated values files) and
  refuses what it cannot write exactly.
- `tests/unit/application/test_olm.py` and `tests/api/test_olm_api.py`: the
  read with and without the catalog, the lints, the edit and the pins in one
  MR, a moved pin, a values-only pin, Manual refused, a plain chart refused,
  stale reads refused.
- `apps/web/components/addons/addon-editor/model.test.ts` and
  `e2e/tests/addon-operator.spec.ts`: the fields, the dropdowns, a pin's own
  channel, one merge request (mocked).
