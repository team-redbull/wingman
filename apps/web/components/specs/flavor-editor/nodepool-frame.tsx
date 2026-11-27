"use client";

import { createContext, use, useId, useState, type ReactNode } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ProblemCount } from "./editor-section";
import type { FlavorDraft } from "./model";
import { nodepoolSummary } from "./parts";

interface NodepoolDisclosure {
  isOpen: (key: number) => boolean;
  setOpen: (key: number, open: boolean) => void;
  /** The problems at a nodepool's fields, by its index. */
  problems: (index: number) => number;
}

/** The editor's open nodepools, so a problem or Expand all can open one; without it a card keeps its own state. */
export const NodepoolDisclosureContext = createContext<NodepoolDisclosure | null>(null);

/**
 * A nodepool's card: a header that collapses it, summing it up in one line
 * (its InfraEnv or hardware, replicas and machine configs) with its problem
 * count while collapsed, and its Remove; the fields are `children`.
 */
export function NodepoolFrame({
  index,
  draft,
  canRemove,
  onRemove,
  children,
}: {
  index: number;
  draft: FlavorDraft;
  canRemove: boolean;
  onRemove: () => void;
  children: ReactNode;
}) {
  const shared = use(NodepoolDisclosureContext);
  const [own, setOwn] = useState(true);
  const key = draft.keys[index];
  const open = shared ? shared.isOpen(key) : own;
  const setOpen = (next: boolean) => (shared ? shared.setOpen(key, next) : setOwn(next));
  const title = `Nodepool ${index + 1}`;
  const titleId = useId();
  const lineId = useId();
  const countId = useId();
  const problems = open ? 0 : (shared?.problems(index) ?? 0);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<li className="rounded-xl border bg-card shadow-card" data-testid={`nodepool-${index}`} aria-label={title} />}
    >
      <div className={cn("flex items-center gap-3 px-4 py-2.5", open && "border-b")}>
        <h3 className="min-w-0 flex-1 text-sm">
          <CollapsibleTrigger
            aria-labelledby={titleId}
            aria-describedby={problems > 0 ? `${lineId} ${countId}` : lineId}
            data-testid={`nodepool-${index}-toggle`}
            className="group -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left"
          >
            <ChevronRight
              aria-hidden
              className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 group-hover:text-foreground", open && "rotate-90")}
            />
            <span id={titleId} className="shrink-0 font-semibold">
              {title}
            </span>
            <span id={lineId} className="min-w-0 truncate text-xs text-muted-foreground" data-testid={`nodepool-${index}-line`}>
              {nodepoolSummary(draft, index)}
            </span>
            <ProblemCount id={countId} count={problems} className="shrink-0" />
          </CollapsibleTrigger>
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          disabled={!canRemove}
          onClick={onRemove}
          aria-label={`Remove nodepool ${index + 1}`}
        >
          <Trash2 /> Remove
        </Button>
      </div>
      <CollapsiblePanel>{children}</CollapsiblePanel>
    </Collapsible>
  );
}
