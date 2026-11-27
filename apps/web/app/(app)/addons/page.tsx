"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronsUpDown, Layers, Package, Plus, RefreshCw, Search, Tag } from "lucide-react";
import { api } from "@/lib/api-client";
import { day2Api, day2Keys, newAddonHref, revisionLabel, teamAccess, uniqueFindings } from "@/lib/day2";
import { cn } from "@/lib/utils";
import { leaves } from "@/lib/values";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, NoMatches } from "@/components/common/empty-state";
import { ProblemList } from "@/components/common/problem-list";
import { FindingsBadge } from "@/components/addons/findings";
import { FleetDefaultsList } from "@/components/addons/fleet-defaults";
import { IntentLink } from "@/components/common/intent-link";
import { ChangeResultPanel, type OpenedChanges } from "@/components/addons/change-result";
import { AddonEditorDialog } from "@/components/addons/addon-editor/addon-editor";
import { CatalogChartDialog } from "@/components/addons/catalog-chart-dialog";
import { useAddonAccess } from "@/components/addons/page-header";
import { ReadOnlyBadge, useTeams } from "@/components/addons/team-access";
import type { AuthoringChange, CatalogEntry, FleetDefault } from "@/types/day2";

/** Write actions on a team's add-ons: admins only, disabled with the reason while the team is read-only (ADR-0043). */
interface TeamWrites {
  isAdmin: boolean;
  readOnlyReason: string | null;
  onOpened: (change: AuthoringChange) => void;
}

function NewAddonButton({ team, writes }: { team: string; writes: TeamWrites }) {
  if (!writes.isAdmin) return null;
  const className = cn(buttonVariants({ size: "sm" }), "ml-auto h-7 gap-1.5");
  return writes.readOnlyReason ? (
    <button type="button" disabled title={writes.readOnlyReason} className={className}>
      <Plus className="h-3.5 w-3.5" aria-hidden />
      New add-on
    </button>
  ) : (
    <IntentLink href={newAddonHref(team)} className={className} aria-label={`New add-on in ${team}`}>
      <Plus className="h-3.5 w-3.5" aria-hidden />
      New add-on
    </IntentLink>
  );
}

function ChartCard({ entry, writes }: { entry: CatalogEntry; writes: TeamWrites }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const count = leaves(entry.default_values).length;
  const warned = uniqueFindings(entry.warnings).length > 0;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "w-full rounded-xl border bg-card p-4 text-left shadow-sm transition-[box-shadow,border-color,transform] duration-150 hover:border-primary/30 hover:shadow-md active:scale-[0.99]",
          warned && "border-status-warning/40",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15">
              <Package className="h-4 w-4" />
            </span>
            <h3 className="truncate text-sm font-semibold" title={entry.name}>
              {entry.name}
            </h3>
          </div>
          <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-full bg-primary/8 px-2 py-0.5 text-xs font-medium text-primary dark:bg-primary/20" title={revisionLabel(entry)}>
            <Tag className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate font-mono">{entry.current_version}</span>
          </span>
        </div>
        <p className="mt-2 truncate text-xs text-muted-foreground" title={entry.argocd_metadata.repourl || undefined}>
          {entry.argocd_metadata.repourl ? (
            entry.argocd_metadata.repourl.replace(/^https?:\/\//, "")
          ) : (
            <span className="inline-flex items-center gap-1 text-status-warning-fg">
              <AlertTriangle className="h-3 w-3" />
              No lowercase repourl
            </span>
          )}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {entry.fleet_defaults.map((scope) => (
            <span key={scope} className="inline-flex items-center gap-1 rounded-full bg-chart-5/12 px-2 py-0.5 text-xs text-chart-5" title={`A fleet default: deployed to every ${scope} destination`}>
              <Layers className="h-3 w-3" />
              {scope}
            </span>
          ))}
          {entry.ocp_version_pins.length > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {entry.ocp_version_pins.length} OCP pin{entry.ocp_version_pins.length === 1 ? "" : "s"}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {entry.available_versions.length} version{entry.available_versions.length === 1 ? "" : "s"} · {count} Sig value{count === 1 ? "" : "s"}
          </span>
          <span className="ml-auto">
            <FindingsBadge findings={entry.warnings} />
          </span>
        </div>
      </button>
      <CatalogChartDialog
        entry={entry}
        open={open}
        onOpenChange={setOpen}
        isAdmin={writes.isAdmin}
        readOnlyReason={writes.readOnlyReason}
        onEdit={() => {
          setOpen(false);
          setEditing(true);
        }}
      />
      {editing && (
        <AddonEditorDialog
          team={entry.team}
          name={entry.name}
          open
          onOpenChange={setEditing}
          readOnlyReason={writes.readOnlyReason}
          onOpened={writes.onOpened}
        />
      )}
    </>
  );
}

function TeamSection({
  team,
  entries,
  fleetDefaults,
  readOnly,
  onOpened,
}: {
  team: string;
  entries: CatalogEntry[];
  fleetDefaults: FleetDefault[];
  /** Wingman has no write access to the team's repo (ADR-0043). */
  readOnly: boolean;
  onOpened: (change: AuthoringChange) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const access = useAddonAccess(team);
  const writes: TeamWrites = { isAdmin: access.isAdmin, readOnlyReason: access.readOnlyReason, onOpened };
  return (
    <section className="space-y-3" aria-label={`Team ${team}`} data-testid={`team-${team}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="group flex items-center gap-2 text-left">
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-150", !expanded && "-rotate-90")} />
          <span className="text-sm font-semibold transition-colors group-hover:text-primary">{team}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{entries.length}</span>
        </button>
        {readOnly && <ReadOnlyBadge />}
        <NewAddonButton team={team} writes={writes} />
      </div>
      {expanded && (
        <div className="space-y-4 pl-6">
          {entries.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => (
                <ChartCard key={`${entry.team}/${entry.name}`} entry={entry} writes={writes} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No add-on in <code>operators/</code> yet{writes.isAdmin ? ": add one with New add-on." : "."}
            </p>
          )}
          <FleetDefaultsList team={team} items={fleetDefaults} />
        </div>
      )}
    </section>
  );
}

type Sort = "name-asc" | "name-desc" | "team-asc";

/**
 * The add-on catalog (ADR-0043, ADR-0053): what each team offers, and where a
 * team admin adds an add-on and edits it (its deploy config and Sig values,
 * `operators/<chart>/`). An add-on's page
 * (Defaults & overrides) has its fleet defaults, which destinations they
 * reach and each destination's overrides. Installing one on a cluster is on
 * that cluster's page. `?team=` shows one team.
 */
export default function AddonsPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 rounded-xl" />}>
      <AddonsCatalog />
    </Suspense>
  );
}

function AddonsCatalog() {
  const only = useSearchParams().get("team");
  const [opened, setOpened] = useState<OpenedChanges | null>(null);
  const onOpened = (change: AuthoringChange) =>
    setOpened({ verb: change.action === "create-addon" ? "Create" : "Update", results: [change], failed: [] });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("name-asc");
  const { data, isLoading, isFetching, error, refetch } = useQuery<CatalogEntry[]>({
    queryKey: day2Keys.catalog,
    queryFn: () => api.get<CatalogEntry[]>(day2Api.catalog),
    staleTime: 120_000,
  });
  const teamList = useTeams();
  const fleet = useQuery<FleetDefault[]>({
    queryKey: day2Keys.fleetDefaults,
    queryFn: () => api.get<FleetDefault[]>(day2Api.fleetDefaults()),
    staleTime: 120_000,
  });

  // The badge only once the list has answered: no flash while it loads.
  const readOnlyOf = (team: string) => {
    const access = teamAccess(teamList.data, team);
    return access.known && !access.writable;
  };

  const needle = search.trim().toLowerCase();
  const filtered = (data ?? [])
    .filter((e) => !only || e.team === only)
    .filter((e) => !needle || e.name.toLowerCase().includes(needle) || e.team.toLowerCase().includes(needle))
    .sort((a, b) =>
      sort === "name-desc"
        ? b.name.localeCompare(a.name)
        : sort === "team-asc"
          ? a.team.localeCompare(b.team) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name),
    );
  const byTeam = new Map<string, CatalogEntry[]>();
  for (const entry of filtered) byTeam.set(entry.team, [...(byTeam.get(entry.team) ?? []), entry]);
  // Without a search every team is listed, with or without charts.
  if (!needle)
    for (const team of teamList.data ?? []) if (!byTeam.has(team.name) && (!only || team.name === only)) byTeam.set(team.name, []);
  const fleetOf = (team: string) =>
    (fleet.data ?? []).filter(
      (fd) => fd.team === team && (!needle || fd.chart.toLowerCase().includes(needle) || team.toLowerCase().includes(needle)),
    );
  const total = data?.length ?? 0;
  const teams = new Set((data ?? []).map((e) => e.team)).size;
  const warned = (data ?? []).filter((e) => e.warnings.length > 0).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "var(--font-heading, var(--font-sans))" }}>
            Addon Catalog
          </h1>
          {isLoading ? (
            <Skeleton className="mt-1.5 h-4 w-56" />
          ) : (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {data
                ? `${total} chart${total === 1 ? "" : "s"} across ${teams} team${teams === 1 ? "" : "s"}${warned ? ` · ${warned} with warnings` : ""}`
                : "The charts the team repos offer"}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            void refetch();
            void teamList.refetch();
            void fleet.refetch();
          }}
          disabled={isFetching}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search addons or teams..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border bg-card py-2 pl-9 pr-4 text-sm transition-shadow focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
            {(
              [
                ["name-asc", "A→Z"],
                ["name-desc", "Z→A"],
                ["team-asc", "Team"],
              ] as [Sort, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => setSort(v)}
                aria-pressed={sort === v}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  sort === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {only && (
        <p className="text-xs text-muted-foreground" data-testid="team-filter">
          Showing <strong>{only}</strong> only ·{" "}
          <Link href="/addons" className="underline hover:text-foreground">
            every team
          </Link>
        </p>
      )}

      {opened && <ChangeResultPanel changes={opened} onDismiss={() => setOpened(null)} />}

      {fleet.error && <ProblemList error={fleet.error} title="The fleet defaults could not be loaded" />}

      {error ? (
        <ProblemList error={error} title="The catalog could not be loaded" />
      ) : isLoading ? (
        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="h-5 w-32" />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-28 rounded-xl" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : byTeam.size === 0 && total > 0 ? (
        <NoMatches what="charts" onClear={() => setSearch("")} clearLabel="Clear search" bordered />
      ) : (
        <div className="space-y-8">
          {total === 0 && (
            <EmptyState
              icon={Package}
              bordered
              title="No charts yet"
              description={
                <>
                  A team&apos;s add-ons appear here once its repo has <code>operators/&lt;chart&gt;/</code>: an admin adds one
                  with New add-on on the team.
                </>
              }
              data-testid="catalog-empty"
            />
          )}
          {[...byTeam.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([team, entries]) => (
              <TeamSection
                key={team}
                team={team}
                entries={entries}
                fleetDefaults={fleetOf(team)}
                readOnly={readOnlyOf(team)}
                onOpened={onOpened}
              />
            ))}
        </div>
      )}
    </div>
  );
}
