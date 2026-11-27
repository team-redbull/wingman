"use client";

import { Fragment, useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Server, TriangleAlert } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ClusterRow, type LiveStatusRead } from "@/components/clusters/list/cluster-row";
import { FiltersBar } from "@/components/clusters/list/filters-bar";
import { countBy, OWNER_LABEL, ownerOf, sortRows, type GroupBy, type SortDir, type SortField } from "@/components/clusters/list/model";
import { SortIcon } from "@/components/clusters/list/sort-icon";
import { useClusterPrefetch } from "@/components/clusters/list/use-cluster-prefetch";
import { useListDrift } from "@/components/clusters/list/use-list-drift";
import { useListFilters } from "@/components/clusters/list/use-list-filters";
import { useListUpgrades } from "@/components/clusters/list/use-list-upgrades";
import { EmptyState, EmptyStateLink, NoMatches } from "@/components/common/empty-state";
import { Pagination, PageSizePicker } from "@/components/common/pagination";
import { ProblemList } from "@/components/common/problem-list";
import { RefreshButton } from "@/components/common/refresh-button";
import { useBulkStatus } from "@/hooks/use-bulk-status";
import { day1Api, day1Keys } from "@/lib/api/day1";
import type { OwnerKey } from "@/lib/clusters";
import { plural } from "@/lib/utils";
import { tenantClusters } from "@/lib/workspaces";
import { useIsAdmin } from "@/stores/auth-store";
import type { ClusterStatus } from "@/types";

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const COLUMNS = 8;
const HEADING = "text-left px-3 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide";

/** A group's heading row: it opens the group, and each page the group continues on. */
function GroupHeading({ groupBy, group, size }: { groupBy: OwnerKey; group: string; size: number }) {
  return (
    <tr data-testid={`owner-group-${groupBy}-${group || "none"}`} className="bg-muted/40">
      <td colSpan={COLUMNS} className="px-3 py-2 text-xs font-semibold text-foreground">
        {group ? `${OWNER_LABEL[groupBy]} ${group}` : `No ${groupBy}`}
        <span className="ml-2 font-normal text-muted-foreground">{plural(size, "cluster")}</span>
      </td>
    </tr>
  );
}

function LoadingRows() {
  return Array.from({ length: 5 }).map((_, i) => (
    <tr key={i}>
      {Array.from({ length: COLUMNS }).map((_, j) => (
        <td key={j} className="px-3 py-3"><Skeleton className="h-4 w-full" /></td>
      ))}
    </tr>
  ));
}

export default function ClustersPage() {
  const isAdmin = useIsAdmin();

  // Sort, grouping and pagination; the filters are useListFilters'
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // The customers' clusters: an admin's KV clusters are on Seeds & KV Clusters (ADR-0067)
  const { data: clusters, isLoading, isFetching, error } = useQuery<ClusterStatus[], Error, ClusterStatus[]>({
    queryKey: day1Keys.clusters.all,
    queryFn: day1Api.clusters.list,
    staleTime: 30_000,
    select: tenantClusters,
  });

  const { data: liveStatuses, isLoading: statusLoading, isError: statusFailed } = useBulkStatus(clusters);
  const live: LiveStatusRead = { statuses: liveStatuses, isLoading: statusLoading, failed: statusFailed };
  const upgrades = useListUpgrades(clusters);
  const driftOf = useListDrift();
  const prefetchCluster = useClusterPrefetch();
  const filters = useListFilters(clusters, driftOf, upgrades, () => setPage(1));

  const filtered = useMemo(
    () => sortRows((clusters ?? []).filter(filters.matches), groupBy, sortField, sortDir),
    [clusters, filters.matches, groupBy, sortField, sortDir]
  );

  /** How many filtered clusters each group has, for its heading (a group can span pages). */
  const groupSizes = useMemo(
    () => (groupBy === "none" ? new Map<string, number>() : countBy(filtered, (c) => ownerOf(c, groupBy))),
    [filtered, groupBy]
  );

  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);
  const flaggedCount = (clusters ?? []).filter((c) => c.problems.length > 0 || !c.naming.follows_convention).length;

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); setPage(1); }
  }

  const sortHeader = (field: SortField, label: string) => (
    <button onClick={() => toggleSort(field)} className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors whitespace-nowrap">
      {label} <SortIcon field={field} sortField={sortField} sortDir={sortDir} />
    </button>
  );

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] mx-auto space-y-4 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "var(--font-heading, var(--font-sans))" }}
          >
            Clusters
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {clusters
              ? `${filtered.length} of ${plural(clusters.length, "cluster")}${filters.hasActive ? " (filtered)" : ""}`
              : "Hosted clusters in the day1 repo"}
            {flaggedCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-status-warning-fg">
                <TriangleAlert className="h-3 w-3" />{flaggedCount} flagged
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <RefreshButton queryKey={day1Keys.clusters.all} fetching={isFetching} title="Refresh clusters" />
          {isAdmin && (
            <Link href="/clusters/new" className={buttonVariants({ size: "sm" })}>
              <Plus className="h-4 w-4 mr-1.5" />New Cluster
            </Link>
          )}
        </div>
      </div>

      <FiltersBar
        filters={filters}
        upgrades={upgrades}
        counted={clusters !== undefined}
        groupBy={groupBy}
        onGroupBy={(g) => { setGroupBy(g); setPage(1); }}
      >
        <PageSizePicker total={filtered.length} sizes={PAGE_SIZE_OPTIONS} pageSize={pageSize} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
      </FiltersBar>

      {error ? (
        <ProblemList error={error} title="The clusters could not be loaded" />
      ) : (
        <>
          <div className="bg-card rounded-xl border shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-3 py-3">{sortHeader("name", "Name")}</th>
                  <th className={HEADING}>Status</th>
                  <th className="text-left px-3 py-3">{sortHeader("site", "Site / MCE")}</th>
                  <th className={`${HEADING} whitespace-nowrap`} title="Merkaz / anaf / mador">Owner</th>
                  <th className="text-left px-3 py-3">{sortHeader("mastertag", "Mastertag")}</th>
                  <th className="text-left px-3 py-3">{sortHeader("spec", "Flavor")}</th>
                  <th className="text-left px-3 py-3">{sortHeader("created_at", "Last change")}</th>
                  <th className={HEADING}>Drift</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading
                  ? <LoadingRows />
                  : paginated.map((cluster, i) => {
                      const group = groupBy === "none" ? null : ownerOf(cluster, groupBy);
                      const startsGroup = group !== null && (i === 0 || ownerOf(paginated[i - 1], groupBy as OwnerKey) !== group);
                      return (
                        <Fragment key={cluster.path}>
                          {startsGroup && <GroupHeading groupBy={groupBy as OwnerKey} group={group} size={groupSizes.get(group) ?? 0} />}
                          <ClusterRow
                            cluster={cluster}
                            drift={driftOf(cluster)}
                            live={live}
                            upgrade={upgrades.stateOf(cluster)}
                            isAdmin={isAdmin}
                            onPrefetch={prefetchCluster}
                          />
                        </Fragment>
                      );
                    })}
                {!isLoading && clusters?.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS}>
                      <EmptyState
                        icon={Server}
                        title="No clusters yet"
                        description="Every hosted cluster file in the day1 repo is listed here."
                        action={isAdmin && <EmptyStateLink href="/clusters/new">New cluster</EmptyStateLink>}
                        data-testid="clusters-empty"
                      />
                    </td>
                  </tr>
                )}
                {!isLoading && clusters && clusters.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS}>
                      <NoMatches what="clusters" onClear={filters.clear} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination page={page} pageSize={pageSize} total={filtered.length} onPage={setPage} />
        </>
      )}
    </div>
  );
}
