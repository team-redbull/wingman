# Add-on authoring and per-team write access: the day2 API the web reads (2026-11-12)

What day2 adds so a team can, from Wingman, add a new add-on to its repo,
edit an add-on's team default (its deploy config, sync options included,
and its values), make an add-on a default across a fleet (every hosted
cluster, every MCE, the hub, every UPI cluster), and edit a fleet default.
Each change is one merge request on the team's repo (`sigs/<team>`), as
every day2 change is (ADR-0022). Writes are per-team opt-in: a team that has
not given Wingman's GitLab account write access to its project is read-only
in Wingman. Decisions and reasons: ADR-0043. Everything here is under
`/api/day2`; request bodies refuse unknown fields (422).

**Changed in 3.12 (ADR-0053):** every write here also answers `impact`,
`excluded` and `digest`, and what it deletes or changes on any destination
is confirmed in `confirm_changes` together with the preview's digest as
`expected_digest` (409 `plan-changed` when the repo moved since the
preview). See `docs/notes/2026-11-12-operators-page-api.md` §2 and §4.

## 1. Per-team write access

Wingman uses one GitLab account (the chart's `gitlab.accessToken`). A team
opts in by making that account a **Developer (or higher) member of its own
project** `sigs/<team>`; then Wingman can push a branch and open an MR there.
Wingman reads the account's access per team project (GitLab
`GET /projects/:id` → `permissions`, the higher of `project_access` and
`group_access`), keeps it for the read cache's TTL, and:

- **writable** (access ≥ 30, Developer): every day2 write works as before;
- **read-only** (anything less, or no membership): every day2 write for that
  team is refused with `403 TEAM_READ_ONLY` (create add-on, edit a default,
  make default, install, update, remove, bulk install, and approve, reject and
  edit of its MRs). Reads work wherever Wingman can read the project.

Membership in the sigs group (or a group above it) is inherited by every team
project, so it turns writes on for every team at once. Per-team opt-in needs
the account to be a member of each opting-in project, not of the group.

### `GET /teams`, `GET /teams/{team}`

Each team gains four fields:

```json
{
  "name": "orca",
  "project_id": 3,
  "path_with_namespace": "sigs/orca",
  "web_url": "https://gitlab.example/sigs/orca",
  "writable": false,
  "access_level": 20,
  "access_role": "reporter",
  "read_only_reason": "orca hasn't given Wingman write access to sigs/orca: Wingman's GitLab account is a Reporter there, and opening a merge request needs Developer or higher. A maintainer of sigs/orca turns writes on by adding the account to the project as a Developer."
}
```

- `access_level`: GitLab's number (0 none, 5 minimal, 10 guest, 15 planner,
  20 reporter, 30 developer, 40 maintainer, 50 owner).
- `access_role`: its name (`none`, `minimal`, `guest`, `planner`, `reporter`,
  `developer`, `maintainer`, `owner`).
- `read_only_reason`: `null` when `writable`; otherwise one sentence to show
  as is (it names the team and the project).

`GET /teams/{team}` is one of these (404 for an unknown team).

### `403 TEAM_READ_ONLY`

```json
{
  "type": "/problems/team-read-only",
  "title": "Team Read Only",
  "status": 403,
  "code": "TEAM_READ_ONLY",
  "detail": "<the same sentence as read_only_reason>",
  "details": {"team": "orca", "project": "sigs/orca", "access_level": 20, "access_role": "reporter", "required_level": 30}
}
```

It comes before any other check of the request, so a read-only team's write
never gets as far as a validation error.

## 2. Sync options

The leaf Application's ArgoCD `syncPolicy`, as four settings. Every request
and response below uses this shape:

```json
{"auto_sync": false, "prune": false, "self_heal": false, "sync_options": ["CreateNamespace=true"]}
```

- `auto_sync`: `syncPolicy.automated` is present (ArgoCD syncs by itself
  after the merge). Off means manual sync: nothing deploys until someone
  syncs the app in ArgoCD (Wingman has no ArgoCD access).
- `prune`, `self_heal`: `automated.prune` and `automated.selfHeal`. They
  exist only with auto-sync: a request with either `true` and `auto_sync`
  `false` is `422` (`details.rule`: `sync-without-auto`).
- `sync_options`: `syncPolicy.syncOptions`, in order, each `Name=value`
  (`^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9._-]+$`, else `422`, rule
  `sync-option-invalid`; duplicates are `422` too). The template offers a
  list of common ones (§3); any option of that shape is accepted.

Other `syncPolicy` keys a file already has (`retry`,
`managedNamespaceMetadata`, `automated.allowEmpty`) are kept as they are and
not shown.

## 3. A new add-on

### `GET /teams/{team}/addon-template`

What the New add-on form starts from, read from the team's own files:

```json
{
  "team": "redbull",
  "writable": true,
  "read_only_reason": null,
  "sync": {"auto_sync": false, "prune": false, "self_heal": false, "sync_options": ["CreateNamespace=true"]},
  "sync_source": "the sync options most of sigs/redbull's add-ons use (3 of 3)",
  "repourl_prefix": "https://gitlab.example/redbull/helm-charts/",
  "known_sync_options": ["CreateNamespace=true", "ServerSideApply=true", "PruneLast=true", "ApplyOutOfSyncOnly=true", "RespectIgnoreDifferences=true", "Replace=true", "Validate=false", "SkipDryRunOnMissingResource=true", "FailOnSharedResource=true", "PrunePropagationPolicy=foreground", "PrunePropagationPolicy=background", "PrunePropagationPolicy=orphan"],
  "scopes": [
    {"scope": "hosted-clusters", "label": "every hosted cluster", "destinations": ["hosted:site1:prod:ocp4-prod-mce-site1-a:ocp4-prod-herzi-site1", "..."]},
    {"scope": "mces", "label": "every MCE", "destinations": ["mce:site1:prod:ocp4-prod-mce-site1-a", "..."]},
    {"scope": "hub", "label": "the hub", "destinations": ["hub"]},
    {"scope": "upi", "label": "every UPI cluster", "destinations": ["upi:site1:prod:ocp4-dok-site1"]}
  ]
}
```

- `sync`: the sync options most of the team's add-ons
  (`operators/*/<chart>.yaml`) use; with no add-on yet, the platform's
  default: manual sync with `CreateNamespace=true`. `sync_source` says
  which, for a hint under the control.
- `repourl_prefix`: where a new add-on's chart repo is suggested, the team's
  own group: always `<GITLAB_URL>/<team>/helm-charts/`, from the GitLab URL
  day2 is configured with (a sub-path kept), whatever the team's existing
  add-ons use (ADR-0060; before 3.35.0, the folder most of them used, or
  `null`). The form pre-fills `<prefix><name>.git` until the address is
  edited. Only a suggestion: any `repourl` is accepted as before.
- `scopes`: the four fleet scopes, each with the destinations a default there
  reaches today: the folders this team's repo has for that kind, minus none
  (exclusions name charts, and a new default has none). A fleet default
  reaches only clusters the team's repo has a folder for.

### `POST /addons/{team}` (admin)

```json
{
  "name": "podinfo",
  "repourl": "https://gitlab.example/redbull/helm-charts/podinfo.git",
  "target_revision": null,
  "path": null,
  "project_namespace": "podinfo",
  "sync": {"auto_sync": false, "prune": false, "self_heal": false, "sync_options": ["CreateNamespace=true"]},
  "ignore_differences": null,
  "values": {},
  "default_scope": null,
  "default_values": {},
  "ocp_versions": [],
  "confirm_changes": [],
  "message": null
}
```

- `name` (required): the chart folder, a DNS label (lowercase letters,
  digits, `-`; 422 `chart-name`). It becomes part of Application names.
- `repourl` (required): `http(s)://...`; written under the lowercase key
  `repourl`, the only spelling the platform reads. A URL on this GitLab must
  name a project Wingman can read (422 `chart-repo-missing`); one elsewhere is
  accepted with a warning (versions and chart defaults will not be shown).
- `target_revision`: a branch of the chart repo; `null` or absent means
  `HEAD` (the repo's default branch) and writes no key. A branch the repo does
  not have is 422 `revision-unknown`.
- `path`: the chart's folder in its repo; `null`/absent/`"."` writes no key.
- `project_namespace`: the destination namespace (a DNS label, else 422
  `namespace-invalid`); `null` writes no key.
- `sync` (required): §2.
- `ignore_differences`: ArgoCD's list of objects, written as given (anything
  else is 422 `ignore-differences-invalid`); `null` writes no key.
- `values`: `operators/<name>/values.yaml` (`{}` when empty).
- `default_scope`: also make it a fleet default in the same MR (`hub`,
  `mces`, `hosted-clusters`, `upi`); `default_values` is then
  `defaults/<scope>/<name>/values.yaml`. As §5, including clusters that
  already have a folder of that name, which `confirm_changes` confirms as
  there.
- `ocp_versions` (since 3.65.0): zero or more OCP-version pins,
  `[{"version": "4.20.9", "target_revision": "2.1.5-hotfix", "values": {}}]`,
  each checked as §8's `POST` (a full version, a branch of the chart repo)
  and a version given twice refused (422 `pin-duplicate`). Each is written in
  the same MR, as `operators/<name>/ocp-versions/<version>/<name>.yaml` and,
  when it has values, `values.yaml`.

Writes `operators/<name>/<name>.yaml` and `operators/<name>/values.yaml`
(plus §5's files with `default_scope`, and each pin's). `409 ALREADY_EXISTS` (rule
`addon-exists`) when `operators/<name>/` exists. Title:
`[Wingman/Day2] Create addon <team>/<name> in the team catalog` (with a
scope: `... and as a fleet default on every hosted cluster`). Labels
`wingman`, `day2`, `create-addon`.

## 4. An add-on's team default

### `GET /addons`, `GET /addons/{team}/{addon}`

Each catalog entry gains:

```json
{
  "writable": true,
  "read_only_reason": null,
  "sync": {"auto_sync": false, "prune": false, "self_heal": false, "sync_options": ["CreateNamespace=true"]},
  "ignore_differences": null,
  "deploy_config_exists": true,
  "last_commit_id": "9f1c…"
}
```

`sync` is what `operators/<chart>/<chart>.yaml` sets (an OCP-version pin, a
fleet default or a cluster folder may override it per destination; the
values preview's `deploy` shows the effective leaf). `last_commit_id` is the
commit the entry was read at: send it back on edit.

### `PUT /addons/{team}/{addon}` (admin)

Every field is optional; an absent field is left as it is.

```json
{
  "repourl": "https://gitlab.example/redbull/helm-charts/kyverno.git",
  "target_revision": "3.3.0",
  "path": null,
  "project_namespace": "kyverno",
  "sync": {"auto_sync": true, "prune": false, "self_heal": true, "sync_options": ["CreateNamespace=true", "ServerSideApply=true"]},
  "ignore_differences": null,
  "values": {"replicas": 2},
  "last_commit_id": "9f1c…",
  "message": null
}
```

- `null` for `target_revision`, `path`, `project_namespace` or
  `ignore_differences` removes that key (`HEAD`, `.`, no namespace).
  `repourl` cannot be removed (422 `repourl-missing`). `sync` and `values`
  absent or `null` are unchanged.
- A miscased `repoUrl` the file has is replaced by `repourl` when the request
  sets `repourl`.
- The deploy config is **edited in place**: only the keys that change are
  rewritten, and every other line, comments included, stays as it is. A file
  whose layout the editor cannot edit exactly (a comment inside a value it
  must rewrite, flow style across lines, anchors) is 422
  `deploy-config-layout`, with the reason; edit that file by hand.
- `values` replaces `operators/<addon>/values.yaml` (rewritten, as a
  cluster's values file is today).
- `last_commit_id`: the entry's; a file changed since is `409 REVISION_CONFLICT`.
- Nothing to change is 422 `no-change`.

The notes say which destinations the change reaches (every destination that
gets the add-on and does not override the changed keys). Title:
`[Wingman/Day2] Update addon <team>/<addon> Sig values` (before 3.19.1:
`... team default`; both still parse, ADR-0043's amendment). Label
`update-default`.

## 5. Making an add-on a fleet default

A chart folder in `defaults/<scope>/` is deployed to every destination of that
kind the team's repo registers (ADR-0020). The app it generates on a cluster
has the **same name** as the one a cluster folder generates
(`<team>-<cluster>-<chart>` and its leaf `<team>-<cluster>-<chart>-deploy`),
and the same value files. So a cluster that already has the chart in its own
folder must lose that folder in the same commit (a chart in both is the same
app twice: the XOR rule), and when it does, ArgoCD keeps the same
Applications: nothing is deleted, re-created or orphaned. Wingman moves those
folders into the default in the same MR:

- `<cluster folder>/<chart>/values.yaml` (when not empty) becomes
  `defaults/<scope>/<chart>/values-<cluster>.yaml`, copied byte for byte;
  the cluster's own `<chart>.yaml` is deleted;
- a `.gitkeep` keeps the cluster registered if that was its last folder;
- a chart folder holding any other file is 422 `adoption-blocked` (move it by
  hand).

The values file moves below the MCE-wide and cluster-wide value files in the
stack, and the cluster's own deploy config goes, so Wingman compares each such
cluster's effective deploy config and values before and after. A cluster
where nothing changes moves without asking. A cluster where something
changes (an emergency pin, a namespace, sync options, a value) is listed with
each changed key, and the request must confirm exactly those clusters in
`confirm_changes`, else 422 `confirm-changes` (its `details.adopted` lists
them, as in a dry run).

### `GET /fleet-defaults[?team=]`

Every `defaults/<scope>/<chart>/` folder, with or without a catalog entry:

```json
{
  "team": "redbull",
  "chart": "example-chart",
  "scope": "mces",
  "scope_label": "every MCE",
  "path": "defaults/mces/example-chart",
  "in_catalog": false,
  "values": {},
  "values_exists": true,
  "sync": {"auto_sync": false, "prune": false, "self_heal": false, "sync_options": ["CreateNamespace=true"]},
  "sync_overridden": true,
  "reach": ["mce:site1:prep:ocp4-prep-mce-site1-a", "mce:site1:prod:ocp4-prod-mce-site1-a"],
  "excluded": [],
  "tweaks": ["defaults/mces/example-chart/values-ocp4-prep-mce-site1-a.yaml"],
  "last_commit_id": "9f1c…",
  "writable": true,
  "read_only_reason": null,
  "warnings": []
}
```

- `sync`: the effective settings, the team default with the fleet layer
  (`defaults/<scope>/<chart>/<chart>.yaml`) on top; `sync_overridden`: the
  fleet layer sets `syncPolicy`.
- `reach`: the destinations it deploys to; `excluded`: those
  `exclusions.yaml` keeps it off; `tweaks`: the per-env and per-cluster
  value files (edited per cluster, through the cluster's add-on page).

### `POST /addons/{team}/{addon}/defaults/{scope}` (admin)

```json
{
  "values": {},
  "sync": null,
  "confirm_changes": [],
  "message": null
}
```

- `{scope}`: `hub`, `mces`, `hosted-clusters` or `upi`. The add-on must be in
  the catalog (`operators/<addon>/`, else 404); `defaults/<scope>/<addon>/`
  must not exist (409 `default-exists`).
- `values`: `defaults/<scope>/<addon>/values.yaml` (always written, `{}` when
  empty: the file is what makes the folder exist).
- `sync`: `null` inherits the team default's; otherwise the fleet layer gets
  the `syncPolicy` keys that make the effective settings these, and only when
  they differ.
- `confirm_changes`: cluster ids, from a dry run's `needs_confirmation`.

Title: `[Wingman/Day2] Promote addon <team>/<addon> to a fleet default on every hosted cluster`
(`every MCE`, `the hub`, `every UPI cluster`). Label `make-default`.

### `PUT /addons/{team}/{addon}/defaults/{scope}` (admin)

```json
{"values": {"fleet": true}, "sync": {"auto_sync": true, "prune": false, "self_heal": true, "sync_options": []}, "last_commit_id": "9f1c…", "message": null}
```

The default must exist (404 otherwise). Absent fields are unchanged; `sync:
null` removes the fleet layer's `syncPolicy` (back to the team default's).
`values` replaces `defaults/<scope>/<addon>/values.yaml`; the per-cluster
`values-<x>.yaml` files are not touched. The fleet `<addon>.yaml` is edited in
place as in §4. Title: `[Wingman/Day2] Update addon <team>/<addon> fleet default on every MCE`.
Label `update-default`. Works for a fleet default without a catalog entry too
(`in_catalog: false`).

Stopping being a default is not here yet (ADR-0043, left for later): it
deletes the default's Applications and, with `prune: false`, orphans the
workloads on every destination. Until then: exclusions per cluster
(runbook R10) or by hand.

## 6. Dry runs and results

Every write above takes `?dry_run=true`: it runs every check, opens nothing,
and answers `200` with the plan. The web shows the plan (and its diffs)
before the real request; Make default needs it to fill `confirm_changes`.

```json
{
  "team": "redbull",
  "action": "make-default",
  "chart": "cluster-roles",
  "scope": "hosted-clusters",
  "title": "[Wingman/Day2] Promote addon redbull/cluster-roles to a fleet default on every hosted cluster",
  "files": [
    {"action": "create", "path": "defaults/hosted-clusters/cluster-roles/values.yaml", "content": "{}\n", "previous": null},
    {"action": "delete", "path": "sites/site1/prod/mces/ocp4-prod-mce-site1-a/ocp4-prod-herzi-site1/cluster-roles/cluster-roles.yaml", "content": null, "previous": ""}
  ],
  "reach": ["hosted:site1:prep:ocp4-prep-mce-site1-a:ocp4-prep-eyal-site1", "..."],
  "adopted": [
    {
      "cluster": "hosted:site1:prod:ocp4-prod-mce-site1-a:ocp4-prod-herzi-site1",
      "name": "ocp4-prod-herzi-site1",
      "moved": [],
      "deleted": ["sites/site1/prod/mces/ocp4-prod-mce-site1-a/ocp4-prod-herzi-site1/cluster-roles/cluster-roles.yaml", "sites/.../cluster-roles/values.yaml"],
      "gitkeep": "sites/site1/prod/mces/ocp4-prod-mce-site1-a/ocp4-prod-herzi-site1/.gitkeep",
      "changes": []
    }
  ],
  "needs_confirmation": [],
  "warnings": [],
  "notes": ["..."]
}
```

- `files[].action`: `create`, `update` or `delete`; `content` is the new
  text (`null` for a delete), `previous` the current one (`null` for a create).
- `adopted[]` (make default, and create with `default_scope`): each cluster
  whose own folder moves into the default. `moved`: `[{from, to}]`;
  `changes`: `[{stack: "deploy" | "values", key: "syncPolicy.automated.prune", before, after}]`
  (dotted leaf paths; `before`/`after` `null` when absent). Empty `changes`
  means the move changes nothing on that cluster.
- `needs_confirmation`: the ids of `adopted` with `changes`.

The real request answers `201` (`POST`) or `200` (`PUT`) with the opened MR
(the `MRDetail` fields, as an install's answer has them) plus `action`,
`chart`, `scope`, `files [{action, path}]`, `reach`, `adopted`, `warnings`
and `notes`.

## 7. Errors

| Status, code | `details.rule` | When |
|---|---|---|
| 403 `TEAM_READ_ONLY` | | the team has not given Wingman write access (§1) |
| 404 `NOT_FOUND` | `pin-unknown` (§8) | unknown team, add-on, fleet default, or OCP-version pin |
| 409 `ALREADY_EXISTS` | `addon-exists`, `default-exists`, `pin-exists` | the folder exists already |
| 409 `REVISION_CONFLICT` | | a file changed (or was deleted) since `last_commit_id` |
| 422 `VALIDATION_ERROR` | `chart-name`, `repourl-invalid`, `repourl-missing`, `chart-repo-missing`, `revision-unknown`, `namespace-invalid`, `ignore-differences-invalid`, `sync-without-auto`, `sync-option-invalid`, `sync-layering`, `adoption-blocked`, `confirm-changes`, `deploy-config-layout`, `yaml-invalid` (a file the change needs does not parse), `no-change`, `ocp-version-invalid`, `pin-revision-missing`, `pin-values-invalid`, `pin-duplicate`, `pin-empty` (§8), or a lint rule the change would break (ADR-0023) | the request cannot be written as asked |

Warnings a plan may carry (`warnings[].rule`): `chart-repo-elsewhere` (the
chart repo is not on this GitLab), `chart-values-missing` (no `values.yaml` at
the chart's path and revision), `repourl-moved`, and `sync-differs` (an
OCP-version pin or a cluster's own deploy config gives some destinations other
sync options than the default's), and `fleet-pin-overrides-ocp-versions` (a
fleet default's deploy config sets `targetRevision`, which overrides every
pin's revision on its scope; §8).

Body validation (a wrong type, an unknown field) is 422 as everywhere.

## 8. OCP-version pins (3.65.0)

ADR-0043's 2026-11-25 amendment. A pin is
`operators/<addon>/ocp-versions/<version>/` in the team repo: layer 2 of both
of the add-on's stacks on every destination whose OCP version (what comes
before its day1 `mastertag`'s first `-`) is exactly `<version>`. `<version>`
is the full `<major>.<minor>.<patch>`: `4.16.27`, never `4.16` (422
`ocp-version-invalid`). Wingman writes the platform's shape and nothing
else:

```yaml
# operators/<addon>/ocp-versions/<version>/<addon>.yaml
targetRevision: 2.1.5-hotfix
```

and `operators/<addon>/ocp-versions/<version>/values.yaml` only when the pin
has values. Each write is one MR in the authoring conventions (label and
footer action `update-default`, branch `update-default-<addon>-…`), is
previewed with `?dry_run=true`, and confirms its impact (the destinations at
that version) with the preview's digest, as §6. Admins only; a read-only team
is `403 TEAM_READ_ONLY` before anything else.

### `POST /addons/{team}/{addon}/ocp-versions` (admin)

```json
{"version": "4.20.9", "target_revision": "2.1.5-hotfix", "values": {"extra": 1}, "confirm_changes": [], "expected_digest": null, "message": null}
```

`version` and `target_revision` are required; `target_revision` is a branch
of the add-on's chart repo, `HEAD` its default (422 `pin-revision-missing`
when blank, `revision-unknown` when the repo has no such branch; a chart repo
elsewhere is accepted with `chart-repo-elsewhere`). `values` (`{}`: no
`values.yaml`). `409 ALREADY_EXISTS` (`pin-exists`) when the folder exists;
404 when the team has no `operators/<addon>/`. Title:
`[Wingman/Day2] Update addon <team>/<addon> OCP-version pin <version> (new: <revision>)`.

### `PUT /addons/{team}/{addon}/ocp-versions/{version}` (admin)

```json
{"target_revision": "2.0.0", "values": {"extra": 2}, "last_commit_id": "9f1c…", "confirm_changes": [], "expected_digest": null, "message": null}
```

Absent or `null` fields are unchanged. `target_revision` is set in
`<addon>.yaml` in place (its comments and other keys kept, §4), or written as
the file when the pin holds values only; it cannot be blanked (remove the pin
instead). `values` replaces `values.yaml` whole; `{}` deletes it (422
`pin-empty` when that would leave the folder empty). `last_commit_id` is the
pin's, from `GET /teams/{team}/addons/{addon}` (`ocp_versions[].last_commit_id`):
a pin changed since is `409 REVISION_CONFLICT`, one deleted since too; one
that is not there `404` (`pin-unknown`). Title:
`[Wingman/Day2] Update addon <team>/<addon> OCP-version pin <version>`.

### `DELETE /addons/{team}/{addon}/ocp-versions/{version}` (admin)

```json
{"last_commit_id": "9f1c…", "confirm_changes": ["hosted:site1:prep:…:ocp4-prep-eyal-site1"], "expected_digest": "…", "message": null}
```

A JSON body, as every confirmed write has. Deletes every file of the folder,
each guarded by `last_commit_id`: the destinations at that version go back to
the add-on's revision and Sig values. Title:
`[Wingman/Day2] Update addon <team>/<addon> OCP-version pin <version> (removed)`.

Every pin plan says which destinations read it (`reach`, none for a version
no destination runs yet: the pin waits for the first cluster day1 moves
there), warns with `fleet-pin-overrides-ocp-versions` for each fleet default
whose deploy config sets `targetRevision` (its scope ignores every pin's
revision; the values still apply), and notes the versions the add-on runs on
with no pin and the clusters whose own folder pins a revision (an emergency
pin, which the pin's revision does not reach).

## 9. Operators: update channel, version, approval (3.67.0)

ADR-0073. An add-on is an **OLM operator** when its chart's own
`values.yaml` at the add-on's revision holds a Subscription block
(`subscription.name` plus `channel`, `namespace`, `source`, `sourceNamespace`,
`startingCSV` or `installPlanApproval`), at the top level or under one
top-level key (`operator-olm`, or an alias). Wingman writes three keys of that
block in the add-on's own values files: `channel`, `startingCSV` and
`installPlanApproval`.

### `GET /addons/{team}/{addon}/operator`

Any signed-in user (a viewer's destinations are those they may see,
ADR-0068). For a plain chart `is_operator` is `false` and the rest is empty.

```json
{
  "team": "redbull",
  "chart": "cert-manager",
  "is_operator": true,
  "editable": true,
  "reason": null,
  "revision": "HEAD",
  "key_path": "operator-olm.subscription",
  "subchart": "operator-olm",
  "chart_values_problem": null,
  "chart": {"package": "openshift-cert-manager-operator", "namespace": "cert-manager-operator",
            "channel": "stable-v1", "starting_csv": "", "install_plan_approval": null,
            "source": null, "source_namespace": null, "install_mode": "own-namespace",
            "target_namespaces": ["cert-manager-operator"], "defaulted": []},
  "sig": {
    "path": "operators/cert-manager/values.yaml",
    "own": {"channel": "stable-v1.14", "starting_csv": null, "install_plan_approval": null},
    "effective": {"package": "openshift-cert-manager-operator", "namespace": "cert-manager-operator",
                  "channel": "stable-v1.14", "starting_csv": "", "install_plan_approval": "Automatic",
                  "source": "generic-cs", "source_namespace": "openshift-marketplace",
                  "install_mode": "own-namespace", "target_namespaces": ["cert-manager-operator"],
                  "defaulted": ["install_plan_approval", "source", "source_namespace"]}
  },
  "pins": [
    {"version": "4.20.9", "minor": "4.20", "target_revision": null,
     "path": "operators/cert-manager/ocp-versions/4.20.9/values.yaml",
     "own": {"channel": "stable-v1.15", "starting_csv": null, "install_plan_approval": null},
     "effective": {"…": "as sig.effective"}, "destinations": 2}
  ],
  "versions": [
    {"version": "4.16.27", "minor": "4.16", "destinations": 3, "pinned": false},
    {"version": "4.20.9", "minor": "4.20", "destinations": 2, "pinned": true}
  ],
  "catalog": {
    "configured": true,
    "source": "redbull/operator-catalog@main: mirror/imageset-config-{minor}.yaml, catalogs/{minor}/catalog.json",
    "minors": [
      {"minor": "4.20", "files": ["mirror/imageset-config-4.20.yaml", "catalogs/4.20/catalog.json"],
       "problems": [], "package": {
         "name": "openshift-cert-manager-operator", "default_channel": "stable-v1",
         "channels": [
           {"name": "stable-v1", "is_default": true, "head": "cert-manager-operator.v1.15.1",
            "versions": ["cert-manager-operator.v1.15.1", "cert-manager-operator.v1.15.0"],
            "min_version": "1.15.0", "max_version": null}]}}
    ]
  },
  "warnings": [FindingOut]
}
```

- `editable: false` with `reason` for an operator Wingman shows but does not
  edit: two Subscription blocks in one chart, or its chart values unreadable
  (`chart_values_problem`). `is_operator: false` gives the reason too (no
  Subscription in the chart's values, or they could not be read).
- `key_path`: where the block is in a values file; `subchart`: its first key,
  `null` at the top level.
- `chart`, `sig.effective` and each pin's `effective`: the settings at that
  level, merged as Helm merges (chart values, then Sig values, then the
  pin's). `null` is "not in any of these files": under `operator-olm` such a
  field is the platform subchart's default instead, named in `defaulted`.
  `install_mode`: `all-namespaces` (an empty or absent
  `operatorGroup.targetNamespaces`, or the namespace `openshift-operators`),
  `own-namespace` (exactly the install namespace), `namespaces` (any other
  list: `target_namespaces`), `existing-group` (`operatorGroup.enabled:
  false`: the namespace's own OperatorGroup) or `unknown` (a chart that
  templates its own Subscription and has no `operatorGroup` values).
- `own`: what that level's file sets itself (`null`: inherited).
- `versions`: the OCP versions the add-on's destinations run, each with its
  minor, its count and whether a pin exists for it.
- `catalog.configured: false` when `DAY2_OPERATOR_CATALOG_PROJECT` is unset:
  `minors` is then empty and every field is free text. Otherwise one entry
  per minor of `versions` and of the pins: `package` is `null` when the
  minor's files do not have it (or there are none: `files` empty), and
  `problems` says what could not be read. `versions` are CSV names, newest
  first; `head` is the channel's head (OLM's "latest").
- `warnings`: `olm-channel-not-in-catalog`, `olm-version-not-in-channel`,
  `olm-package-not-in-catalog`, `olm-catalog-missing` (info),
  `olm-manual-approval` (ADR-0073).

### `GET /teams/{team}/addon-chart?repourl=&revision=&path=` (admin)

For the New add-on form, before the add-on exists: `revision` defaults to
`HEAD`, `path` to `.`.

```json
{"repourl": "http://gitlab.fake/redbull/helm-charts/cert-manager.git",
 "project": "redbull/helm-charts/cert-manager", "revisions": ["main", "1.15.0", "1.14.0"],
 "problem": null, "operator": {"…": "as GET …/operator, with sig.own all null and no pins"}}
```

`revisions`: the chart repo's branches, default branch first (empty for a
repo elsewhere, with `problem`). `operator.versions`: what the team's
destinations run (the minors whose catalog is offered).

### The settings in a write

```json
"operator": {"channel": "stable-v1.14", "starting_csv": "", "install_plan_approval": "Automatic"}
```

Each field: absent leaves it, `null` removes it from that level's file (it
inherits), a value sets it. `starting_csv: ""` is "Latest in the channel".
`install_plan_approval` takes `Automatic` only (422 `olm-manual-approval`:
Manual stalls the GitOps sync). 422 `olm-channel-invalid`,
`olm-starting-csv-invalid` for a malformed value, `not-an-operator` for a
chart with no Subscription block, `operator-not-editable` for one with two.
When only settings change, the file is edited in place (422 `values-layout`
for a layout Wingman cannot edit exactly: edit the YAML instead); with
`values` in the same request, the settings are set in that document, written
whole.

- `POST /addons/{team}`: `operator` (into `values.yaml`), and each
  `ocp_versions[]` item takes `operator` and may leave `target_revision` out
  (a values-only pin; 422 `pin-empty` with no revision, values or settings).
- `POST /addons/{team}/{addon}/ocp-versions`: the same pin shape.
- `PUT /addons/{team}/{addon}/ocp-versions/{version}`: `operator` too, and
  `target_revision: ""` drops the revision (a values-only pin).
- `PUT /addons/{team}/{addon}` (§4) takes, in the same one MR:

```json
{
  "last_commit_id": "9f1c…",
  "operator": {"channel": "stable-v1.14"},
  "ocp_versions": [
    {"version": "4.20.10", "from_version": "4.20.9", "operator": {"channel": "stable-v1.15"}},
    {"version": "4.21.2", "target_revision": "1.16.0", "values": {}, "operator": {"channel": "stable-v1.16"}},
    {"version": "4.16.27", "from_version": "4.16.27", "target_revision": ""}
  ],
  "remove_ocp_versions": ["4.18.3"],
  "confirm_changes": [], "expected_digest": null, "message": null
}
```

  An item with no `from_version` adds a pin; with its own version, changes it;
  with another, moves the folder (every file deleted at the old version and
  created at the new, then changed). `target_revision` and `values` as in the
  pin routes (absent: unchanged, or none for a new pin). 422 `pin-duplicate`
  for a version given twice, `pin-exists` (409) for a move or add onto a pin
  that stays, 404 `pin-unknown` for a `from_version` or removal that is not
  there. Every file it changes, moves or deletes is guarded by
  `last_commit_id`. Title: `[Wingman/Day2] Update addon <team>/<addon> Sig values and OCP-version pins 4.20.10 (moved from 4.20.9), 4.21.2 (new), 4.16.27, 4.18.3 (removed)`;
  without a Sig change, `... <addon> OCP-version pins ...`.
