"use client";

import { DEFAULT_SYNC, day2Api, problemOf } from "@/lib/day2";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ProblemList } from "@/components/common/problem-list";
import { AuthoringDialogs } from "@/components/addons/authoring-flow";
import { useAddonTemplate } from "@/components/addons/authoring-fields";
import { YamlValuesField } from "@/components/addons/yaml-values-field";
import { ValuesLevels } from "@/components/addons/values-levels";
import { useAddonDetail, useAddonOperator } from "@/components/addons/use-addon-reads";
import { ChartSection, EditorSection, SyncSection } from "./chart-section";
import { OperatorSection } from "./operator-section";
import { PinsSection } from "./pins-section";
import { editableOperator, type EditorFocus } from "./model";
import { useAddonEditor } from "./use-addon-editor";
import type { AddonDetail, AddonOperator, AuthoringChange, CatalogEntry, UpdateTeamDefaultBody } from "@/types/day2";

interface EditorProps {
  team: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnlyReason: string | null;
  onOpened: (change: AuthoringChange) => void;
  /** Open on the pins: a new one added, or one pin in view (to edit) or marked removed. */
  focus?: EditorFocus;
}

/** The dialog while the add-on and its operator are read, or when the add-on cannot be. */
function Waiting({ team, name, open, onOpenChange, error }: Pick<EditorProps, "team" | "name" | "open" | "onOpenChange"> & { error?: unknown }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-words pr-8">{`Edit add-on ${team}/${name}`}</DialogTitle>
          <DialogDescription>Reading the add-on, its pins and whether it installs an operator.</DialogDescription>
        </DialogHeader>
        {error ? (
          <ProblemList error={error} title={`${team}/${name} could not be read`} />
        ) : (
          <div className="space-y-3" aria-busy="true" data-testid="editor-loading">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}
        <DialogFooter>
          <button type="button" onClick={() => onOpenChange(false)} className={buttonVariants({ variant: "outline" })}>
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditorForm({
  entry,
  detail,
  op,
  operatorError,
  open,
  onOpenChange,
  readOnlyReason,
  onOpened,
  focus,
}: Omit<EditorProps, "team" | "name"> & { entry: CatalogEntry; detail: AddonDetail; op: AddonOperator | null; operatorError: unknown }) {
  const template = useAddonTemplate(entry.team, open);
  const editor = useAddonEditor(entry, detail, op, focus);
  const { draft, set } = editor;
  const operator = editableOperator(op);
  const values = `operators/${entry.name}/values.yaml`;
  return (
    <AuthoringDialogs<UpdateTeamDefaultBody>
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit add-on ${entry.team}/${entry.name}`}
      description={`Changes operators/${entry.name}/ through one merge request: its deploy config, Sig values${op?.is_operator ? ", operator settings" : ""} and OCP-version pins. Every destination that gets ${entry.name} from ${entry.team} and does not override what changes is in the preview.`}
      blocker={editor.blocker}
      readOnlyReason={readOnlyReason}
      body={editor.body}
      method="put"
      url={(dryRun) => day2Api.editAddon(entry.team, entry.name, dryRun)}
      onOpened={onOpened}
    >
      <ChartSection entry={entry} draft={draft} set={set} />
      <SyncSection entry={entry} draft={draft} set={set} known={template.data?.known_sync_options ?? DEFAULT_SYNC.sync_options} />
      {op?.is_operator && (
        <EditorSection title="Operator" description="Update channel, version and approval, as OperatorHub's install page has them.">
          <OperatorSection
            op={op}
            draft={draft.operator}
            onChange={(settings) => set("operator", settings)}
            note={
              <>
                Written into <code className="break-all">{values}</code> at <code>{op.key_path}</code>: only those keys change, and the
                file&apos;s comments stay.
              </>
            }
          />
        </EditorSection>
      )}
      {Boolean(operatorError) && (
        <p role="note" className="text-xs text-status-warning-fg" data-testid="operator-unread">
          Whether {entry.name} installs an OLM operator could not be read ({problemOf(operatorError).detail}): its settings are not
          offered here.
        </p>
      )}
      <EditorSection title="Sig values" description={<ValuesLevels current="Sig values" />}>
        <YamlValuesField label="Sig values" path={values} initial={draft.values ?? entry.default_values} onChange={(v) => set("values", v)} />
      </EditorSection>
      <EditorSection
        title="OCP-version pins"
        description={
          <>
            <code>operators/{entry.name}/ocp-versions/&lt;version&gt;/</code>: a destination at exactly that OpenShift version gets the
            pin&apos;s revision, values{operator ? " and channel" : ""}. Each new version, z-streams too, needs its own pin.
          </>
        }
      >
        <PinsSection
          detail={detail}
          operator={operator}
          cards={draft.pins}
          onChange={(pins) => set("pins", pins)}
          sigDraft={draft.operator}
          focusKey={editor.focusKey}
        />
      </EditorSection>
    </AuthoringDialogs>
  );
}

/**
 * Edit add-on (ADR-0043, ADR-0073): the one editor of an add-on, opened from
 * its page, its pins card and the Addons list alike. It reads the add-on
 * (the page's own query) and whether it installs an OLM operator, then
 * offers, in order: the chart, its sync, the operator's settings (an
 * operator only), the Sig values and the OCP-version pins. Everything goes
 * in one previewed and confirmed merge request.
 */
export function AddonEditorDialog({ team, name, open, onOpenChange, readOnlyReason, onOpened, focus }: EditorProps) {
  const detail = useAddonDetail(team, name, open);
  const operator = useAddonOperator(team, name, open);
  const entry = detail.data?.catalog;
  if (!detail.data || (!operator.data && !operator.error) || !entry) {
    const missing = detail.data && !entry ? new Error(`${name} is not in ${team}'s catalog: there is no operators/${name}/ to edit.`) : undefined;
    return <Waiting team={team} name={name} open={open} onOpenChange={onOpenChange} error={detail.error ?? missing} />;
  }
  return (
    <EditorForm
      entry={entry}
      detail={detail.data}
      op={operator.data ?? null}
      operatorError={operator.data ? null : operator.error}
      open={open}
      onOpenChange={onOpenChange}
      readOnlyReason={readOnlyReason}
      onOpened={onOpened}
      focus={focus}
    />
  );
}
