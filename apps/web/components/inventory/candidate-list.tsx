"use client";

import { useMemo, useState } from "react";
import { Info, Lock, Wrench } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Hint } from "@/components/common/hint";
import { ProblemList } from "@/components/common/problem-list";
import {
  NO_CANDIDATE_FILTER, candidateFacets, filterCandidates, isFiltering, type CandidateFilter,
} from "@/lib/inventory/candidate-filter";
import { hardwareLabel, unnamedReason } from "@/lib/inventory/pools";
import { toggled } from "@/lib/inventory/start";
import { groupCandidates, type GroupInfo } from "@/lib/inventory/waiver";
import { cn } from "@/lib/utils";
import type { Candidate, Candidates } from "@/types/inventory";
import { CandidateFilterBar, PickShown } from "./candidate-filters";

const HEALTH_TONE: Record<string, string> = {
  HEALTHY: "bg-status-ready",
  WARNING: "bg-status-warning",
  MAJOR: "bg-status-warning",
  CRITICAL: "bg-status-error",
};

function Why({ candidate }: { candidate: Candidate }) {
  if (!candidate.why_not) return null;
  const Icon = candidate.lock ? Lock : Wrench;
  return (
    <Hint hint={candidate.why_not} label={`Not offered: ${candidate.why_not}`} testId="candidate-why-not">
      <Icon aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
    </Hint>
  );
}

/** The name, its pool's shared prefix muted and cut first, so the part that differs stays whole. */
function ServerName({ candidate, prefix }: { candidate: Candidate; prefix: string | null }) {
  const { name } = candidate;
  const shared = prefix && name.startsWith(prefix) ? prefix : "";
  return (
    <span className="flex min-w-0 flex-1 font-mono" title={name}>
      {shared && <span className="truncate text-muted-foreground">{shared}</span>}
      <span className="shrink-0">{name.slice(shared.length)}</span>
    </span>
  );
}

/** Why a server needs a fix, from server-scan's row: shown, as it decides what an install waives. */
function Problems({ candidate }: { candidate: Candidate }) {
  if (!candidate.offered || candidate.ready || candidate.health_problems.length === 0) return null;
  return (
    <span className="shrink-0 text-status-warning-fg" data-testid="candidate-problems">
      {candidate.health_problems.join(" · ")}
    </span>
  );
}

function GroupHeading({ group, count }: { group: GroupInfo; count: number }) {
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-1 border-b bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
      data-testid="candidate-group"
      data-group={group.group}
    >
      <span>
        {group.label} <span className="tabular-nums">· {count}</span>
      </span>
      <Hint hint={group.hint} label={`About ${group.label}`}>
        <Info aria-hidden className="h-3 w-3" />
      </Hint>
    </div>
  );
}

function CandidateRow({
  candidate: c,
  prefix,
  selected,
  onToggle,
}: {
  candidate: Candidate;
  prefix: string | null;
  selected?: string[];
  onToggle?: (name: string) => void;
}) {
  const picked = selected?.includes(c.name) ?? false;
  return (
    <li
      data-testid="candidate"
      data-server={c.name}
      data-offered={c.offered}
      data-ready={c.ready}
      className={cn("flex items-center gap-2.5 px-2.5 py-1.5 text-xs", !c.offered && "text-muted-foreground")}
    >
      {selected && onToggle && (
        <Checkbox checked={picked} disabled={!c.offered} onCheckedChange={() => onToggle(c.name)} aria-label={`Install ${c.name}`} />
      )}
      <span
        role="img"
        aria-label={`health ${c.health}`}
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", HEALTH_TONE[c.health] ?? "bg-muted-foreground/50")}
        title={c.health}
      />
      <ServerName candidate={c} prefix={prefix} />
      <span className="hidden shrink-0 sm:inline">{hardwareLabel(c)}</span>
      <Problems candidate={c} />
      <Why candidate={c} />
    </li>
  );
}

/** Why the list is every free server: the pool's agentLabels name none, or were not read. */
function Unfiltered({ found }: { found: Candidates }) {
  const why = unnamedReason(found);
  if (why === null) return null;
  return (
    <p className="flex items-start gap-1 px-1 py-1 text-xs text-muted-foreground" data-testid="candidates-unfiltered">
      <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>Every free server in server-scan, not filtered by name. {why}</span>
    </p>
  );
}

/**
 * A pool's servers in no MCE, as server-scan reports them, in three groups:
 * ready (a pool draw could pick them), needing a fix (with why) and not
 * offered (locked, in maintenance, contested; with why). They are the free
 * servers its InfraEnv's agentLabels name, or every free server, said so,
 * when those name none. With `selected`, a picker: a server that is not
 * offered cannot be picked, one that needs a fix can (the dialog then asks to
 * waive its health checks), and filters narrow a long list, its shown servers
 * picked at once (ADR-0057's 2026-11-25 amendment).
 */
export function CandidateList({
  found,
  isLoading,
  error,
  selected,
  onSelected,
}: {
  found: Candidates | undefined;
  isLoading: boolean;
  error: unknown;
  selected?: string[];
  onSelected?: (names: string[]) => void;
}) {
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (error) return <ProblemList error={error} title="The pool's servers could not be read" />;
  if (!found || found.candidates.length === 0) {
    const named = found?.server_prefix ? "is named for this pool" : "is in no MCE";
    return <p className="px-1 py-2 text-xs text-muted-foreground">No free server in server-scan {named}.</p>;
  }
  return (
    <div className="grid gap-1">
      <Unfiltered found={found} />
      {selected && onSelected ? (
        <CandidatePicker found={found} selected={selected} onSelected={onSelected} />
      ) : (
        <CandidateGroups found={found} candidates={found.candidates} />
      )}
    </div>
  );
}

/** The list as a picker: its filters, the servers they keep, and picking the shown ones. */
function CandidatePicker({
  found,
  selected,
  onSelected,
}: {
  found: Candidates;
  selected: string[];
  onSelected: (names: string[]) => void;
}) {
  const [filter, setFilter] = useState<CandidateFilter>(NO_CANDIDATE_FILTER);
  const facets = useMemo(() => candidateFacets(found.candidates), [found.candidates]);
  const shown = filterCandidates(found.candidates, filter, selected);
  const filtering = isFiltering(filter);
  return (
    <div className="grid gap-2">
      <CandidateFilterBar
        facets={facets}
        filter={filter}
        onChange={setFilter}
        shown={shown.length}
        total={found.candidates.length}
        filtering={filtering}
      />
      {shown.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground" data-testid="candidates-none-shown">
          No server matches the filters.
          <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => setFilter(NO_CANDIDATE_FILTER)}>
            Clear the filters
          </button>
        </div>
      ) : (
        <CandidateGroups
          found={found}
          candidates={shown}
          selected={selected}
          onToggle={(name) => onSelected(toggled(selected, name))}
        />
      )}
      <PickShown chosen={selected} shown={shown} onSelected={onSelected} />
    </div>
  );
}

function CandidateGroups({
  found,
  candidates,
  selected,
  onToggle,
}: {
  found: Candidates;
  /** The servers to list: all of them, or those a picker's filters keep. */
  candidates: Candidate[];
  selected?: string[];
  onToggle?: (name: string) => void;
}) {
  return (
    <div
      className={cn("overflow-auto rounded-lg border", selected ? "max-h-[min(26rem,45vh)]" : "max-h-64")}
      role="group"
      aria-label="Servers in no MCE"
    >
      {groupCandidates(candidates).map(({ group, candidates: members }) => (
        <section key={group.group} aria-label={group.label}>
          <GroupHeading group={group} count={members.length} />
          <ul className="divide-y divide-border/60">
            {members.map((c) => (
              <CandidateRow key={c.id} candidate={c} prefix={found.server_prefix} selected={selected} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
