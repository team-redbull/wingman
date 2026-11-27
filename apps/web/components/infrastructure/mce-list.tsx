"use client";

import Link from "next/link";
import { ChevronRight, ServerCog, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { ProblemList } from "@/components/common/problem-list";
import { Skeleton } from "@/components/ui/skeleton";
import { customerMcesBySite } from "@/lib/infrastructure";
import { clustersHref } from "@/lib/clusters";
import { inventoryHref } from "@/lib/inventory/view";
import { plural } from "@/lib/utils";
import type { Mce } from "@/types";
import { CreateMcePreview } from "./create-mce-preview";
import { Chip, OffConvention, PageHeader, SiteHeading } from "./page-parts";
import { useMces } from "./use-infrastructure";

const CELL = "px-4 py-2.5 align-middle";
/** Env and hub version have their own columns from `sm` up; on a phone they are a line under the name. */
const WIDE = "hidden sm:table-cell";
const NONE = <span className="text-muted-foreground">—</span>;

function MceProblems({ mce }: { mce: Mce }) {
  const lines = [
    ...mce.problems,
    ...(mce.stray_files.length > 0
      ? [`${plural(mce.stray_files.length, "file")} in hostedClusters/ that ${mce.stray_files.length === 1 ? "is" : "are"} not a cluster, each a broken Application: ${mce.stray_files.join(", ")}`]
      : []),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] text-status-warning-fg" data-testid="mce-problems">
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-1 break-words">
          <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * The MCE's hosted clusters, on the clusters list filtered to it
 * (`/clusters?site=&mce=`). Above the row's stretched link, so it opens the
 * list, not Inventory, with a hit area taller than it looks for a finger; on
 * a phone only the count shows, under the column's heading. Quiet, and no
 * link, while the MCE has no cluster.
 */
function ClustersLink({ mce }: { mce: Mce }) {
  const count = mce.cluster_count;
  const words = <span className="hidden sm:inline">{count === 1 ? " cluster" : " clusters"}</span>;
  if (count === 0) {
    return (
      <span className="px-2.5 text-xs tabular-nums text-muted-foreground" data-testid="mce-clusters-none">
        0{words}
      </span>
    );
  }
  return (
    <Link
      href={clustersHref({ site: mce.site, mce: mce.name })}
      aria-label={`${plural(count, "cluster")} on ${mce.name}`}
      className="relative z-10 inline-block rounded-full border bg-card px-2.5 py-1 text-xs font-medium tabular-nums text-foreground transition-colors before:absolute before:-inset-x-1.5 before:-inset-y-2 hover:border-primary/50 hover:text-primary active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      data-testid="mce-clusters-link"
    >
      {count}{words}
    </Link>
  );
}

/**
 * One Customer MCE. The whole row opens its servers in Inventory Management:
 * the name is the link, stretched over the row, so a click anywhere, a
 * middle-click and the keyboard all reach the same place. Its cluster count
 * is a link of its own, to its hosted clusters.
 */
function MceRow({ mce }: { mce: Mce }) {
  return (
    <tr
      className="group relative border-t transition-colors hover:bg-muted/40 active:bg-muted/60 has-[a:focus-visible]:bg-muted/40"
      data-testid="mce-row"
      data-mce={mce.name}
    >
      <td className={CELL}>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={inventoryHref(mce.name)}
            aria-label={`${mce.name}: its servers in Inventory Management`}
            className="font-mono text-[13px] font-medium break-all outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/60"
            data-testid="mce-link"
          >
            {mce.name}
          </Link>
          {/* Above the stretched link, so its tooltip opens rather than the row */}
          <span className="relative z-10"><OffConvention problems={mce.naming_problems} testId="mce-off-convention" /></span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:hidden" data-testid="mce-row-facts">
          {mce.env && <Chip>{mce.env}</Chip>}
          {mce.hub_version && <span className="font-mono">hub {mce.hub_version}</span>}
        </p>
        <MceProblems mce={mce} />
      </td>
      <td className={`${CELL} ${WIDE}`}>{mce.env ? <Chip>{mce.env}</Chip> : NONE}</td>
      <td className={`${CELL} ${WIDE} font-mono text-xs`}>{mce.hub_version ?? NONE}</td>
      <td className={`${CELL} text-right`}><ClustersLink mce={mce} /></td>
      <td className="py-2.5 pr-3 align-middle">
        <ChevronRight
          aria-hidden
          className="ml-auto h-4 w-4 text-muted-foreground/60 transition-[color,transform] duration-150 group-hover:text-foreground motion-safe:group-hover:translate-x-0.5"
        />
      </td>
    </tr>
  );
}

function SiteMces({ site, mces }: { site: string; mces: Mce[] }) {
  return (
    <section className="space-y-2" aria-label={`Site ${site}`} data-testid="mce-site" data-site={site}>
      <SiteHeading site={site} count={plural(mces.length, "MCE")} />
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        {/* Fixed columns, so every site's table lines up with the others; the first row's widths set them */}
        <table className="w-full table-fixed text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">MCE</th>
              <th scope="col" className={`${WIDE} w-[14%] px-4 py-2 font-medium`}>Env</th>
              <th scope="col" className={`${WIDE} w-[24%] px-4 py-2 font-medium`} title="version.yaml: the hub's own OpenShift version">Hub version</th>
              <th scope="col" className="w-20 px-4 py-2 text-right font-medium sm:w-32">Clusters</th>
              <th scope="col" className="w-9"><span className="sr-only">Servers</span></th>
            </tr>
          </thead>
          <tbody>
            {mces.map((mce) => <MceRow key={mce.name} mce={mce} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Body() {
  const mces = useMces();
  if (mces.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" data-testid="mces-loading">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (mces.error) return <ProblemList error={mces.error} title="The MCEs could not be read from the day1 repo" />;
  const sites = customerMcesBySite(mces.data ?? []);
  if (sites.length === 0) {
    return (
      <EmptyState
        icon={ServerCog} bordered title="No Customer MCEs"
        description="Each is a folder of the day1 repo, sites/<site>/mces/<mce>/, installed by hand today; Wingman lists them and creates none. Create MCE previews how one will be made."
        data-testid="mces-empty"
      />
    );
  }
  return <div className="space-y-6">{sites.map((group) => <SiteMces key={group.site} site={group.site} mces={group.items} />)}</div>;
}

/**
 * Customer MCEs (ADR-0067, ADR-0018): the hubs of the customers' hosted
 * clusters, by site, as the day1 repo's folders say them, each opening its
 * servers in Inventory Management, and its cluster count its hosted clusters
 * (ADR-0018's 2026-11-27 amendment). Read only: Wingman never creates or
 * changes an MCE, and Create MCE is a preview of how one will be made
 * (ADR-0018's 2026-11-24 amendment). The seeds are on their own page.
 */
export function MceList() {
  const mces = useMces();
  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 animate-in fade-in duration-300">
      <PageHeader
        title="Customer MCEs"
        subtitle="The hubs of the customers' hosted clusters, by site, as the day1 repo has them; each opens its servers in Inventory Management, and its cluster count its hosted clusters. Placement picks among them for a new cluster."
      >
        <CreateMcePreview mces={mces.data ?? []} />
      </PageHeader>
      <Body />
    </div>
  );
}
