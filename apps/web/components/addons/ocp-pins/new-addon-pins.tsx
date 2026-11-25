"use client";

import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { PinFields } from "@/components/addons/ocp-pins/pin-fields";
import { withNewRow, type PinRow } from "@/components/addons/ocp-pins/model";
import { useTeamVersions } from "@/components/addons/ocp-pins/use-team-versions";

/**
 * A new add-on's OCP-version pins (ADR-0043's 2026-11-25 amendment), none or
 * more, written in its create MR: each one a full OpenShift version, the
 * chart revision there and its values. The versions offered are the ones
 * the team's destinations run.
 */
export function NewAddonPins({
  team,
  chart,
  rows,
  onChange,
}: {
  team: string;
  chart: string;
  rows: readonly PinRow[];
  onChange: (rows: PinRow[]) => void;
}) {
  const suggestions = useTeamVersions(
    team,
    rows.map((r) => r.version.trim()),
  );
  return (
    <div className="space-y-3">
      {rows.map((row, i) => (
        <div key={row.key} className="space-y-3 rounded-lg border p-3" data-testid={`new-pin-${i}`}>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold">Pin {i + 1}</span>
            <button
              type="button"
              onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 gap-1.5")}
              aria-label={`Remove pin ${i + 1}`}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              Remove
            </button>
          </div>
          <PinFields
            chart={chart}
            draft={row}
            onChange={(draft) => onChange(rows.map((r) => (r.key === row.key ? { ...draft, key: row.key } : r)))}
            taken={rows.filter((r) => r.key !== row.key).map((r) => r.version.trim())}
            suggestions={suggestions}
            revisions={[]}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange(withNewRow(rows))}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 gap-1.5")}
      >
        <Plus className="h-3 w-3" aria-hidden />
        Add a pin
      </button>
    </div>
  );
}
