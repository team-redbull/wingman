"use client";

import Link from "next/link";
import { ArrowRight, CircleHelp, ExternalLink, GitPullRequest, TriangleAlert } from "lucide-react";
import { approvalHref } from "@/lib/approvals";
import { day2Ref, mayHaveOpened } from "@/lib/addon-installs";
import { cn } from "@/lib/utils";
import type { AddonInstalls, Day2Install } from "@/types";

function InstallRow({ install, cluster }: { install: Day2Install; cluster: string }) {
  const mr = day2Ref(install);
  return (
    <li
      data-testid={`day2-install-${install.team}-${install.iid}`}
      className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-1.5"
    >
      <p className="min-w-0 text-xs break-words">
        <span className="font-mono text-muted-foreground">
          {install.team} !{install.iid}
        </span>{" "}
        <span className="font-medium">{install.charts.join(", ")}</span>
      </p>
      <span className="flex shrink-0 items-center gap-3 text-xs font-medium">
        <Link
          href={approvalHref(mr)}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
          aria-label={`Review ${install.team} !${install.iid} for ${cluster}`}
        >
          Review
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
        <a
          href={install.web_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
          aria-label={`Open ${install.team} !${install.iid} for ${cluster} in GitLab`}
        >
          GitLab
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </span>
    </li>
  );
}

function Lines({ title, lines, tone }: { title: string; lines: string[]; tone: "warning" | "destructive" }) {
  return (
    <div className="space-y-1">
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          tone === "warning" ? "text-status-warning-fg" : "text-destructive"
        )}
      >
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {title}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 font-mono text-[11px] text-muted-foreground">
        {lines.map((line, i) => (
          <li key={i} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What day2 answered for a cluster's missing add-ons, asked right after its
 * day1 MR opened (ADR-0037's 2026-11-25 amendment): each MR it opened or
 * that was open already, with its review page and GitLab; what it refused
 * or did not confirm, in its words; why it was not asked. `children` is the
 * page's way to install what was not opened.
 */
export function Day2Installs({
  installs,
  cluster,
  children,
  testId = "day2-installs",
}: {
  installs: AddonInstalls;
  cluster: string;
  children?: React.ReactNode;
  testId?: string;
}) {
  const { missing, opened, already_open: alreadyOpen, failed, not_asked: notAsked } = installs;
  if (missing.length === 0 && !notAsked) return null;
  if (missing.length === 0) {
    return (
      <p data-testid={testId} className="flex items-start gap-1.5 text-xs text-status-warning-fg">
        <CircleHelp className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
        <span className="break-words">
          Whether add-ons are missing is unknown, so day2 was not asked ({notAsked}). Check the Drift tab once day2
          answers.
        </span>
      </p>
    );
  }
  return (
    <div data-testid={testId} className="space-y-2">
      {(opened.length > 0 || alreadyOpen.length > 0) && (
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <GitPullRequest className="h-3.5 w-3.5 text-primary" aria-hidden />
            {opened.length > 0
              ? `Day2 opened ${opened.length === 1 ? "1 install MR" : `${opened.length} install MRs`}, one per team`
              : "Install MRs already open in day2"}
          </p>
          <ul className="divide-y" aria-label={`Day2 install MRs for ${cluster}`}>
            {opened.map((install) => (
              <InstallRow key={`${install.team}-${install.iid}`} install={install} cluster={cluster} />
            ))}
          </ul>
          {opened.length > 0 && alreadyOpen.length > 0 && (
            <p className="text-xs text-muted-foreground">Already open, not asked again:</p>
          )}
          <ul className="divide-y" aria-label={`Day2 install MRs already open for ${cluster}`}>
            {alreadyOpen.map((install) => (
              <InstallRow key={`${install.team}-${install.iid}`} install={install} cluster={cluster} />
            ))}
          </ul>
        </div>
      )}
      {failed.length > 0 && (
        <Lines
          title={mayHaveOpened(installs) ? "Not confirmed by day2: check Approvals before installing again" : "Not opened in day2"}
          lines={failed}
          tone={mayHaveOpened(installs) ? "warning" : "destructive"}
        />
      )}
      {notAsked && <Lines title="Day2 was not asked" lines={[notAsked]} tone="warning" />}
      {children}
    </div>
  );
}
