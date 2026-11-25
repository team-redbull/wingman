# ADR-0037: Existing clusters join a flavor by one MR that writes only the link, and sync to it by one MR each; Wingman edits a cluster file's text, never a YAML round trip

Date: 2026-11-08
Status: Accepted; superseded in part by ADR-0044 (an import opens one MR per cluster; a new flavor version opens each cluster's sync MR automatically); amended by ADR-0062 (with `DAY1_SCALE_NODEPOOLS` on, a sync leaves drifted locked replicas out of its MR, for update-nodepool); amended 2026-11-25 (a sync and an import open the missing add-ons' day2 MRs in the same action)

Since ADR-0044 (2026-11-12, the architect's decision, confirmed by the
user) an import opens one day1 MR per picked cluster, each the link-only
change for its file, after every pick is checked as below. The text edit,
the statuses, relink, the stale check and sync still hold. The parts that
changed are marked where they are. ADR-0044 also opens the sync below
automatically, one MR per cluster, when a flavor gets a new version; the
merge of the flavor's MR is then its confirmation, and a sync by hand is
refused while an MR already takes the cluster to the newest version.

## Context

Flavors v2 (user decisions of 2026-11-08) lets existing clusters, written by
hand before Wingman, join a flavor: an import writes the flavor link into
the picked files, and after the merge they show their differences as drift
(ADR-0036). A cluster file has several writers (ADR-0012): people and their
comments, Wingman, the allocate-segment workflow (`vlanId`, `dhcp_values`)
and the day1 CI, which appends a block under `# === Added by CI ===`
(`mcFiles`, `mcConfigMap`). The platform-config CI edits these files line by
line for that reason, and checks that its result renders the same values. A
YAML load and dump would reflow and re-quote the file, drop every comment,
and rewrite the CI's block. Nothing in the repo edited a YAML file in place:
day2 writes whole small files, and the legacy `wingman_shared.yaml_utils`
round-trips through ruamel (and new code may not import it).

## Decision

**Text edits, checked.** `wingman_day1.domain.cluster_text` edits lines, as
the platform's own scripts do, with no new dependency:

- `with_header` sets Wingman's header (`# specName`, `# specVersion`,
  `# wingmanAddons`) in the leading comment block: header lines are replaced
  where the first of them is, or put first; no other line changes.
- `edit_values` sets locked values: `owner.<x>`, `platform`, a nodepool's
  `replicas`, `nodeLabels` and `configs`. A replaced value keeps its line's
  comment. A config entry that stays keeps its line, in the file's order; a
  removed one takes only its own lines; new entries go after the last kept
  one, in the indentation the file already uses (production's compact `- `
  or the template's indented one). New keys never go above the leading
  comment block, where the header must stay.
- Every edit checks its own result before it is returned: the text must
  parse, hold exactly the old values with the intended changes (types and
  all: `"3"` is not `3`), keep every line from the CI marker on byte for
  byte, and keep every comment line outside a removed entry. A header edit
  must also leave every line but the header's identical. A layout the editor
  does not handle (a flow-style `nodepool`, a value spread over lines, a key
  below the CI marker) is refused with the reason (422), never written
  approximately; a person edits that file by hand.
- Nothing edits `vlanId`, `dhcp_values`, `mcFiles` or `mcConfigMap`, or any
  line at or below the CI marker.

**Import.** `POST /specs/{name}/import/preview` compares each picked
cluster with the flavor (value drift, missing add-ons, version differences;
ADR-0036) and says whether it can join: `ready`, `relink` (it follows
another flavor), `linked` (it follows this one: sync it instead) or
`refused` (its file cannot be edited safely). `POST /specs/{name}/import`
opens one day1 MR (`[Wingman/Day1] Import spec <flavor> into <n> clusters`,
at most 50) whose one commit gives each file the header with `specName` and
`specVersion` and changes nothing else. *(Superseded by ADR-0044: one MR
per cluster, `[Wingman/Day1] Import cluster <name> into spec <flavor>
v<version>`, each changing only its file's header.)* A cluster that follows another
flavor is refused unless its pick says `relink: true`; then the old header
is replaced, keeping the add-on values requested before for add-ons the new
flavor also lists. Each file update carries the `last_commit_id` the preview
showed: a file that moved since fails the whole import, before or at the
commit (ADR-0006), and nothing is opened. The MR description lists each
cluster with what will show as drift after the merge. *(Superseded by
ADR-0044: a file that moved before the check still opens nothing; one that
moves between the check and its commit fails only its own MR, and each
MR's description shows its own cluster's drift.)*

**Sync.** `POST /clusters/{name}/sync/preview` shows what one day1 MR
would change on a linked cluster: every locked value its file does not hold
(ADR-0036) set to the flavor's, and the header's `specVersion` moved to the
flavor's current version; the diff; each config it removes; and each
nodepool whose configs change. Presets are never synced, and missing add-ons
are listed for the web to install through day2 (ADR-0016: day1 never writes
day2). `POST /clusters/{name}/sync` opens the MR
(`[Wingman/Day1] Sync cluster <name> to spec <flavor> v<version>`):

- **Removals are confirmed.** The rule is exact (ADR-0029), so a sync can
  remove configs. The request must name exactly the preview's removals in
  `confirm_removals`, or it is refused; the MR description names them too.
- **The roll is stated.** Changing a nodepool's configs rolls its nodes. The
  preview and the MR say how, from the nodepool's own keys: drained and
  rebooted in place, one node at a time or `inPlace.maxUnavailable` at a
  time (the chart's default `upgradeType` is `InPlace`), or replaced with new
  nodes (`upgradeType: Replace`).
- **Wingman never guesses hardware.** A nodepool with no network config, or
  several, blocks the sync until the request chooses its hardware type
  (`hardware: [{nodepool, hardware}]`), checked like a create (ADR-0027). A
  locked position the file does not have blocks it until a person edits the
  file.
- **Guards.** The request carries the preview's `last_commit_id` (the commit
  the repo was read at, ADR-0035) and flavor version. The sync is stale only
  if this file changed since that commit or the flavor moved; the write
  carries the commit, so GitLab refuses a file that moves in between
  (ADR-0006).
- **A file with an explicit `mcFiles`** renders only what it names. Wingman
  never writes `mcFiles`, so the preview warns when a config the sync adds is
  not listed there.

**The port.** Import and sync are cluster changes, so they go through
`ClusterProvisioner` (ADR-0017): import as `link`, sync as `apply` with the
`sync` action. *(Superseded by ADR-0044: import is `apply` with the
`import` action too; `link` is gone.)*

## Alternatives rejected

- **A round-trip YAML library** (ruamel): still reflows long lines and
  quoting in places, and the CI block would be rewritten by a parser that is
  not the CI's. A new dependency for less safety.
- **Write the link elsewhere** (a sidecar or a Wingman-owned file): every
  file under `hostedClusters/` becomes an Argo Application (ADR-0012).
- **One MR per cluster**: the user's decision is one day1 MR; a reviewer
  sees the whole import in one place. *(Superseded: ADR-0044 chose it, the
  architect's decision confirmed by the user on 2026-11-12, so that each
  cluster's link is reviewed, merged or rejected on its own.)*
- **Re-link silently**: moving a cluster from one flavor to another changes
  what its locks are; the request has to say so.

## Consequences

- Sync fixes exactly the value drift that needs no decision, in one MR per
  cluster; after it merges the cluster is in sync on its locked values, and
  the web installs its missing add-ons through day2.
- A sync that removes configs, or rolls nodes, says so three times: the
  preview, the confirmation the request must carry, and the MR description.
- Imported clusters are linked when the MR merges, and show their
  differences as drift; nothing on a cluster changes at import. (Since
  ADR-0044, each when its own MR merges.)
- Two imports of the same cluster can both be opened; once one merges the
  other conflicts in GitLab, which refuses to merge it.
- A file whose layout the editor refuses must be fixed by hand before it
  can be imported.

## Verification

- `apps/day1-service/tests/unit/domain/test_cluster_text.py`: exact
  before/after texts on both fixture styles, comments, CRLF and a missing
  final newline, each refusal, and a property test that any configs edit
  changes only the configs and keeps the CI block.
- `apps/day1-service/tests/unit/application/test_imports.py`: the preview's
  statuses and drift, the byte-for-byte import, relink, a moved file or
  flavor, an unparsable file.
- `apps/day1-service/tests/unit/infrastructure/test_merge_requests.py`: one
  commit, the title, branch and footer, and a stale file committing nothing
  (per cluster since ADR-0044).
- `apps/day1-service/tests/unit/application/test_sync.py`: the exact
  synced text on both fixture styles, hardware choices, the removals to
  confirm, how a nodepool's nodes roll (`InPlace`, `maxUnavailable`,
  `Replace`), the `mcFiles` warning, a stale file or flavor, another file
  changing (not stale), nothing to sync, a header-only version move.
- `apps/day1-service/tests/api/test_flavor_links_api.py`: the JSON of drift,
  import and sync.

## Amendment (2026-11-16, ADR-0062): a sync leaves replicas to update-nodepool

With `DAY1_SCALE_NODEPOOLS` on, a sync no longer writes a NodePool's
drifted locked `replicas`: its MR carries the rest (configs, tuning, labels,
the header's version), and the preview and the answer list each such
NodePool in `held_replicas` with its replicas and the flavor's. The sync
dialog offers "Restore with update-nodepool" for each, a by-name run to the
locked value; the MR description names them. When replicas are the only
drift and the version is the same, nothing is left to sync. Off, a sync is
as before.

Verified in `apps/day1-service/tests/api/test_replicas_ownership_api.py`.

## Amendment (2026-11-25): a sync and an import open the day2 add-on MRs in the same action

The user, 2026-11-25: "When pulling a cluster to the flavor the day2 should
open MR as well, no?", and, asked whether in the same action or as the
second click the sync dialog offered: in the same action. A sync used to
open the day1 MR and then offer the missing add-ons as a second click, one
day2 MR per add-on; an import showed them and opened none.

**One action.** `POST /clusters/{name}/sync` opens the day1 MR, then, in
the same request, asks day2 for the install MRs of the add-ons the flavor
lists and day2 does not report installed: one MR per team, through day2's
bulk install, at the team's default version, with the values the file's
header records (`# wingmanAddons`, the create's `addon_overrides`), as a
rollout's ask does (ADR-0044).

- **Day1 asks, not the web**, through the `Day2Installs` port a rollout
  uses (one helper, `application/addon_installs.py`). The order is then
  the server's: nothing is asked when the day1 MR did not open (a stale
  preview, a refusal, an unconfirmed write). A closed tab between two
  browser calls cannot leave the day2 half unasked, and the fakes test
  every answer day2 can give.
- **In the person's name.** Day1 issues the short-lived session it
  presents to day2 (the services share the session secret) for the admin
  who synced or imported, so day2's MRs name them, as an install from the Add-ons tab
  would. A rollout still asks as `system:wingman-rollout`.
- **Linked both ways.** Each day2 MR's description names the day1 MR
  (`!iid` and its address) and says to merge it with that one, or close it
  if that one is closed. The day1 MR's description says Wingman asks day2
  right after it opens, and that any day2 did not open is installed from
  the cluster's Add-ons tab.
- **Not asked twice.** An install MR already open on the cluster for an
  add-on is listed, not asked again.
- **Day2's answer is the answer's `addons`**: `missing`, `opened`,
  `already_open`, `failed` (one line per team, in day2's words; one it did
  not confirm says its MR may have opened), `not_asked` (day2 did not
  answer, so nothing was asked; or day2 did not say what is installed, so
  what is missing is unknown) and `not_opened` (the missing add-ons no MR
  covers). None of it fails the sync: the day1 MR stays open, and nothing
  is retried (ADR-0006).
- **The dialog** shows the day1 MR and each day2 MR together, day2's words
  for what did not open, and offers to install what was not opened, the
  drift tab's Install (one MR per add-on), as the fallback.

**Import, the same per cluster.** `POST /specs/{name}/import` opens each
picked cluster's MR as before (ADR-0044), then asks day2 for each opened
cluster's missing add-ons, measured against the flavor it joins, with the
values its header records (a re-link keeps those the new flavor lists).
Each item of `merge_requests` carries its own `addons`; a cluster whose
import MR did not open has nothing asked. The asks run four clusters at a
time, and two rules keep the request inside the proxy's 60 s (a cut
request invites a retry, ADR-0044): once day2 does not answer for one
cluster no more are asked, and none is asked once the import has run 30 s
(`ASK_BUDGET`). Each cluster not asked says why, and its add-ons are left
for its Add-ons tab. Each day2 MR names that cluster's import MR, which
links the cluster only when it merges: merging the day2 MR without it
installs the add-ons on a cluster that does not follow the flavor yet.
The sheet's last step lists, under each cluster's import MR, its day2 MRs
and day2's words for what did not open.

Rejected:

- **The web making both calls**: the session would be the person's
  without day1 issuing one, but the rule "nothing in day2 without the day1
  MR" would be kept by a page, and a closed tab between the two calls
  leaves half of one action done.
- **Day2 first, as a rollout asks** (so the day1 MR can link the day2
  MRs): the user wants nothing opened in day2 when the day1 MR could not
  be.
- **A comment on the day1 MR with the day2 links**: a second write on it,
  with its own failure to report. The day2 MRs link the day1 MR instead.

Verified in:

- `apps/day1-service/tests/unit/application/test_addon_installs.py`: day2
  answers, refuses a team, does not confirm, does not answer; an open
  install MR is not asked again;
- `apps/day1-service/tests/unit/application/test_sync_addons.py`: the
  order, the person's session, the values from the header, the day1 MR
  staying open, nothing asked for a day1 MR that did not open;
- `apps/day1-service/tests/unit/application/test_import_addons.py`: each
  opened cluster asked once, none for a cluster whose MR did not open, no
  more once day2 stops answering or the budget is spent, a refused team,
  unknown add-ons;
- `apps/day1-service/tests/api/test_addon_installs_api.py`: the JSON of
  both;
- `apps/day2-service/tests/api/test_service_session.py`: day2 opening MRs
  in the name of the person day1 issued the session for;
- `apps/web/e2e/tests/flavor-sync.spec.ts` and `flavor-import.spec.ts`:
  both MRs in the dialog and in the sheet's last step, a day2 refusal and
  a day2 that did not answer.
