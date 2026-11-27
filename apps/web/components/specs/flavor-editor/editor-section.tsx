"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./controls";
import type { SECTIONS } from "./parts";

type Section = (typeof SECTIONS)[number];

const CARD = "rounded-2xl border bg-card p-5 shadow-card sm:p-6";

/** How many problems a part or a nodepool has, as the step bar shows them; nothing when none. */
export function ProblemCount({ count, className, id }: { count: number; className?: string; id?: string }) {
  if (count === 0) return null;
  return (
    <span
      id={id}
      className={cn("rounded-full bg-destructive/15 px-1.5 text-[10px] font-semibold leading-4 text-destructive tabular", className)}
      aria-label={`${count} to fix`}
    >
      {count}
    </span>
  );
}

/**
 * One part of the editor: its header and, in a card, its fields. A part
 * given `onOpenChange` collapses: its whole header is the toggle and,
 * collapsed, shows the part in one line (`summary`) and its problem count
 * instead of what the part is for. The others always show their card.
 */
export function EditorSection({
  section,
  step,
  open = true,
  onOpenChange,
  summary,
  count = 0,
  children,
}: {
  section: Section;
  step: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  summary?: string;
  count?: number;
  children: ReactNode;
}) {
  const titleId = `${section.id}-title`;
  if (!onOpenChange) {
    return (
      <section id={section.id} aria-labelledby={titleId} className="scroll-mt-20 space-y-4">
        <SectionHeader step={step} title={section.title} description={section.description} id={titleId} />
        <div className={CARD}>{children}</div>
      </section>
    );
  }
  const lineId = `${section.id}-line`;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      render={<section id={section.id} aria-labelledby={titleId} className="scroll-mt-20" data-testid={`part-${section.id}`} />}
    >
      <header className="group relative -mx-2 flex items-start gap-3 rounded-xl px-2 py-1.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground"
        >
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-lg font-semibold leading-tight tracking-[-0.01em]">
            {/* The whole header is the button's target (its ::after), the button named by the title alone */}
            <CollapsibleTrigger
              aria-describedby={lineId}
              className="text-left focus-visible:ring-0 after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring/60"
            >
              {section.title}
            </CollapsibleTrigger>
          </h2>
          <p id={lineId} data-testid={`part-${section.id}-line`} className={cn("mt-0.5 truncate text-sm text-muted-foreground", !open && "text-foreground/75")}>
            {open ? section.description : summary}
          </p>
        </div>
        {!open && <ProblemCount count={count} className="mt-1" />}
        <ChevronRight
          aria-hidden
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-[transform,color] duration-200 group-hover:text-foreground",
            open && "rotate-90"
          )}
        />
      </header>
      <CollapsiblePanel>
        <div className="pt-3">
          <div className={CARD}>{children}</div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
