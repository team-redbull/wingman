"use client";

import { useId, useState } from "react";
import { DEFAULT_SYNC, day2Api } from "@/lib/day2";
import { NO_SETTINGS, type OperatorDraft } from "@/lib/olm";
import { parseIgnoreDifferences, type Values } from "@/lib/values";
import { buttonVariants } from "@/components/ui/button";
import { ProblemList } from "@/components/common/problem-list";
import { AuthoringReview, useAuthoringWrite } from "@/components/addons/authoring-flow";
import { IgnoreDifferencesField, ScopeChoice, TemplateSkeleton, TextField, useAddonTemplate } from "@/components/addons/authoring-fields";
import { WriteError } from "@/components/addons/file-preview";
import { SyncOptionsControl } from "@/components/addons/sync-options";
import { ReadOnlyNote } from "@/components/addons/team-access";
import { ValuesLevels } from "@/components/addons/values-levels";
import { YamlValuesField } from "@/components/addons/yaml-values-field";
import { useAddonChart } from "@/components/addons/use-addon-reads";
import { NewAddonPins } from "@/components/addons/ocp-pins/new-addon-pins";
import type { PinRow } from "@/components/addons/ocp-pins/model";
import { OperatorSection } from "@/components/addons/addon-editor/operator-section";
import { editableOperator } from "@/components/addons/addon-editor/model";
import { createBody, newAddonBlocker, type NewAddonDraft } from "./model";
import type { AddonTemplate, AuthoringChange, CreateAddonBody, FleetScope, SyncSettings } from "@/types/day2";

function Section({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5" aria-label={title}>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      {children}
    </section>
  );
}

/** Where the chart address comes from: only a suggestion (ADR-0060). */
function ChartAddressHint({ team }: { team: string }) {
  return (
    <>
      A team&apos;s charts sit in <code>&lt;team&gt;/helm-charts</code> on Wingman&apos;s GitLab, here <code>{team}/helm-charts</code>, so the
      address follows the name until you edit it. It can be changed to any chart repo.
    </>
  );
}

type Field<T> = { value: T; onChange: (value: T) => void };

/** `operators/<name>/<name>.yaml`: where the chart comes from and how ArgoCD syncs it. */
function DeployConfig({
  team,
  template,
  name,
  repourl,
  namespace,
  revision,
  path,
  sync,
  ignoreText,
  revisions,
  chartProblem,
}: {
  team: string;
  template: AddonTemplate;
  name: Field<string>;
  repourl: Field<string>;
  namespace: Field<string>;
  revision: Field<string>;
  path: Field<string>;
  sync: Field<SyncSettings>;
  ignoreText: Field<string>;
  /** The chart repo's branches, once its address is read. */
  revisions: readonly string[];
  chartProblem: string | null;
}) {
  const listId = useId();
  const chart = name.value.trim() || "<name>";
  return (
    <Section
      title="Deploy config"
      description={
        <>
          <code>operators/{chart}/{chart}.yaml</code>: where the chart comes from and how ArgoCD syncs it.
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" {...name} placeholder="podinfo" help="The chart folder, operators/<name>/: lowercase letters, digits and '-'." />
        <TextField label="Project namespace" {...namespace} placeholder="namespace" help="Where the chart is deployed on each cluster. Empty: none is set." />
      </div>
      <TextField
        label="Chart repo URL (repourl)"
        type="url"
        {...repourl}
        placeholder={`${template.repourl_prefix}<name>.git`}
        hint={<ChartAddressHint team={team} />}
        help={
          chartProblem ? (
            <span className="text-status-warning-fg">Its branches could not be read: {chartProblem}</span>
          ) : (
            <>
              Written as lowercase <code>repourl</code>, the only spelling the platform reads.
            </>
          )
        }
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Revision (targetRevision)"
          {...revision}
          placeholder="HEAD"
          list={revisions.length > 0 ? listId : undefined}
          help="A branch of the chart repo. Empty: HEAD, the repo's default branch."
        />
        <datalist id={listId}>
          {revisions.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <TextField label="Path" {...path} placeholder="." help="The chart's folder in its repo. Empty: the root." />
      </div>
      <SyncOptionsControl value={sync.value} onChange={sync.onChange} known={template.known_sync_options} hint={template.sync_source} />
      <IgnoreDifferencesField path={`operators/${chart}/${chart}.yaml`} text={ignoreText.value} onTextChange={ignoreText.onChange} />
    </Section>
  );
}

/**
 * A new add-on in a team's catalog (ADR-0043, ADR-0053):
 * `operators/<name>/<name>.yaml` and its Sig values, `values.yaml`, in one MR, optionally a
 * fleet default and OCP-version pins in the same MR. It starts from the team's own files
 * (`GET /teams/{team}/addon-template`), and reads the chart its address names
 * (`GET /teams/{team}/addon-chart`): its branches, and for an OLM operator
 * (ADR-0073) the channel, version and approval, at the Sig level and per pin.
 * The preview lists every cluster that already has a chart of that name in
 * its own folder and changes; they are confirmed before the MR opens, against
 * the previewed plan's digest.
 */
export function NewAddonForm({
  team,
  existing,
  readOnlyReason,
  showReason = true,
  onCancel,
  onOpened,
}: {
  team: string;
  /** The team's add-on names, which a new one cannot take. */
  existing: readonly string[];
  /** Why the team's writes are off: the form cannot be previewed. */
  readOnlyReason: string | null;
  /** Show the reason (false while the teams list loads). */
  showReason?: boolean;
  onCancel: () => void;
  onOpened: (change: AuthoringChange) => void;
}) {
  const template = useAddonTemplate(team);
  const data = template.data;
  const [name, setName] = useState("");
  const [repourl, setRepourl] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [path, setPath] = useState("");
  const [namespace, setNamespace] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncSettings | null>(null);
  const [ignoreText, setIgnoreText] = useState("");
  const [values, setValues] = useState<Values | null>({});
  const [scope, setScope] = useState<FleetScope | null>(null);
  const [defaultValues, setDefaultValues] = useState<Values | null>({});
  const [operator, setOperator] = useState<OperatorDraft>(NO_SETTINGS);
  const [pins, setPins] = useState<PinRow[]>([]);
  const write = useAuthoringWrite<CreateAddonBody>({
    method: "post",
    url: (dryRun) => day2Api.createAddon(team, dryRun),
    onOpened,
  });

  const chart = name.trim();
  // Pre-filled while untouched: the chart in the team's charts group (ADR-0060) and the name as namespace.
  const repo = repourl ?? (data && chart ? `${data.repourl_prefix}${chart}.git` : "");
  const ns = namespace ?? chart;
  const chartRead = useAddonChart(team, repo, revision, path);
  // An operator is shown either way; its settings are offered and sent only when Wingman edits it.
  const chartOperator = chartRead.data?.operator?.is_operator ? chartRead.data.operator : null;
  const op = editableOperator(chartOperator);
  const draft: NewAddonDraft = {
    name,
    repourl: repo,
    revision,
    path,
    namespace: ns,
    sync: sync ?? data?.sync ?? DEFAULT_SYNC,
    ignore: parseIgnoreDifferences(ignoreText),
    values,
    scope,
    defaultValues,
    operator,
    pins,
  };
  const blocker = newAddonBlocker(draft, { team, existing, readOnlyReason, showReason, ready: Boolean(data), isOperator: Boolean(op) });

  if (template.error && !data) {
    return <ProblemList error={template.error} title={`What a new add-on in ${team} starts from could not be loaded`} />;
  }
  if (!data) return <TemplateSkeleton />;
  const folder = `operators/${chart || "<name>"}`;

  return (
    <div className="space-y-5" data-testid="new-addon-form">
      {readOnlyReason && showReason && <ReadOnlyNote reason={readOnlyReason} />}
      <DeployConfig
        team={team}
        template={data}
        name={{ value: name, onChange: setName }}
        repourl={{ value: repo, onChange: setRepourl }}
        namespace={{ value: ns, onChange: setNamespace }}
        revision={{ value: revision, onChange: setRevision }}
        path={{ value: path, onChange: setPath }}
        sync={{ value: draft.sync, onChange: setSync }}
        ignoreText={{ value: ignoreText, onChange: setIgnoreText }}
        revisions={chartRead.data?.revisions ?? []}
        chartProblem={chartRead.data?.problem ?? null}
      />

      {chartOperator && (
        <Section title="Operator" description="Its chart installs an OLM operator: its update channel, version and approval, as OperatorHub's install page has them.">
          <OperatorSection
            op={chartOperator}
            draft={operator}
            onChange={setOperator}
            note={
              <>
                Written into <code>{folder}/values.yaml</code> at <code>{chartOperator.key_path}</code>.
              </>
            }
          />
        </Section>
      )}

      <Section title="Sig values" description={<ValuesLevels current="Sig values" />}>
        <YamlValuesField label="Sig values" path={`${folder}/values.yaml`} initial={{}} onChange={setValues} />
      </Section>

      <Section
        title="OCP-version pins"
        description="Optional: a chart revision, values or an operator's channel for every destination at exactly one OpenShift version, in the same merge request. Edit them later from the add-on's page."
      >
        <NewAddonPins team={team} chart={chart} rows={pins} onChange={setPins} revisions={chartRead.data?.revisions ?? []} operator={op} sigDraft={operator} />
      </Section>

      <Section
        title="Fleet default"
        description="Also deploy it to every destination of one kind the team's repo has a folder for, in the same merge request. Manage it later from the add-on's page."
      >
        <ScopeChoice scopes={data.scopes} value={scope} onChange={setScope} allowNone name="Also make it a default for" />
        {scope && (
          <YamlValuesField
            label="Fleet default values"
            path={`defaults/${scope}/${chart || "<name>"}/values.yaml`}
            initial={{}}
            onChange={setDefaultValues}
            placeholder="# Empty: the Sig values apply on every destination."
          />
        )}
      </Section>

      <WriteError error={write.previewError} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className={buttonVariants({ variant: "outline" })}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => write.preview(createBody(draft, Boolean(op)))}
          disabled={Boolean(blocker) || write.previewing}
          title={blocker ?? undefined}
          className={buttonVariants()}
        >
          {write.previewing ? "Checking…" : "Preview changes"}
        </button>
      </div>
      <AuthoringReview write={write} title={`New add-on ${chart} in ${team}`} />
    </div>
  );
}
