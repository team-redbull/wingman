"use client";

import { ArrowRight, Plus, Trash2, Undo2 } from "lucide-react";
import { chartRevisions } from "@/lib/day2";
import { cn } from "@/lib/utils";
import type { OperatorDraft } from "@/lib/olm";
import { buttonVariants } from "@/components/ui/button";
import { PinFields } from "@/components/addons/ocp-pins/pin-fields";
import { reachAt, versionSuggestions, withNewCard, type PinCard } from "@/components/addons/ocp-pins/model";
import { PinOperatorFields } from "./operator-fields";
import type { AddonDetail, AddonOperator } from "@/types/day2";

const small = cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 gap-1.5");

/** Who reads the pin: the destinations at its version, or none yet. */
function Reach({ detail, version }: { detail: AddonDetail; version: string }) {
  const n = reachAt(detail, version);
  return (
    <p className="text-xs text-muted-foreground" data-testid="pin-reach">
      {!version
        ? "A destination at exactly this version reads it."
        : n === 0
          ? `No destination that gets ${detail.name} runs OCP ${version} yet: the pin waits for the first cluster day1 moves there. Merge it before that cluster's mastertag changes.`
          : `${n} destination${n === 1 ? "" : "s"} that get${n === 1 ? "s" : ""} ${detail.name} run${n === 1 ? "s" : ""} OCP ${version}: the preview lists each one that changes.`}
    </p>
  );
}

/** A pin marked for removal: its folder goes in the merge request, until undone. */
function RemovedPin({ detail, card, onUndo, autoFocus }: { detail: AddonDetail; card: PinCard; onUndo: () => void; autoFocus: boolean }) {
  const version = card.from ?? "";
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-status-error/40 bg-status-error/5 px-3 py-2 text-xs"
      data-testid={`editor-pin-${version}`}
    >
      <span className="min-w-0">
        <strong>OCP {version}</strong> is removed: <code className="break-all">operators/{detail.name}/ocp-versions/{version}/</code> goes, and
        its {reachAt(detail, version)} destination(s) get the add-on&apos;s revision and Sig values again.
      </span>
      <button type="button" className={small} onClick={onUndo} autoFocus={autoFocus} aria-label={`Undo removing the pin for OCP ${version}`}>
        <Undo2 className="h-3 w-3" aria-hidden />
        Undo
      </button>
    </div>
  );
}

function PinCardView({
  detail,
  operator,
  card,
  cards,
  index,
  sigDraft,
  onChange,
  onRemove,
  autoFocus,
}: {
  detail: AddonDetail;
  operator: AddonOperator | null;
  card: PinCard;
  cards: readonly PinCard[];
  /** Its place among the new pins (1-based), for a new one. */
  index: number;
  sigDraft: OperatorDraft;
  onChange: (card: PinCard) => void;
  onRemove: () => void;
  autoFocus: boolean;
}) {
  const taken = cards.filter((c) => !c.removed && c.key !== card.key).map((c) => c.version.trim());
  const version = card.version.trim();
  const moved = card.from !== null && version !== "" && version !== card.from;
  const title = card.from ? `OCP ${card.from}` : `New pin ${index}`;
  return (
    <div className="min-w-0 space-y-3 rounded-lg border p-3" data-testid={card.from ? `editor-pin-${card.from}` : `editor-pin-new-${index}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold">{title}</span>
        <button
          type="button"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-7 gap-1.5")}
          onClick={onRemove}
          aria-label={card.from ? `Remove the pin for OCP ${card.from}` : `Remove new pin ${index}`}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          Remove
        </button>
      </div>
      <PinFields
        chart={detail.name}
        draft={card}
        onChange={(draft) => onChange({ ...card, ...draft })}
        taken={taken}
        suggestions={versionSuggestions(detail, taken)}
        offer={card.from === null}
        revisions={chartRevisions(detail.catalog ?? undefined, card.original?.revision || undefined)}
        autoFocus={autoFocus}
        valuesOpen={card.from === null}
      >
        {operator && (
          <PinOperatorFields
            op={operator}
            version={version}
            draft={card.operator}
            sigDraft={sigDraft}
            onChange={(settings) => onChange({ ...card, operator: settings })}
          />
        )}
      </PinFields>
      {moved && (
        <p className="flex flex-wrap items-center gap-1 text-xs text-status-warning-fg" data-testid="pin-moves">
          Its folder moves: <code>ocp-versions/{card.from}/</code>
          <ArrowRight className="h-3 w-3" aria-label="to" />
          <code>ocp-versions/{version}/</code>. Destinations at {card.from} then read no pin.
        </p>
      )}
      <Reach detail={detail} version={version} />
    </div>
  );
}

/**
 * The add-on's OCP-version pins in the editor (ADR-0043's 2026-11-25
 * amendment, ADR-0073): each one's version (a change moves its folder), its
 * revision (optional), an operator's own channel and version from its
 * minor's catalog, and its values. Removing one marks it, with undo; Add pin
 * adds a draft. All of it goes in the editor's one merge request.
 */
export function PinsSection({
  detail,
  operator,
  cards,
  onChange,
  sigDraft,
  focusKey,
}: {
  detail: AddonDetail;
  /** An editable operator: each pin gets its own channel and version. */
  operator: AddonOperator | null;
  cards: PinCard[];
  onChange: (cards: PinCard[]) => void;
  sigDraft: OperatorDraft;
  /** The pin the editor was opened on. */
  focusKey: number | null;
}) {
  const update = (next: PinCard) => onChange(cards.map((c) => (c.key === next.key ? next : c)));
  // A new pin removed is simply gone; an existing one is marked, and goes in the MR.
  const remove = (card: PinCard) => (card.from === null ? onChange(cards.filter((c) => c.key !== card.key)) : update({ ...card, removed: true }));
  const fresh = cards.filter((c) => c.from === null);
  return (
    <div className="space-y-3" data-testid="editor-pins">
      {cards.length === 0 && <p className="text-xs text-muted-foreground">None: every OCP version gets the add-on&apos;s revision.</p>}
      <ul className="space-y-3" aria-label="The pins">
        {cards.map((card) => (
          <li key={card.key}>
            {card.removed ? (
              <RemovedPin detail={detail} card={card} onUndo={() => update({ ...card, removed: false })} autoFocus={card.key === focusKey} />
            ) : (
              <PinCardView
                detail={detail}
                operator={operator}
                card={card}
                cards={cards}
                index={fresh.indexOf(card) + 1}
                sigDraft={sigDraft}
                onChange={update}
                onRemove={() => remove(card)}
                autoFocus={card.key === focusKey}
              />
            )}
          </li>
        ))}
      </ul>
      <button type="button" className={small} onClick={() => onChange(withNewCard(cards))}>
        <Plus className="h-3 w-3" aria-hidden />
        Add pin
      </button>
    </div>
  );
}
