"use client";

import { useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LATEST,
  MANUAL_REASON,
  VERSION_HELP,
  channelChoice,
  channelProblem,
  inheritLabel,
  minorOf,
  sigInherited,
  sigValue,
  startingCsvProblem,
  versionChoice,
  type CatalogChoice,
  type Inherited,
  type OperatorDraft,
} from "@/lib/olm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TextField } from "@/components/addons/authoring-fields";
import type { AddonOperator } from "@/types/day2";

/** Base UI keys an item by its value: these stand for the values that are no string. */
const INHERIT = "__inherit__";
const LATEST_KEY = "__latest__";
const OTHER = "__other__";

const LABEL = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

function Choice({
  label,
  value,
  items,
  onPick,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <p id={id} className={LABEL}>
        {label}
      </p>
      <Select value={value} onValueChange={(next) => next && onPick(next)} items={items}>
        <SelectTrigger className="w-full min-w-0 text-xs" aria-labelledby={id}>
          <SelectValue className="min-w-0 truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="max-w-[calc(100vw-2rem)]">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="text-xs">
              <span className={cn("min-w-0 whitespace-normal break-all", item.value.startsWith("__") ? "font-sans" : "font-mono")}>{item.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  if (!children) return null;
  return <p className={cn("text-xs", tone === "warning" ? "text-status-warning-fg" : "text-muted-foreground")}>{children}</p>;
}

/**
 * OperatorHub's Update channel: the catalog's channels when it has the
 * package (each marked where it is missing), else free text and why; the
 * first option inherits the level below.
 */
export function ChannelField({
  choice,
  value,
  inherited,
  onChange,
}: {
  choice: CatalogChoice;
  /** `null`: inherited. */
  value: string | null;
  inherited: Inherited;
  onChange: (value: string | null) => void;
}) {
  if (choice.options === null) {
    const problem = value?.trim() ? channelProblem(value.trim()) : null;
    return (
      <TextField
        label="Update channel"
        value={value ?? ""}
        onChange={(v) => onChange(v === "" ? null : v)}
        placeholder={inherited.value ?? "stable"}
        invalid={Boolean(problem)}
        help={problem ? <span className="text-destructive">{problem}</span> : `${choice.reason} Empty: ${inheritLabel("channel", inherited)}.`}
      />
    );
  }
  const items = [{ value: INHERIT, label: inheritLabel("channel", inherited) }, ...choice.options];
  return (
    <div className="min-w-0 space-y-1">
      <Choice label="Update channel" value={value ?? INHERIT} items={items} onPick={(next) => onChange(next === INHERIT ? null : next)} />
      <Note>{choice.note}</Note>
    </div>
  );
}

/**
 * OperatorHub's Version (`startingCSV`): inherit, "Latest in the channel"
 * (`""`), then the channel's versions newest first, the head marked; free
 * text when the catalog has no list.
 */
export function VersionField({
  choice,
  value,
  inherited,
  onChange,
}: {
  choice: CatalogChoice;
  /** `null`: inherited; `""`: Latest in the channel. */
  value: string | null;
  inherited: Inherited;
  onChange: (value: string | null) => void;
}) {
  // Free text: a version that is no option is typed, once "Another version" is picked.
  const [typing, setTyping] = useState(value !== null && value !== "");
  const listed = choice.options;
  const items = [
    { value: INHERIT, label: inheritLabel("starting_csv", inherited) },
    { value: LATEST_KEY, label: LATEST },
    ...(listed ?? [{ value: OTHER, label: "Another version: type its CSV name" }]),
  ];
  const selected = value === null ? INHERIT : value === "" && !(listed === null && typing) ? LATEST_KEY : listed ? value : OTHER;
  const problem = value ? startingCsvProblem(value.trim()) : null;
  return (
    <div className="min-w-0 space-y-1">
      <Choice
        label="Version"
        value={selected}
        items={items}
        onPick={(next) => {
          setTyping(next === OTHER);
          onChange(next === INHERIT ? null : next === LATEST_KEY || next === OTHER ? "" : next);
        }}
      />
      {listed === null && selected === OTHER && (
        <TextField
          label="CSV name"
          value={value ?? ""}
          onChange={onChange}
          placeholder="cert-manager-operator.v1.14.1"
          invalid={Boolean(problem)}
          help={problem ? <span className="text-destructive">{problem}</span> : "Empty: the latest in the channel."}
        />
      )}
      <Note>{listed === null ? `${choice.reason} ${VERSION_HELP}` : VERSION_HELP}</Note>
    </div>
  );
}

const NO_MINOR: CatalogChoice = {
  options: null,
  reason: "The catalog is read per OpenShift minor: give the pin's full version first.",
  note: null,
};

/**
 * A pin's own Update channel and Version, from its minor's catalog; each
 * inherits the Sig values' (as edited) until it is set.
 */
export function PinOperatorFields({
  op,
  version,
  draft,
  sigDraft,
  onChange,
}: {
  op: AddonOperator;
  /** The pin's version, as typed. */
  version: string;
  draft: OperatorDraft;
  sigDraft: OperatorDraft;
  onChange: (draft: OperatorDraft) => void;
}) {
  const minor = minorOf(version);
  const minors = minor ? [minor] : [];
  const channel = draft.channel?.trim() || sigValue(op, sigDraft, "channel");
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="pin-operator">
      <ChannelField
        choice={minor ? channelChoice(op, minors, draft.channel) : NO_MINOR}
        value={draft.channel}
        inherited={sigInherited(op, sigDraft, "channel")}
        onChange={(value) => onChange({ ...draft, channel: value })}
      />
      <VersionField
        choice={minor ? versionChoice(op, minors, channel, draft.starting_csv) : NO_MINOR}
        value={draft.starting_csv}
        inherited={sigInherited(op, sigDraft, "starting_csv")}
        onChange={(value) => onChange({ ...draft, starting_csv: value })}
      />
    </div>
  );
}

/**
 * OperatorHub's Update approval: Automatic, and Manual shown disabled with
 * why. A file that sets Manual already is shown as it is, with a warning,
 * until someone picks Automatic.
 */
export function ApprovalField({ value, onChange, name }: { value: string | null; onChange: (value: "Automatic") => void; name: string }) {
  const manual = value === "Manual";
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className={LABEL}>Update approval</legend>
      <div role="radiogroup" aria-label="Update approval" className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" name={name} checked={!manual} onChange={() => onChange("Automatic")} />
          Automatic
        </label>
        <label className="flex items-center gap-2 text-muted-foreground" title={MANUAL_REASON}>
          <input type="radio" name={name} checked={manual} disabled />
          Manual
        </label>
      </div>
      <Note>{MANUAL_REASON}</Note>
      {manual && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-status-warning-fg" data-testid="manual-approval">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>The values set Manual today, so the sync stalls at this Subscription. Pick Automatic to write it.</span>
        </p>
      )}
    </fieldset>
  );
}
