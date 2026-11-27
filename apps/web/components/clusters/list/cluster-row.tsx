"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { FlavorStateBadge } from "@/components/clusters/drift-badge";
import { IntentLink } from "@/components/common/intent-link";
import { clusterHref } from "@/lib/clusters";
import type { RowUpgrade } from "@/lib/fleet-upgrades";
import type { LiveStatuses } from "@/lib/live-status";
import { formatDate } from "@/lib/utils";
import type { ClusterStatus, DriftSummaryItem } from "@/types";
import { ClusterFlags, ClusterStatusCell, OwnerCell } from "./cells";
import { UpgradeState } from "./upgrade-state";

/** The live status every row reads from the one bulk query. */
export interface LiveStatusRead {
  /** `null`: live status is off in this deployment; `undefined` until read. */
  statuses: LiveStatuses | undefined;
  isLoading: boolean;
  failed: boolean;
}

function FlavorCell({ cluster }: { cluster: ClusterStatus }) {
  if (!cluster.spec_name) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <IntentLink href={`/specs/${encodeURIComponent(cluster.spec_name)}`} className="hover:text-primary transition-colors font-medium whitespace-nowrap">
        {cluster.spec_name}
      </IntentLink>
      {cluster.spec_version && (
        <span className="rounded-full px-1.5 py-0.5 text-xs bg-primary/8 text-primary font-medium whitespace-nowrap">
          v{cluster.spec_version}
        </span>
      )}
    </div>
  );
}

/** One cluster of the list: its name and flags, live status, place, owner, mastertag and upgrade, flavor, last change and drift. */
export function ClusterRow({
  cluster,
  drift,
  live,
  upgrade,
  isAdmin,
  onPrefetch,
}: {
  cluster: ClusterStatus;
  /** `null` while the drift summary loads. */
  drift: DriftSummaryItem | null;
  live: LiveStatusRead;
  upgrade: RowUpgrade;
  isAdmin: boolean;
  onPrefetch: (cluster: ClusterStatus) => void;
}) {
  return (
    <tr
      data-testid={`cluster-row-${cluster.name}`}
      className="hover:bg-primary/[0.03] transition-colors"
      onMouseEnter={() => onPrefetch(cluster)}
    >
      <td className="px-3 py-3 max-w-[22rem]">
        <div className="flex items-center gap-1.5 min-w-0">
          <IntentLink
            href={clusterHref(cluster)}
            className="font-semibold text-foreground hover:text-primary transition-colors truncate"
            title={cluster.name}
          >
            {cluster.name}
          </IntentLink>
          <ClusterFlags cluster={cluster} />
        </div>
      </td>
      <td className="px-3 py-3">
        <ClusterStatusCell
          cluster={cluster}
          status={live.statuses?.[cluster.name]}
          statusOff={live.statuses === null}
          isLoading={live.isLoading}
          failed={live.failed}
        />
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <div className="leading-snug">
          <p className="text-sm text-foreground">{cluster.site}</p>
          {cluster.mce && <p className="text-xs text-muted-foreground">{cluster.mce}</p>}
        </div>
      </td>
      <td className="px-3 py-3">
        <OwnerCell cluster={cluster} />
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <p className="font-mono text-xs text-muted-foreground">{cluster.mastertag ?? "—"}</p>
        <UpgradeState cluster={cluster} upgrade={upgrade} isAdmin={isAdmin} />
      </td>
      <td className="px-3 py-3">
        <FlavorCell cluster={cluster} />
      </td>
      <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
        <div className="leading-snug">
          <p className="text-sm">{cluster.created_by ?? "—"}</p>
          <p className="text-xs">
            {cluster.created_at ? formatDate(cluster.created_at) : ""}
          </p>
        </div>
      </td>
      <td className="px-3 py-3">
        {drift ? <FlavorStateBadge row={drift} /> : <Skeleton className="h-5 w-16" />}
      </td>
    </tr>
  );
}
