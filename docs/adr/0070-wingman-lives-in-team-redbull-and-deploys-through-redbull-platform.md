# ADR-0070: Wingman lives in team-redbull and deploys through redbull-platform

Date: 2026-11-24
Status: Accepted

## Context

The user, 2026-11-24: "Create at team-redbull organization wingman project
and let's move to be there + making the CI push its chart to the RedBull
platform, and then we will be in auto sync."

Until then Wingman lived in a personal account's repository, published its
images under that account's registry, and every deployment was a person's
`helm upgrade` (the lab cluster's release revisions, the air-gap's upgrade
guides). Every other team-redbull service lives in the organisation and is
deployed by **redbull-platform**: one ApplicationSet (`gitops/appset.yaml`,
`redbull-services`, project `redbull-platform`) makes an Argo CD Application
of every `gitops/services/<service>/app.yaml`, renders the service's chart from
its copy in `gitops/charts/<service>/` and syncs it automatically
(`automated: {prune: true, selfHeal: true}`). A service's CI writes that copy
on every release with the organisation secret `REDBULL_WRITE_TOKEN`: the
shared `team-redbull/.github` workflow `ghcr-build-push.yml` bumps the image
in it with `yq`; server-scan's own `deploy` job syncs its chart's `templates/`
and `files/` and seds its two tag lines into the hand-kept `values.yaml` there.
CreateNamespace is off: the platform's Helmfile release `namespaces` owns
every target namespace.

Two things in Wingman's chart did not fit:

- **redbull-platform is public, and must hold no secret** (its `CLAUDE.md`,
  `gitops/SECRETS.md`). Wingman's chart rendered its Secret `wingman-secrets`
  from five values (`gitlab.accessToken`, `gitlab.webhookSecret`,
  `auth.oauthClientSecret`, `auth.jwtSecret`, `devAuth.secret`) and the
  cluster-scoped `OAuthClient` with its secret inline.
- **The chart's `values.yaml` is Wingman's documented defaults and its
  schema's twin** (ADR-0059): every key is there with its default, a new key
  lands with its schema entry, and the schema refuses any other. It is shared
  by every deployment (the lab, the air-gap); none of them edits it.

## Decision

1. **The repository is `team-redbull/wingman`** (public), a fresh repository
   with the full history on the user's choice of 2026-11-24: every branch and
   tag was pushed with the same SHAs, `main` at `eda406a8` (`v3.61.0`). The
   old repository, `LiadYahav/wingman`, is left for its owner to archive; nothing builds or
   publishes from it any more. The images are
   `ghcr.io/team-redbull/wingman-{day1,day2,web}` (CI names them after the
   repository's owner, lower case). Releases continue from `v3.61.0`: the tags
   came along, so ADR-0031's sequence and forward-only guard carry on. The new
   repository's first CI run on `main` found `v3.61.0` on its own commit (a
   re-run, ADR-0031) and published 3.61.0 there, so 3.61.0 is the first release
   in the new registry; its three packages are public and linked to the
   repository. Older releases stay where they were published.

2. **The chart can take its secrets from an existing Secret.**
   `secrets.existingSecret: <name>` renders no Secret, and day1 and day2 load
   the named one with `envFrom`. Its keys are the variables themselves:
   `GITLAB_TOKEN`, `JWT_SECRET_KEY`, `OPENSHIFT_OAUTH_CLIENT_SECRET`, and
   optionally `GITLAB_WEBHOOK_SECRET` and `DEV_AUTH_SECRET`. With it, the
   render fails while any of the five secret values is set, naming it (a
   value beside the Secret would be ignored, and must not be committed).
   `auth.oauthClient.create: false` renders no `OAuthClient`; with
   `secrets.existingSecret` it is required wherever the chart would render one
   (`openshiftRoute.enabled` without `devAuth.enabled`), since the secret the
   CR carries inline is then not in the values, and the render says so. Both
   are made once by hand, with the commands at the top of `values.yaml`
   (SECRETS). The defaults (`""`, `true`) render exactly what 3.61 rendered,
   byte for byte. An `ExternalSecret` that writes a Secret of that name and
   keys (the platform's Vault plan) works unchanged.

3. **Every release pushes its chart into redbull-platform.** CI's `platform`
   job runs on `main` after `publish` (the images exist before Argo pulls
   them), with `contents: read` and no other permission:
   - it fails first, with one `::error::`, when `secrets.REDBULL_WRITE_TOKEN`
     is empty (the organisation secret's repository access does not include
     `team-redbull/wingman`), and when redbull-platform has no
     `gitops/services/wingman/app.yaml` or `gitops/overrides/wingman.yaml`;
     nothing needs the job, so the release (tag, images, notes) is whole
     either way, and re-running the job finishes it;
   - `scripts/platform_chart.py write` makes `gitops/charts/wingman/`
     `deploy/helm/wingman/` exactly, deletions included, with six `values.yaml`
     lines changed, each Wingman image's `repository`
     (`ghcr.io/<owner>/wingman-<name>`) and `tag` (the release), edited line by
     line so every comment stays; and `Chart.yaml`'s `version` and
     `appVersion` (the release). `image.registry` stays empty (the job refuses
     a chart where it is not): it prefixes every image, nginx's Red Hat one
     included, which is not in GHCR. A copy that holds a newer release is left
     as it is: re-running an old release's job never deploys it again;
   - it renders the copy the way Argo will (`helm lint --strict`, `helm
     template` with the override file) and refuses a render that does not
     pull the three images from `ghcr.io/<owner>` at the release, or pulls
     anything else from there (an override that sets `image.registry`);
   - it stages `gitops/charts/wingman` alone, commits `chore(wingman): release
     X.Y.Z` (the body names the Wingman tag and commit), and pushes to `main`
     with the shared workflow's loop: on a rejected push, fetch, rebase onto
     `origin/main`, retry, five times. No change is no commit. The token is
     never written to disk or printed: the checkouts do not persist
     credentials, and the push step gives git the header through its
     environment, masked.

4. **The cluster's settings are one hand-kept override file**,
   `gitops/overrides/wingman.yaml`, named by `gitops/services/wingman/app.yaml`
   `valueFiles:`. redbull-platform's `gitops/overrides/README.md` says no
   service overrides anything and a service's configuration is its chart
   copy's `values.yaml`. Wingman differs: its chart is Wingman's own, shared by
   every deployment, its `values.yaml` holds generic defaults that each release
   overwrites, and its schema refuses keys it does not know, so a per-cluster
   edit in the copy would be lost at the next release, and a hand-kept fork of
   `values.yaml` would miss every new key's default. One override file is the
   only place a cluster's values survive a release, and the schema checks it.
   It holds no secret: those are in the Secret (decision 2).

5. **Auto sync.** Every merge to Wingman's `main` is a release (ADR-0031), and
   now also its deployment wherever redbull-platform's ApplicationSet runs:
   Argo sees the new chart and syncs it. Nobody runs `helm upgrade` there.

6. **What an operator does once, per cluster**, before the first sync: create
   the Secret and the `OAuthClient` (decision 2); have the `namespaces`
   release own `wingman` (a namespace that exists already, as on a cluster
   Wingman was installed on by Helm, is adopted first); and keep
   `gitops/overrides/wingman.yaml` (the lab cluster's is the first). Moving a
   cluster's Helm release to Argo keeps its OAuthClient and copies its Secret
   (`docs/upgrade/3.61-to-3.62.md`).

7. **The air-gap is unchanged.** It runs its own Argo over its own mirror of
   redbull-platform (that repository's README), and Wingman there is still
   installed by Helm from a mirrored release, with the upgrade guides. It may
   adopt decision 2 on its own; nothing forces it.

## Alternatives rejected

- **Calling the shared `ghcr-build-push.yml`.** It builds one image under its
  own per-chart `vX.Y.Z` sequence (tags `<chart>/vX.Y.Z` in redbull-platform),
  with actions pinned by tag and no SBOM or signed provenance. Wingman's
  version comes from its own commits (ADR-0031) for three images with
  attestations (ADR-0032); a second sequence would disagree with it. Wingman
  keeps its release and adds only the chart push, as server-scan does. For the
  same reason it pushes no tag into redbull-platform: the commit subject and
  `Chart.yaml` name the release.
- **server-scan's shape**: sync `templates/` and `files/`, and sed the tag lines
  of a hand-kept `values.yaml` in the copy. Wingman's `values.yaml` and schema
  change together (ADR-0059): a hand-kept copy would lack every new key's
  default, or carry a dropped one, and only the render would tell.
- **The cluster's settings in the copy's `values.yaml`.** The next release
  overwrites them.
- **Naming the registry by `image.registry`.** It prefixes every image, and
  nginx is Red Hat's (ADR-0058): the first render of the copy pulled
  `ghcr.io/team-redbull/registry.access.redhat.com/ubi9/nginx-124`. Each
  Wingman image's `repository` carries the registry instead, as the shared
  workflow writes `image.repository` and as the lab's values already did.
- **Reading the Secret at render time** (`lookup`) to render the OAuthClient's
  secret: Argo renders with `helm template`, where `lookup` returns nothing.
- **An `ExternalSecret` in the chart now.** The platform's Vault and External
  Secrets Operator are not on every cluster yet (`gitops/SECRETS.md`, known
  gaps); the existing-Secret mode takes one later without a chart change.
- **`CreateNamespace=true`**, as server-scan takes it: the ApplicationSet's
  rule is one owner per namespace, the `namespaces` release.
- **Refusing the five secret values outright.** Every deployment by Helm uses
  them today; the defaults keep them.

## Consequences

- A release reaches the lab without a human step, within an Argo sync. A bad
  one is rolled back by reverting its commit in redbull-platform (Argo syncs
  the older chart) or by a fixing release; Wingman keeps no state of its own
  (`docs/upgrade/README.md`, rule 2), so a revert is a full rollback.
- A chart change now has two records: the Wingman tag, and the platform
  commit that names it.
- The job depends on the organisation secret reaching this repository (today
  its visibility is all repositories) and on the packages staying public (the
  platform has no pull secret).
- On a cluster whose Wingman was a Helm release, its record must be retired
  (deleted, never uninstalled) when Argo takes the objects over, or a later
  `helm upgrade` would fight Argo.
- redbull-platform's overrides README no longer says no service overrides
  anything: Wingman is the first that does, for the reason in decision 4.

## Verification

- `tests/repo/test_chart_secrets.py`: the default renders the Secret and the
  OAuthClient, and the switches at their defaults (or absent) change nothing;
  `secrets.existingSecret` renders no Secret and both services read it; each
  secret value beside it fails naming it; an OAuthClient it would need fails;
  the header's `oc create secret` keys are the Secret's.
- `deploy/helm/wingman/ci/existing-secret-values.yaml` is linted and rendered
  by the `chart` job and checked by the hardening tests; `test_chart_schema.py`
  covers the two new keys.
- `tests/repo/test_platform_chart.py`: the copy is the chart but for the six
  image lines and `Chart.yaml`, and renders the three images from GHCR and
  Red Hat's nginx as the chart does; a removed file leaves the copy; a re-run
  writes the same bytes; a newer copy is kept; a render that does not pull the
  release, or pulls nginx through GHCR, is refused; the job runs on `main`
  after `publish` with `contents: read`, checks the token first, and persists
  no credential.
- The redbull-platform side, rendered as Argo renders it (the copy for 3.61.0
  and the lab's override file) before its pull request: no Secret, no
  OAuthClient, nothing cluster-scoped, the three images at 3.61.0 from GHCR and
  nginx from Red Hat.
- `scripts/gate.sh ci` (actionlint, zizmor) on the job.
