"use client";

import { useState } from "react";
import { AlertTriangle, GitBranch, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { RepoFileView } from "@/components/addons/repo-file";
import type { AddonWrites } from "@/components/addons/scope-panel";
import { AddPinDialog, EditPinDialog, RemovePinDialog } from "@/components/addons/ocp-pins/pin-dialogs";
import { fleetOverrides, reachAt, sortedPins } from "@/components/addons/ocp-pins/model";
import type { AddonDetail, AddonOcpVersion } from "@/types/day2";

type Open = { kind: "add" } | { kind: "edit" | "remove"; pin: AddonOcpVersion } | null;

const small = cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 gap-1.5");

/** The footgun said where the pins are: a fleet default's own revision wins over each of them on its scope. */
function FleetOverrideWarning({ detail }: { detail: AddonDetail }) {
  const overrides = fleetOverrides(detail);
  if (overrides.length === 0) return null;
  return (
    <div
      role="note"
      data-testid="pin-fleet-override"
      className="space-y-1 rounded-lg border border-status-warning/30 bg-status-warning/8 px-3 py-2 text-xs text-status-warning-fg"
    >
      {overrides.map((o) => (
        <p key={o.path} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <code className="break-all">{o.path}</code> sets <code>targetRevision: {o.revision}</code>, which overrides every
            pin: on {o.label} no pin&apos;s revision applies (their values still do). Remove it from the fleet default for the
            pins to take effect there.
          </span>
        </p>
      ))}
    </div>
  );
}

function PinRowView({ detail, pin, writes, onOpen }: { detail: AddonDetail; pin: AddonOcpVersion; writes: AddonWrites; onOpen: (open: Open) => void }) {
  const reach = reachAt(detail, pin.version);
  const blocked = writes.readOnlyReason ?? undefined;
  return (
    <li className="space-y-1 rounded-lg border px-3 py-2" data-testid={`ocp-pin-${pin.version}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold">OCP {pin.version}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {pin.target_revision ? `targetRevision ${pin.target_revision}` : "values only"}
        </span>
        <span className="text-muted-foreground">
          {reach === 0 ? "no destination runs it yet" : `${reach} destination${reach === 1 ? "" : "s"}`}
        </span>
        {writes.isAdmin && (
          <span className="ml-auto flex gap-1.5">
            <button type="button" className={small} disabled={Boolean(blocked)} title={blocked} aria-label={`Edit the pin for OCP ${pin.version}`} onClick={() => onOpen({ kind: "edit", pin })}>
              <Pencil className="h-3 w-3" aria-hidden />
              Edit
            </button>
            <button type="button" className={small} disabled={Boolean(blocked)} title={blocked} aria-label={`Remove the pin for OCP ${pin.version}`} onClick={() => onOpen({ kind: "remove", pin })}>
              <Trash2 className="h-3 w-3" aria-hidden />
              Remove
            </button>
          </span>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-[11px] text-muted-foreground">Its files</summary>
        <div className="mt-2 grid gap-3 lg:grid-cols-2">
          <RepoFileView file={pin.deploy_config} absent="No deploy config: the add-on's revision." />
          <RepoFileView file={pin.values_file} absent="No values.yaml for this version." />
        </div>
      </details>
    </li>
  );
}

/**
 * The add-on's OCP-version pins, and their editor (ADR-0043's 2026-11-25
 * amendment): `operators/<chart>/ocp-versions/<version>/`, read by every
 * destination at exactly that OpenShift version. An admin adds, edits and
 * removes them here, one previewed and confirmed merge request each.
 */
export function OcpPinsCard({ detail, writes }: { detail: AddonDetail; writes: AddonWrites }) {
  const [open, setOpen] = useState<Open>(null);
  const pins = sortedPins(detail.ocp_versions);
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  const dialog = { detail, open: true, onOpenChange: close, readOnlyReason: writes.readOnlyReason, onOpened: writes.onOpened };
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5" aria-label="OCP-version pins">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
          OCP-version pins
        </h2>
        {writes.isAdmin && detail.in_catalog && (
          <button
            type="button"
            className={small}
            disabled={Boolean(writes.readOnlyReason)}
            title={writes.readOnlyReason ?? undefined}
            onClick={() => setOpen({ kind: "add" })}
          >
            <Plus className="h-3 w-3" aria-hidden />
            Add pin
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        <code>operators/{detail.name}/ocp-versions/&lt;version&gt;/</code>: a destination at exactly that OpenShift version gets
        its revision and values. Each new version, z-streams too, needs its own pin before day1 moves a cluster there.
      </p>
      <FleetOverrideWarning detail={detail} />
      {pins.length === 0 ? (
        <p className="text-xs text-muted-foreground">None: every OCP version gets the add-on&apos;s revision.</p>
      ) : (
        <ul className="space-y-2" aria-label="Pins per OCP version">
          {pins.map((pin) => (
            <PinRowView key={pin.version} detail={detail} pin={pin} writes={writes} onOpen={setOpen} />
          ))}
        </ul>
      )}
      {!detail.in_catalog && (
        <p className="text-[11px] text-muted-foreground">A pin belongs to an add-on of the catalog: add {detail.name} to it first.</p>
      )}
      {open?.kind === "add" && <AddPinDialog {...dialog} />}
      {open?.kind === "edit" && <EditPinDialog {...dialog} pin={open.pin} />}
      {open?.kind === "remove" && <RemovePinDialog {...dialog} pin={open.pin} />}
    </section>
  );
}
