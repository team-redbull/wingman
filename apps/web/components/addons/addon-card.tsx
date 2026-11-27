"use client";

import { useState } from "react";
import { AlertTriangle, Boxes, Pencil } from "lucide-react";
import { revisionLabel, syncSummary } from "@/lib/day2";
import { cn } from "@/lib/utils";
import { ignoreDifferencesText } from "@/lib/values";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AddonEditorDialog } from "@/components/addons/addon-editor/addon-editor";
import { DefinitionList } from "@/components/addons/definition-list";
import { FindingsList } from "@/components/addons/findings";
import { OperatorSettingsList, OperatorWhere } from "@/components/addons/operator-settings";
import { RepoFileView } from "@/components/addons/repo-file";
import type { AddonWrites } from "@/components/addons/scope-panel";
import { useAddonOperator } from "@/components/addons/use-addon-reads";
import { ValuesLevels } from "@/components/addons/values-levels";
import type { AddonDetail, CatalogEntry } from "@/types/day2";

function DeployConfig({ entry }: { entry: CatalogEntry }) {
  const meta = entry.argocd_metadata;
  return (
    <DefinitionList
      items={[
        [
          "repourl",
          meta.repourl || (
            <span className="inline-flex items-center gap-1 font-sans text-status-warning-fg">
              <AlertTriangle className="h-3 w-3" />
              none in lowercase: every install must give one
            </span>
          ),
        ],
        ["chart repo", entry.chart_project ?? "not on this GitLab"],
        ["targetRevision", revisionLabel(entry)],
        ["path", meta.path || "."],
        ["projectNamespace", meta.projectNamespace || "—"],
        ["sync", syncSummary(entry.sync)],
        [
          "ignoreDifferences",
          entry.ignore_differences && entry.ignore_differences.length > 0 ? (
            <pre key="ignore" className="whitespace-pre-wrap">
              {ignoreDifferencesText(entry.ignore_differences)}
            </pre>
          ) : (
            "—"
          ),
        ],
      ]}
    />
  );
}

/** An OLM operator's settings as the Sig values give them, in OperatorHub's words (ADR-0073); nothing for a plain chart. */
function OperatorView({ detail }: { detail: AddonDetail }) {
  const operator = useAddonOperator(detail.team, detail.name, detail.in_catalog);
  const op = operator.data;
  if (!op?.is_operator || !op.sig) return null;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3" data-testid="operator-view" role="group" aria-label="Operator">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Operator</p>
      <OperatorWhere op={op} />
      <OperatorSettingsList facts={op.sig.effective} />
      {!op.editable && op.reason && <p className="text-xs text-muted-foreground">{op.reason}</p>}
      <FindingsList findings={op.warnings} showContext />
    </div>
  );
}

/** The add-on itself, `operators/<chart>/`: where it deploys from and how, an operator's settings, and its Sig values. */
export function AddonCard({ detail, writes }: { detail: AddonDetail; writes: AddonWrites }) {
  const [editing, setEditing] = useState(false);
  const entry = detail.catalog;
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-5" aria-label="Add-on">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
          Add-on
        </h2>
        {entry && writes.isAdmin && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={Boolean(writes.readOnlyReason)}
            title={writes.readOnlyReason ?? undefined}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 gap-1.5")}
          >
            <Pencil className="h-3 w-3" />
            Edit add-on
          </button>
        )}
      </div>
      {!entry ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
          {detail.name} is not in {detail.team}&apos;s catalog: there is no <code>operators/{detail.name}/</code>, only the fleet
          defaults below. Their own files are the whole deploy config.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            <code>operators/{detail.name}/</code>: where the chart comes from, how ArgoCD syncs it, and its Sig values.
          </p>
          <DeployConfig entry={entry} />
          <OperatorView detail={detail} />
        </>
      )}
      <Tabs defaultValue="deploy">
        <TabsList>
          <TabsTrigger value="deploy">{detail.name}.yaml</TabsTrigger>
          <TabsTrigger value="values">Sig values</TabsTrigger>
        </TabsList>
        <TabsContent value="deploy" className="pt-2">
          <RepoFileView file={detail.deploy_config} absent={`No operators/${detail.name}/${detail.name}.yaml.`} />
        </TabsContent>
        <TabsContent value="values" className="space-y-2 pt-2">
          <ValuesLevels current="Sig values" />
          <RepoFileView file={detail.values_file} absent="No values.yaml: the chart's own values apply." />
        </TabsContent>
      </Tabs>
      {editing && entry && (
        <AddonEditorDialog
          team={detail.team}
          name={detail.name}
          open
          onOpenChange={setEditing}
          readOnlyReason={writes.readOnlyReason}
          onOpened={writes.onOpened}
        />
      )}
    </section>
  );
}
