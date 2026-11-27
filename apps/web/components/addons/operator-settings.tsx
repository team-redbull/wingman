"use client";

import { catalogSourceText, installModeText, settingText, type OperatorField } from "@/lib/olm";
import { DefinitionList } from "@/components/addons/definition-list";
import type { AddonOperator, OperatorFacts } from "@/types/day2";

/** Words, not a name: the definition list breaks names anywhere, and words only between them. */
const WORDS = "font-sans break-normal";

/** A setting no file sets: operator-olm's default, said so. */
function Defaulted({ facts, fields, children }: { facts: OperatorFacts; fields: string[]; children: React.ReactNode }) {
  const defaulted = fields.some((f) => facts.defaulted.includes(f));
  return (
    <>
      {children}
      {defaulted && <span className={`${WORDS} text-muted-foreground`}> (operator-olm&apos;s default)</span>}
    </>
  );
}

function setting(facts: OperatorFacts, field: OperatorField, unset: string): React.ReactNode {
  const value = facts[field];
  const text = value === null ? null : settingText(field, value);
  return (
    <Defaulted facts={facts} fields={[field]}>
      {text === null ? (
        <span className={`${WORDS} text-muted-foreground`}>{unset}</span>
      ) : text !== value ? (
        <span className={WORDS}>{text}</span>
      ) : (
        text
      )}
    </Defaulted>
  );
}

/** What OperatorHub shows beside its fields, read only: the chart decides them. */
function operatorFacts(facts: OperatorFacts): [string, React.ReactNode][] {
  return [
    ["Package", facts.package ?? "—"],
    ["Install namespace", facts.namespace ?? "—"],
    ["Installation mode", <span key="mode" className={WORDS}>{installModeText(facts)}</span>],
    [
      "Catalog source",
      <Defaulted key="source" facts={facts} fields={["source", "source_namespace"]}>
        {catalogSourceText(facts)}
      </Defaulted>,
    ],
  ];
}

/** OperatorHub's install page, read: the three settings a level gives, then the chart's facts. */
export function OperatorSettingsList({ facts }: { facts: OperatorFacts }) {
  return (
    <DefinitionList
      items={[
        ["Update channel", setting(facts, "channel", "the chart's default")],
        ["Version", setting(facts, "starting_csv", "the chart's default")],
        ["Update approval", setting(facts, "install_plan_approval", "the chart's default")],
        ...operatorFacts(facts),
      ]}
    />
  );
}

/** The read-only facts alone (the editor's fields stand for the settings). */
export function OperatorFactsList({ facts }: { facts: OperatorFacts }) {
  return <DefinitionList items={operatorFacts(facts)} />;
}

/** Where the settings are written, said once: `operator-olm.subscription` in the Sig values. */
export function OperatorWhere({ op }: { op: AddonOperator }) {
  return (
    <p className="text-xs text-muted-foreground">
      An OLM operator: its chart&apos;s values hold a Subscription at <code>{op.key_path ?? "subscription"}</code>. The Sig values
      set the channel, version and approval for every cluster; a pin can set its own for its OpenShift version.
    </p>
  );
}
