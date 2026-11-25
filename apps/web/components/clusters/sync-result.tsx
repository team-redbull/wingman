"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, FileText, Loader2, Package } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Day2Installs } from "@/components/common/day2-installs";
import { ProblemList } from "@/components/common/problem-list";
import { approvalHref } from "@/lib/approvals";
import { hasDay2News, leftToInstall, mayHaveOpened, syncInstalls } from "@/lib/addon-installs";
import { writeErrorTitle } from "@/lib/write-errors";
import { SyncSection as Section } from "./sync-rolling";
import { SyncHeldReplicas } from "./scale/restore-replicas";
import type { AddonDrift, SyncPreview, SyncResult } from "@/types";

/**
 * After "Open sync MR" (ADR-0037's 2026-11-25 amendment): the day1 MR, and
 * beside it what day2 answered for the missing add-ons, asked in the same
 * action once the day1 MR was open. Whatever day2 did not open is offered
 * here through the drift tab's Install, one MR per add-on; nothing is
 * retried on its own (ADR-0006).
 */
export function SyncResultDialog({
  name,
  where,
  result,
  preview,
  onClose,
  onInstallAddons,
}: {
  name: string;
  where: string;
  result: SyncResult;
  preview: SyncPreview;
  onClose: () => void;
  /** Install add-ons through day2 (the drift tab's Fix all). */
  onInstallAddons: (entries: AddonDrift[]) => Promise<unknown>;
}) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<unknown>(null);
  const installs = syncInstalls(result.addons, preview);
  const left = leftToInstall(installs);
  const opened = installs.opened.length;

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstallAddons(left);
      onClose();
    } catch (e) {
      setInstallError(e);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !installing) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Sync MR !{result.iid} opened
            {opened > 0 && ` with ${opened === 1 ? "1 add-on MR" : `${opened} add-on MRs`} in day2`}
          </DialogTitle>
          <DialogDescription>
            Nothing changes on the cluster until they are merged. Each day2 MR names the sync MR: merge them together.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-3 py-1 -mx-1 px-1" data-testid="sync-result">
          <Section title="Day1: the cluster file" icon={FileText} testId="sync-result-day1">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
              <p className="min-w-0 break-words">
                <span className="font-mono text-muted-foreground">!{result.iid}</span> {result.title}
              </p>
              <span className="flex shrink-0 items-center gap-3 font-medium">
                <Link href={approvalHref(result)} className="inline-flex items-center gap-0.5 text-primary hover:underline">
                  Review
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
                <a
                  href={result.web_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
                >
                  GitLab
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </span>
            </div>
          </Section>
          {hasDay2News(installs) && (
            <Section title="Day2: the missing add-ons" icon={Package} testId="sync-addons-offer">
              {installs.missing.length > 0 && (
                <p className="text-sm">
                  {preview.spec_name} lists {installs.missing.length} add-on{installs.missing.length !== 1 ? "s" : ""}{" "}
                  this cluster does not have (
                  <span className="font-mono">{installs.missing.map((a) => a.addon_name).join(", ")}</span>). Day1 never
                  writes day2: it asked day2 for them as the sync MR opened, one MR per team, at the team&apos;s default
                  version, with the values requested at create.
                </p>
              )}
              <Day2Installs installs={installs} cluster={name}>
                {left.length > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="sync-addons-left">
                    {left.length === 1 ? "1 add-on has" : `${left.length} add-ons have`} no install MR (
                    <span className="font-mono">{left.map((a) => a.addon_name).join(", ")}</span>): install{" "}
                    {left.length === 1 ? "it" : "them"} from here, one MR each
                    {mayHaveOpened(installs) && ", once Approvals shows day2 did not open it"}.
                  </p>
                )}
              </Day2Installs>
            </Section>
          )}
          <SyncHeldReplicas name={name} where={where} held={result.held_replicas ?? preview.held_replicas} />
          {Boolean(installError) && (
            <ProblemList error={installError} title={writeErrorTitle(installError, "An install failed")} />
          )}
        </div>
        <DialogFooter>
          <button onClick={onClose} disabled={installing} className={buttonVariants({ variant: "outline" })}>
            {left.length > 0 ? "Not now" : "Close"}
          </button>
          {left.length > 0 && (
            <button onClick={install} disabled={installing} className={buttonVariants()}>
              {installing && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {installing ? "Opening install MRs…" : `Install ${left.length} add-on${left.length !== 1 ? "s" : ""}`}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
