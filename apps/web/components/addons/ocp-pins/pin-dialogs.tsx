"use client";

import { useState } from "react";
import { chartRevisions, day2Api } from "@/lib/day2";
import { AuthoringDialogs } from "@/components/addons/authoring-flow";
import { PinFields } from "@/components/addons/ocp-pins/pin-fields";
import {
  EMPTY_PIN,
  changeBody,
  changeProblem,
  draftOf,
  draftProblem,
  pinBody,
  reachAt,
  versionProblem,
  versionSuggestions,
  type PinDraft,
} from "@/components/addons/ocp-pins/model";
import type { AddPinBody, AddonDetail, AddonOcpVersion, AuthoringChange, ChangePinBody, RemovePinBody } from "@/types/day2";

interface DialogProps {
  detail: AddonDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnlyReason: string | null;
  onOpened: (change: AuthoringChange) => void;
}

/** What the destinations at `version` read, said before the preview lists each one. */
function Reach({ detail, version }: { detail: AddonDetail; version: string }) {
  const n = reachAt(detail, version);
  return (
    <p className="text-xs text-muted-foreground" data-testid="pin-reach">
      {n === 0
        ? `No destination that gets ${detail.name} runs OCP ${version || "<version>"} yet: the pin waits for the first one day1 moves there. Merge it before that cluster's mastertag changes.`
        : n === 1
          ? `1 destination that gets ${detail.name} runs OCP ${version}: its app changes, and the preview lists it.`
          : `${n} destinations that get ${detail.name} run OCP ${version}: each one's app changes, and the preview lists it.`}
    </p>
  );
}

/**
 * A new pin of the add-on (ADR-0043's 2026-11-25 amendment):
 * `operators/<chart>/ocp-versions/<version>/` in one MR, its revision and,
 * when given, its values. The version is offered from what the add-on's
 * destinations run.
 */
export function AddPinDialog({ detail, open, onOpenChange, readOnlyReason, onOpened }: DialogProps) {
  const [draft, setDraft] = useState<PinDraft>(EMPTY_PIN);
  const taken = detail.ocp_versions.map((p) => p.version);
  return (
    <AuthoringDialogs<AddPinBody>
      open={open}
      onOpenChange={onOpenChange}
      title={`Pin ${detail.team}/${detail.name} for an OpenShift version`}
      description={`Adds operators/${detail.name}/ocp-versions/<version>/ through one merge request: every destination at exactly that version gets this revision and these values, above the Sig values.`}
      blocker={draftProblem(draft, taken)}
      readOnlyReason={readOnlyReason}
      body={() => pinBody(draft)}
      method="post"
      url={(dryRun) => day2Api.ocpPins(detail.team, detail.name, dryRun)}
      onOpened={onOpened}
    >
      <PinFields
        chart={detail.name}
        draft={draft}
        onChange={setDraft}
        taken={taken}
        suggestions={versionSuggestions(detail)}
        revisions={chartRevisions(detail.catalog ?? undefined)}
      />
      {versionProblem(draft.version, []) === null && <Reach detail={detail} version={draft.version.trim()} />}
    </AuthoringDialogs>
  );
}

/** A pin's revision (edited in place in its `<chart>.yaml`) and values, guarded by the commit it was read at. */
export function EditPinDialog({ detail, pin, open, onOpenChange, readOnlyReason, onOpened }: DialogProps & { pin: AddonOcpVersion }) {
  const [draft, setDraft] = useState<PinDraft>(() => draftOf(pin));
  return (
    <AuthoringDialogs<ChangePinBody>
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit the pin for OCP ${pin.version}`}
      description={`Changes operators/${detail.name}/ocp-versions/${pin.version}/ through one merge request. Only what changes is sent; the deploy config keeps its comments.`}
      blocker={changeProblem(pin, draft)}
      readOnlyReason={readOnlyReason}
      body={() => changeBody(pin, draft)}
      method="put"
      url={(dryRun) => day2Api.ocpPin(detail.team, detail.name, pin.version, dryRun)}
      onOpened={onOpened}
    >
      <PinFields
        chart={detail.name}
        draft={draft}
        onChange={setDraft}
        versionFixed
        taken={[]}
        suggestions={[]}
        revisions={chartRevisions(detail.catalog ?? undefined, pin.target_revision ?? undefined)}
        revisionHelp={
          pin.target_revision
            ? "A branch of the chart repo. To stop pinning one, remove the pin."
            : "This pin holds values only: give a revision to pin one too, or leave it empty."
        }
      />
      <Reach detail={detail} version={pin.version} />
    </AuthoringDialogs>
  );
}

/** Removing a pin: its folder goes, and the destinations at its version get the add-on's revision again. */
export function RemovePinDialog({ detail, pin, open, onOpenChange, readOnlyReason, onOpened }: DialogProps & { pin: AddonOcpVersion }) {
  const revision = detail.catalog?.current_version ?? "HEAD";
  return (
    <AuthoringDialogs<RemovePinBody>
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove the pin for OCP ${pin.version}`}
      description={`Deletes operators/${detail.name}/ocp-versions/${pin.version}/ through one merge request.`}
      blocker={null}
      readOnlyReason={readOnlyReason}
      body={() => ({ last_commit_id: pin.last_commit_id })}
      method="delete"
      url={(dryRun) => day2Api.ocpPin(detail.team, detail.name, pin.version, dryRun)}
      onOpened={onOpened}
    >
      <p className="text-sm">
        The destinations at OCP {pin.version} that get {detail.name} ({reachAt(detail, pin.version)} today) go back to the
        add-on&apos;s revision, <code>{revision}</code>, and its Sig values. The preview lists each one.
      </p>
    </AuthoringDialogs>
  );
}
