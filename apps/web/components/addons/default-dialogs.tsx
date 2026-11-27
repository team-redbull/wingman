"use client";

import { useState } from "react";
import { DEFAULT_SYNC, day2Api, sameSync, syncSummary } from "@/lib/day2";
import { sameValues, type Values } from "@/lib/values";
import { AuthoringDialogs } from "@/components/addons/authoring-flow";
import { useAddonTemplate } from "@/components/addons/authoring-fields";
import { SyncOptionsControl } from "@/components/addons/sync-options";
import { YamlValuesField } from "@/components/addons/yaml-values-field";
import type { AuthoringChange, CatalogEntry, MakeDefaultBody, ScopePanel, SyncSettings, UpdateFleetDefaultBody } from "@/types/day2";

/** Inherit the add-on's sync options, or set the fleet layer's own. */
function SyncInheritance({
  inherit,
  onInheritChange,
  inherited,
  sync,
  onSyncChange,
  known,
  name,
}: {
  inherit: boolean;
  onInheritChange: (inherit: boolean) => void;
  /** What inheriting gives, for the label. */
  inherited: string;
  sync: SyncSettings;
  onSyncChange: (sync: SyncSettings) => void;
  known: readonly string[];
  name: string;
}) {
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={name} className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" name={name} checked={inherit} onChange={() => onInheritChange(true)} />
          Inherit the add-on&apos;s <span className="text-muted-foreground">({inherited})</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={name} checked={!inherit} onChange={() => onInheritChange(false)} />
          Set them for this fleet default
        </label>
      </div>
      {!inherit && <SyncOptionsControl value={sync} onChange={onSyncChange} known={known} />}
    </div>
  );
}

/**
 * Make an add-on a fleet default on one scope (ADR-0043):
 * `defaults/<scope>/<chart>/` in one MR. Clusters that have the chart in their
 * own folder move into it in the same MR; the dry run lists them, and each one
 * whose app would change is confirmed (`confirm_changes`).
 */
export function MakeDefaultDialog({
  entry,
  panel,
  open,
  onOpenChange,
  readOnlyReason,
  onOpened,
}: {
  entry: CatalogEntry;
  /** The scope it becomes a default on. */
  panel: ScopePanel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnlyReason: string | null;
  onOpened: (change: AuthoringChange) => void;
}) {
  const template = useAddonTemplate(entry.team, open);
  const [inherit, setInherit] = useState(true);
  const [sync, setSync] = useState<SyncSettings>(entry.sync);
  const [values, setValues] = useState<Values | null>({});
  const reach = panel.destinations.filter((d) => d.renders).length;
  const ownFolders = panel.destinations.filter((d) => d.state === "own-folder");

  const blocker = values === null ? "Fix the values YAML" : null;

  function body(): MakeDefaultBody {
    return { values: values ?? {}, sync: inherit ? null : sync, confirm_changes: [], message: null };
  }

  return (
    <AuthoringDialogs
      open={open}
      onOpenChange={onOpenChange}
      title={`Make ${entry.team}/${entry.name} a default on ${panel.label}`}
      description={`Adds ${panel.folder}/ to sigs/${entry.team}: ArgoCD then deploys ${entry.name} to every ${panel.noun} the team's repo has a folder for (${reach} today).`}
      blocker={blocker}
      readOnlyReason={readOnlyReason}
      body={body}
      method="post"
      url={(dryRun) => day2Api.fleetDefault(entry.team, entry.name, panel.scope, dryRun)}
      onOpened={onOpened}
    >
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sync options</p>
        <SyncInheritance
          inherit={inherit}
          onInheritChange={setInherit}
          inherited={syncSummary(entry.sync)}
          sync={sync}
          onSyncChange={setSync}
          known={template.data?.known_sync_options ?? DEFAULT_SYNC.sync_options}
          name="Fleet default sync options"
        />
      </div>
      <YamlValuesField
        label="Fleet default values"
        path={`${panel.folder}/values.yaml`}
        initial={{}}
        onChange={setValues}
        placeholder="# Empty: the Sig values apply on every destination."
      />
      <p className="text-xs text-muted-foreground">
        {ownFolders.length > 0
          ? `${ownFolders.map((d) => d.name).join(", ")} ${ownFolders.length === 1 ? "has" : "have"} ${entry.name} in ${ownFolders.length === 1 ? "its" : "their"} own folder today: it moves into the default in the same merge request, keeping its app. The preview shows what changes.`
          : `No ${panel.noun} has ${entry.name} in its own folder today.`}
      </p>
    </AuthoringDialogs>
  );
}

/**
 * A fleet default's own files (ADR-0043): `defaults/<scope>/<chart>/values.yaml`
 * and the sync options of its `<chart>.yaml`, edited in place. The per-env and
 * per-destination `values-<x>.yaml` files are not touched (each destination's
 * override is edited from its row).
 */
export function EditFleetDefaultDialog({
  team,
  chart,
  inCatalog,
  panel,
  open,
  onOpenChange,
  readOnlyReason,
  onOpened,
}: {
  team: string;
  chart: string;
  inCatalog: boolean;
  panel: ScopePanel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnlyReason: string | null;
  onOpened: (change: AuthoringChange) => void;
}) {
  const template = useAddonTemplate(team, open);
  const initialValues = panel.values_file.values;
  const [inherit, setInherit] = useState(!panel.sync_overridden);
  const [sync, setSync] = useState<SyncSettings>(panel.sync);
  const [values, setValues] = useState<Values | null>(initialValues);
  const reach = panel.destinations.filter((d) => d.state === "default" || d.state === "duplicate").length;

  function body(): UpdateFleetDefaultBody {
    const out: UpdateFleetDefaultBody = { last_commit_id: panel.values_file.last_commit_id ?? panel.last_commit_id };
    if (values !== null && !sameValues(values, initialValues)) out.values = values;
    if (inherit && panel.sync_overridden) out.sync = null;
    if (!inherit && !sameSync(sync, panel.sync)) out.sync = sync;
    return out;
  }

  const changed = Object.keys(body()).length > 1;
  const blocker = values === null ? "Fix the values YAML" : !changed ? "No changes yet" : null;
  const tweaks = panel.destinations.filter((d) => d.override?.exists).length + panel.env_files.length;

  return (
    <AuthoringDialogs
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit the default ${team}/${chart} on ${panel.label}`}
      description={`Changes ${panel.folder}/ through one merge request: ${chart} on the ${reach} destination${reach === 1 ? "" : "s"} it deploys to. The preview lists each one that changes.`}
      blocker={blocker}
      readOnlyReason={readOnlyReason}
      body={body}
      method="put"
      url={(dryRun) => day2Api.fleetDefault(team, chart, panel.scope, dryRun)}
      onOpened={onOpened}
    >
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sync options</p>
        <SyncInheritance
          inherit={inherit}
          onInheritChange={setInherit}
          inherited={inCatalog ? `operators/${chart}/${chart}.yaml` : `none: no operators/${chart}/`}
          sync={sync}
          onSyncChange={setSync}
          known={template.data?.known_sync_options ?? DEFAULT_SYNC.sync_options}
          name="Fleet default sync options"
        />
      </div>
      <YamlValuesField label="Fleet default values" path={panel.values_file.path} initial={initialValues} onChange={setValues} />
      {tweaks > 0 && (
        <p className="text-xs text-muted-foreground">
          Not changed here: {tweaks} per-env or per-destination file{tweaks === 1 ? "" : "s"}. Each destination&apos;s own
          file is edited from its row below.
        </p>
      )}
    </AuthoringDialogs>
  );
}
