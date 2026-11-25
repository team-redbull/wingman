import type { AddonDrift } from "./drift";

// ── The day2 MRs a sync or an import opens with its day1 MR ─────────────────
// (ADR-0037's 2026-11-25 amendment; docs/notes/2026-11-12-import-mr-per-cluster.md §5)

/** One team's day2 install MR on the cluster; its review page is `/approvals/day2-<team>-<iid>`. */
export interface Day2Install {
  team: string;
  iid: number;
  title: string;
  web_url: string;
  /** The charts it installs. */
  charts: string[];
}

/**
 * What day2 answered when day1 asked it, right after the day1 MR opened, for
 * the add-ons the flavor lists and the cluster lacks. Nothing in it failed
 * the day1 MR, and nothing is retried: what did not open is for a person.
 */
export interface AddonInstalls {
  /** What the flavor lists and day2 does not report installed, with the values asked for. */
  missing: AddonDrift[];
  /** The install MRs day2 opened now, one per team. */
  opened: Day2Install[];
  /** Install MRs already open on the cluster for some of them: not asked again. */
  already_open: Day2Install[];
  /** One line per team whose MR did not open, in day2's words; "may have opened": not confirmed. */
  failed: string[];
  /** Why day2 was not asked at all, or why what is missing is unknown; nothing opened. */
  not_asked: string | null;
  /** The missing add-ons no install MR covers: what a person installs by hand. */
  not_opened: AddonDrift[];
}
