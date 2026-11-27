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
 * One pin's fields: the full OpenShift version, the chart revision there
 * (optional: a pin may hold values only, ADR-0073), an operator's settings
 * at that version (`children`), and its values. The service checks the same
 * rules (`domain/ocp_pins.py`).
 */
export function PinFields({
  chart,
  draft,
  onChange,
  taken,
  suggestions,
  revisions,
  revisionHelp,
  offer = true,
  autoFocus = false,
  valuesOpen = true,
  children,
}: {
  chart: string;
  draft: PinDraft;
  onChange: (draft: PinDraft) => void;
  /** The versions the other pins have. */
  taken: readonly string[];
  /** Offered in the version's list, and as buttons when `offer`. */
  suggestions: readonly VersionSuggestion[];
  /** Show the suggestions as buttons (a new pin). */
  offer?: boolean;
  /** The chart repo's branches, when known. */
  revisions: readonly string[];
  revisionHelp?: React.ReactNode;
  /** The version field is focused when it mounts. */
  autoFocus?: boolean;
  /** The values start unfolded. */
  valuesOpen?: boolean;
  /** An operator's settings at this version, between the revision and the values. */
  children?: React.ReactNode;
}) {
  const revisionList = useId();
  const versionList = useId();
  const version = draft.version.trim();
  const shownProblem = version ? versionProblem(version, taken) : null;
  const keys = Object.keys(draft.values ?? {}).length;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="OpenShift version"
          value={draft.version}
          onChange={(v) => onChange({ ...draft, version: v })}
          placeholder="4.16.27"
          list={suggestions.length > 0 ? versionList : undefined}
          autoFocus={autoFocus}
          invalid={Boolean(shownProblem)}
          help={shownProblem ? <span className="text-destructive">{shownProblem}</span> : undefined}
          hint="The full version a cluster's mastertag gives (4.16.27-x86_64 is 4.16.27), never 4.16: a pin is read only by destinations at exactly that version, so every upgrade, z-streams too, needs its own pin."
        />
        <datalist id={versionList}>
          {suggestions.map((s) => (
            <option key={s.version} value={s.version} />
          ))}
        </datalist>
        <TextField
          label="Chart revision (targetRevision)"
          value={draft.revision}
          onChange={(v) => onChange({ ...draft, revision: v })}
          placeholder="values only"
          list={revisionList}
          help={revisionHelp ?? "A branch of the chart repo (HEAD: its default branch). Empty: values only, the add-on's revision."}
        />
        <datalist id={revisionList}>
          {revisions.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </div>
      {offer && <Suggestions suggestions={suggestions} chart={chart} onPick={(v) => onChange({ ...draft, version: v })} />}
      {children}
      <details open={valuesOpen}>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Its values{keys > 0 ? ` (${keys} key${keys === 1 ? "" : "s"})` : ": none"}
        </summary>
        <div className="pt-2">
          <YamlValuesField
            label="Values for this version"
            path={`operators/${chart || "<name>"}/ocp-versions/${version || "<version>"}/values.yaml`}
            initial={draft.values ?? {}}
            onChange={(values) => onChange({ ...draft, values })}
            placeholder={"# Empty: no values.yaml, the Sig values apply.\nreplicas: 2"}
          />
        </div>
      </details>
    </div>
  );
}
