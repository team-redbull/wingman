"use client";

import Link from "next/link";
import { ChevronsDownUp, ChevronsUpDown, Eye } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProblemCount } from "./editor-section";
import { SECTIONS, type SectionId } from "./parts";

/**
 * The editor's sticky bar: its parts in order, each with its problem count
 * (a click opens the part and goes to it), Collapse all or Expand all, and
 * the review that starts a save.
 */
export function EditorNav({
  active,
  counts,
  onPart,
  anyCollapsed,
  onAll,
  backHref,
  isNew,
  onReview,
  pending,
}: {
  active: SectionId;
  counts: Record<SectionId, number>;
  onPart: (id: SectionId) => void;
  anyCollapsed: boolean;
  /** Open every part (`true`) or collapse them. */
  onAll: (open: boolean) => void;
  backHref: string;
  isNew: boolean;
  onReview: () => void;
  pending: boolean;
}) {
  const all = anyCollapsed ? "Expand all" : "Collapse all";
  return (
    <nav
      aria-label="Flavor parts"
      className="sticky top-0 z-20 -mx-4 border-b border-border/70 bg-background/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/65 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <div className="flex items-center gap-3 py-2.5">
        <ol className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1">
          {SECTIONS.map((section, index) => {
            const current = active === section.id;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => onPart(section.id)}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60",
                    current ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="hidden text-xs tabular text-muted-foreground sm:inline">{index + 1}</span>
                  {section.title}
                  <ProblemCount count={counts[section.id]} className="ml-0.5" />
                </button>
              </li>
            );
          })}
        </ol>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => onAll(anyCollapsed)} aria-label={all} title={all} className="text-muted-foreground">
            {anyCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            <span className="hidden lg:inline">{all}</span>
          </Button>
          <Link href={backHref} className={cn(buttonVariants({ variant: "ghost" }), "hidden sm:inline-flex")}>
            Cancel
          </Link>
          <Button onClick={onReview} disabled={pending}>
            <Eye /> {isNew ? "Review & Create" : "Review & Update"}
          </Button>
        </div>
      </div>
    </nav>
  );
}
