"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Layers, RefreshCw } from "lucide-react";
import { FLEET_SCOPES, keyFromParam, problemOf, teamAddonsHref } from "@/lib/day2";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, EmptyStateLink } from "@/components/common/empty-state";
import { ProblemList } from "@/components/common/problem-list";
import { AddonCard } from "@/components/addons/addon-card";
import { ChangeResultPanel, type OpenedChanges } from "@/components/addons/change-result";
import { FindingsList } from "@/components/addons/findings";
import { ReadOnlyBadge, ReadOnlyNote } from "@/components/addons/team-access";
import { Breadcrumbs, PageTitle, useAddonAccess } from "@/components/addons/page-header";
import { OcpPinsCard } from "@/components/addons/ocp-pins/pins-card";
import { ScopePanelCard, type AddonWrites } from "@/components/addons/scope-panel";
import { useAddonDetail } from "@/components/addons/use-addon-reads";
import type { AuthoringChange, ScopePanel } from "@/types/day2";

const VERB: Record<string, OpenedChanges["verb"]> = { "create-addon": "Create", "make-default": "Promote" };

function sortedScopes(scopes: ScopePanel[]): ScopePanel[] {
  const order = (s: ScopePanel) => {
    const i = FLEET_SCOPES.indexOf(s.scope);
    return i === -1 ? FLEET_SCOPES.length : i;
  };
  return [...scopes].sort((a, b) => order(a) - order(b));
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" data-testid="addon-loading">
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}

/**
 * One add-on of a team, reached from the Addons page (ADR-0053): the add-on
 * itself (`operators/<chart>/` in the team repo: its deploy config, Sig
 * values and an OLM operator's settings, ADR-0073), its OCP-version pins
 * (ADR-0043's 2026-11-25 amendment; both edited in one editor), and
 * one panel per fleet scope: whether it is a default there, which destinations
 * get it, and each destination's overrides. Every write is previewed first and
 * confirmed against the previewed plan. One cluster's add-ons stay on that
 * cluster's page.
 */
export default function AddonPage() {
  const params = useParams<{ team: string; addon: string }>();
  const team = keyFromParam(params.team);
  const name = keyFromParam(params.addon);
  const [opened, setOpened] = useState<OpenedChanges | null>(null);
  const query = useAddonDetail(team, name);
  const detail = query.data;
  const access = useAddonAccess(team, detail);

  const writes: AddonWrites = {
    isAdmin: access.isAdmin,
    readOnlyReason: access.readOnlyReason,
    onOpened: (change: AuthoringChange) => setOpened({ verb: VERB[change.action] ?? "Update", results: [change], failed: [] }),
    onChanges: setOpened,
  };

  const notFound = query.error && problemOf(query.error).status === 404;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <div className="space-y-2">
        <Breadcrumbs items={[{ label: "Addons", href: "/addons" }, { label: team, href: teamAddonsHref(team) }, { label: name }]} />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <PageTitle>{name}</PageTitle>
              {detail && !detail.in_catalog && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">not in the catalog</span>
              )}
              {access.showReason && <ReadOnlyBadge />}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              An add-on of <strong>{team}</strong>: its deploy config and Sig values, the fleet defaults built from it, which
              destinations they reach and each one&apos;s overrides. Its install on one cluster is on that cluster&apos;s page.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")} />
            Refresh
          </button>
        </div>
        {access.isAdmin && access.showReason && access.readOnlyReason && <ReadOnlyNote reason={access.readOnlyReason} />}
      </div>

      {opened && <ChangeResultPanel changes={opened} onDismiss={() => setOpened(null)} />}

      {notFound ? (
        <EmptyState
          bordered
          title={`${team} has no add-on ${name}`}
          description={`Neither operators/${name}/ nor a fleet default of that name is in sigs/${team}.`}
          action={<EmptyStateLink href={teamAddonsHref(team)}>Back to {team}&apos;s add-ons</EmptyStateLink>}
          data-testid="addon-not-found"
        />
      ) : query.error ? (
        <ProblemList error={query.error} title={`${team}/${name} could not be loaded`} />
      ) : !detail ? (
        <PageSkeleton />
      ) : (
        <>
          <FindingsList findings={detail.warnings} showContext />
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <AddonCard detail={detail} writes={writes} />
            <OcpPinsCard detail={detail} writes={writes} />
          </div>
          <section className="space-y-3" aria-label="Defaults">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Layers className="h-4 w-4 text-chart-5" aria-hidden />
                Defaults
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                A fleet default deploys {name} to every destination of one kind that {team}&apos;s repo registers. An MCE or a UPI
                cluster can get values of its own; to have {name} on some MCEs only, deploy it on those MCEs.
              </p>
            </div>
            {sortedScopes(detail.scopes).map((panel) => (
              <ScopePanelCard key={panel.scope} detail={detail} panel={panel} writes={writes} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
