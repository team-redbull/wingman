"use client";

import { useId } from "react";
import { IgnoreDifferencesField, TextField } from "@/components/addons/authoring-fields";
import { SyncOptionsControl } from "@/components/addons/sync-options";
import type { EditorDraft } from "./model";
import type { CatalogEntry } from "@/types/day2";

/** One part of the editor, under its heading. */
export function EditorSection({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h3 id={id} className="text-xs font-semibold uppercase tracking-wide text-foreground/80">
          {title}
        </h3>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      {children}
    </section>
  );
}

type SetField = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) => void;

/** Where the chart comes from: `operators/<chart>/<chart>.yaml`, edited in place. */
export function ChartSection({ entry, draft, set }: { entry: CatalogEntry; draft: EditorDraft; set: SetField }) {
  const listId = useId();
  return (
    <EditorSection
      title="Chart"
      description={
        <>
          <code>operators/{entry.name}/{entry.name}.yaml</code> is edited in place: only the keys that change are rewritten, and
          its comments stay.
        </>
      }
    >
      <TextField label="Chart repo URL (repourl)" type="url" value={draft.repourl} onChange={(v) => set("repourl", v)} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Revision (targetRevision)"
          value={draft.revision}
          onChange={(v) => set("revision", v)}
          placeholder="HEAD"
          list={listId}
          help="Empty: HEAD, the default branch."
        />
        <datalist id={listId}>
          {entry.available_versions.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <TextField label="Path" value={draft.path} onChange={(v) => set("path", v)} placeholder="." help="Empty: the repo root." />
        <TextField label="Project namespace" value={draft.namespace} onChange={(v) => set("namespace", v)} help="Empty: none is set." />
      </div>
    </EditorSection>
  );
}

/** How ArgoCD syncs it, and what it ignores. */
export function SyncSection({ entry, draft, set, known }: { entry: CatalogEntry; draft: EditorDraft; set: SetField; known: readonly string[] }) {
  return (
    <EditorSection title="Sync">
      <SyncOptionsControl value={draft.sync} onChange={(sync) => set("sync", sync)} known={known} />
      <IgnoreDifferencesField path={`operators/${entry.name}/${entry.name}.yaml`} text={draft.ignoreText} onTextChange={(t) => set("ignoreText", t)} />
    </EditorSection>
  );
}
