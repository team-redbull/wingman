"use client";

import { Lock } from "lucide-react";
import { channelChoice, chartInherited, sigMinors, sigValue, versionChoice, type OperatorDraft } from "@/lib/olm";
import { FindingsList } from "@/components/addons/findings";
import { OperatorFactsList, OperatorSettingsList, OperatorWhere } from "@/components/addons/operator-settings";
import { ApprovalField, ChannelField, VersionField } from "./operator-fields";
import type { AddonOperator } from "@/types/day2";

/**
 * An OLM operator's settings at the Sig level, in OperatorHub's order:
 * Update channel, Version, Update approval, then what the chart decides
 * (package, namespace, installation mode, catalog source), read only. The
 * channels offered are those of every OCP minor the add-on's destinations
 * run. An operator Wingman does not edit (two Subscriptions in one chart)
 * shows its settings and why.
 */
export function OperatorSection({
  op,
  draft,
  onChange,
  note,
}: {
  op: AddonOperator;
  draft: OperatorDraft;
  onChange: (draft: OperatorDraft) => void;
  /** Where and how the settings are written. */
  note?: React.ReactNode;
}) {
  const facts = op.sig?.effective ?? op.chart_level ?? null;
  if (!op.editable) {
    return (
      <div className="space-y-3" data-testid="operator-read-only">
        <OperatorWhere op={op} />
        <p role="note" className="flex items-start gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>{op.reason ?? "Wingman shows this operator's settings and does not edit them."} Edit them in the values YAML.</span>
        </p>
        {facts && <OperatorSettingsList facts={facts} />}
        <FindingsList findings={op.warnings} showContext />
      </div>
    );
  }
  const minors = sigMinors(op);
  const channel = sigValue(op, draft, "channel");
  return (
    <div className="space-y-3" data-testid="operator-section">
      <OperatorWhere op={op} />
      <div className="grid gap-3 sm:grid-cols-2">
        <ChannelField
          choice={channelChoice(op, minors, draft.channel)}
          value={draft.channel}
          inherited={chartInherited(op, "channel")}
          onChange={(value) => onChange({ ...draft, channel: value })}
        />
        <VersionField
          choice={versionChoice(op, minors, channel, draft.starting_csv)}
          value={draft.starting_csv}
          inherited={chartInherited(op, "starting_csv")}
          onChange={(value) => onChange({ ...draft, starting_csv: value })}
        />
      </div>
      <ApprovalField
        name="Sig values update approval"
        value={draft.install_plan_approval ?? chartInherited(op, "install_plan_approval").value}
        onChange={(value) => onChange({ ...draft, install_plan_approval: value })}
      />
      {facts && <OperatorFactsList facts={facts} />}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <FindingsList findings={op.warnings} showContext />
    </div>
  );
}
