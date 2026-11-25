"use client";

import { useId } from "react";
import { TextField } from "@/components/addons/authoring-fields";
import { YamlValuesField } from "@/components/addons/yaml-values-field";
import { versionProblem, type PinDraft, type VersionSuggestion } from "@/components/addons/ocp-pins/model";

/** The versions to pick from, as buttons: what the add-on's destinations run. */
function Suggestions({ suggestions, chart, onPick }: { suggestions: readonly VersionSuggestion[]; chart: string; onPick: (v: string) => void }) {
  if (suggestions.length === 0) return null;
  return (
    <div className="space-y-1 text-xs" role="group" aria-label="Versions the destinations run">
      <p className="text-muted-foreground">Versions the destinations run:</p>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.slice(0, 8).map((s) => (
          <button
            key={s.version}
            type="button"
            onClick={() => onPick(s.version)}
            className="rounded-full border px-2 py-0.5 font-mono text-[11px] hover:bg-muted"
            title={`${s.destinations} destination${s.destinations === 1 ? "" : "s"} run OCP ${s.version}`}
          >
            {s.version}
            <span className="ml-1 font-sans text-muted-foreground">
              {s.deploying > 0 ? `${s.deploying} with ${chart}` : `${s.destinations} destination${s.destinations === 1 ? "" : "s"}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One pin's fields: the full OpenShift version (fixed for an existing pin),
 * the chart revision there, and its values. The service checks the same
 * rules (`domain/ocp_pins.py`).
 */
export function PinFields({
  chart,
  draft,
  onChange,
  versionFixed = false,
  taken,
  suggestions,
  revisions,
  revisionHelp,
}: {
  chart: string;
  draft: PinDraft;
  onChange: (draft: PinDraft) => void;
  /** An existing pin: its version is its folder's name. */
  versionFixed?: boolean;
  /** The versions pinned already (or by the form's other rows). */
  taken: readonly string[];
  suggestions: readonly VersionSuggestion[];
  /** The chart repo's branches, when known. */
  revisions: readonly string[];
  revisionHelp?: React.ReactNode;
}) {
  const listId = useId();
  const version = draft.version.trim();
  const shownProblem = !versionFixed && version ? versionProblem(version, taken) : null;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="OpenShift version"
          value={draft.version}
          onChange={(v) => onChange({ ...draft, version: v })}
          placeholder="4.16.27"
          disabled={versionFixed}
          help={shownProblem ? <span className="text-destructive">{shownProblem}</span> : undefined}
          hint="The full version a cluster's mastertag gives (4.16.27-x86_64 is 4.16.27), never 4.16: a pin is read only by destinations at exactly that version, so every upgrade, z-streams too, needs its own pin."
        />
        <TextField
          label="Chart revision (targetRevision)"
          value={draft.revision}
          onChange={(v) => onChange({ ...draft, revision: v })}
          placeholder="a branch, or HEAD"
          list={listId}
          help={revisionHelp ?? "A branch of the chart repo; HEAD is its default branch."}
        />
        <datalist id={listId}>
          {revisions.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </div>
      {!versionFixed && <Suggestions suggestions={suggestions} chart={chart} onPick={(v) => onChange({ ...draft, version: v })} />}
      <YamlValuesField
        label="Values for this version"
        path={`operators/${chart || "<name>"}/ocp-versions/${version || "<version>"}/values.yaml`}
        initial={draft.values ?? {}}
        onChange={(values) => onChange({ ...draft, values })}
        placeholder={"# Empty: no values.yaml, the Sig values apply.\nreplicas: 2"}
      />
    </div>
  );
}
