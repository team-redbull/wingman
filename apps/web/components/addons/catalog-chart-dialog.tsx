"use client";

import { useState } from "react";
import { AlertTriangle, ArrowRight, Pencil } from "lucide-react";
import { addonHref, revisionLabel, syncSummary } from "@/lib/day2";
import { settingText } from "@/lib/olm";
import { cn } from "@/lib/utils";
import { inlineYaml, leaves, pathLabel, toYaml } from "@/lib/values";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IntentLink } from "@/components/common/intent-link";
import { DefinitionList } from "@/components/addons/definition-list";
import { FindingsList } from "@/components/addons/findings";
import { OperatorSettingsList, OperatorWhere } from "@/components/addons/operator-settings";
import { useAddonOperator } from "@/components/addons/use-addon-reads";
import { ValuesLevels } from "@/components/addons/values-levels";
import type { AddonOperator, CatalogEntry } from "@/types/day2";

/** An add-on's page: its fleet defaults, which destinations they reach and each one's overrides (ADR-0053). */
function DefaultsLink({ team, name }: { team: string; name: string }) {
  return (
    <IntentLink href={addonHref(team, name)} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}>
      Defaults &amp; overrides
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </IntentLink>
  );
}

function SigValues({ entry }: { entry: CatalogEntry }) {
  const [view, setView] = useState<"table" | "yaml">("table");
  const values = leaves(entry.default_values);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <ValuesLevels current="Sig values" path={`operators/${entry.name}/values.yaml`} />
        {values.length > 0 && (
          <div className="inline-flex shrink-0 rounded-lg border bg-muted/40 p-0.5" role="group" aria-label="View">
            {(["table", "yaml"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
                  view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "table" ? "Table" : "YAML"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="max-h-[55vh] overflow-auto">
        {values.length === 0 ? (
          <p className="py-4 text-center text-sm italic text-muted-foreground">No Sig values: the chart&apos;s own values apply.</p>
        ) : view === "yaml" ? (
          <pre className="whitespace-pre rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-relaxed">{toYaml(entry.default_values)}</pre>
        ) : (
          <table className="w-full border-collapse text-xs">
            <tbody>
              {values.map(({ path, value }) => (
                <tr key={JSON.stringify(path)} className="border-b border-border/50 last:border-0">
                  <td className="w-2/5 break-all px-3 py-1.5 align-top font-mono font-medium">{pathLabel(path)}</td>
                  <td className="break-all px-3 py-1.5 font-mono text-muted-foreground">{inlineYaml(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function DeployConfig({ entry }: { entry: CatalogEntry }) {
  const meta = entry.argocd_metadata;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        <code>operators/{entry.name}/{entry.name}.yaml</code>: where the chart comes from.
      </p>
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
          ["path", meta.path],
          ["targetRevision", revisionLabel(entry)],
          ["projectNamespace", meta.projectNamespace || "—"],
          ["sync", syncSummary(entry.sync)],
          ["syncPolicy", <pre key="sync" className="whitespace-pre-wrap">{toYaml(meta.syncPolicy) || "—"}</pre>],
          ["fleet default on", entry.fleet_defaults.length > 0 ? entry.fleet_defaults.join(", ") : "—"],
        ]}
      />
    </>
  );
}

function Versions({ entry }: { entry: CatalogEntry }) {
  return (
    <>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-muted-foreground">Chart repo branches, default first</p>
        {entry.available_versions.length === 0 ? (
          <p className="text-xs text-muted-foreground">None readable{entry.chart_project ? "" : ": the chart repo is unknown"}.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {entry.available_versions.map((v, i) => (
              <li key={v} className={cn("rounded-full px-2 py-0.5 font-mono text-xs", i === 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                {v}
                {i === 0 && <span className="font-sans"> · default</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-muted-foreground">Pins per OCP version (ocp-versions/)</p>
        {entry.ocp_version_pins.length === 0 ? (
          <p className="text-xs text-muted-foreground">None: every OCP version gets {revisionLabel(entry)}.</p>
        ) : (
          <DefinitionList items={entry.ocp_version_pins.map((p) => [p.version, p.target_revision ?? "values only"])} />
        )}
      </div>
    </>
  );
}

/** An OLM operator's settings: the Sig values', then each pin's revision and own channel (ADR-0073). */
function Operator({ op }: { op: AddonOperator }) {
  if (!op.sig) return null;
  return (
    <>
      <OperatorWhere op={op} />
      <OperatorSettingsList facts={op.sig.effective} />
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-muted-foreground">Per OCP version</p>
        {op.pins.length === 0 ? (
          <p className="text-xs text-muted-foreground">No pin: every OCP version gets the Sig values&apos; channel.</p>
        ) : (
          <table className="w-full border-collapse text-xs" aria-label="The pins' operator settings">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-0.5 pr-2 font-semibold">OCP</th>
                <th className="py-0.5 pr-2 font-semibold">Revision</th>
                <th className="py-0.5 font-semibold">Update channel</th>
              </tr>
            </thead>
            <tbody>
              {op.pins.map((pin) => (
                <tr key={pin.version} className="border-t border-border/50 font-mono text-[11px]" data-testid={`operator-pin-${pin.version}`}>
                  <td className="py-1 pr-2">{pin.version}</td>
                  <td className="break-all py-1 pr-2">{pin.target_revision ?? <span className="font-sans text-muted-foreground">values only</span>}</td>
                  <td className="break-all py-1">
                    {settingText("channel", pin.effective.channel)}
                    {pin.own.channel === null && <span className="font-sans text-muted-foreground"> (the Sig values&apos;)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <FindingsList findings={op.warnings} showContext />
    </>
  );
}

/**
 * An add-on of the catalog, opened from its card on the Addons page: its
 * Sig values, deploy config, versions and pins, and an OLM operator's
 * settings (ADR-0073). Edit add-on opens the add-on's one editor.
 */
export function CatalogChartDialog({
  entry,
  open,
  onOpenChange,
  isAdmin,
  readOnlyReason,
  onEdit,
}: {
  entry: CatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  readOnlyReason: string | null;
  onEdit: () => void;
}) {
  const operator = useAddonOperator(entry.team, entry.name, open);
  const op = operator.data?.is_operator ? operator.data : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-words pr-8">{entry.name}</DialogTitle>
          <DialogDescription>
            Team <strong>{entry.team}</strong> · revision <strong className="font-mono">{revisionLabel(entry)}</strong>
          </DialogDescription>
        </DialogHeader>
        <FindingsList findings={entry.warnings} showContext />
        <Tabs defaultValue="values">
          <TabsList>
            <TabsTrigger value="values">Sig values</TabsTrigger>
            <TabsTrigger value="deploy">Deploy config</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            {op && <TabsTrigger value="operator">Operator</TabsTrigger>}
          </TabsList>
          <TabsContent value="values" className="space-y-2 pt-2">
            <SigValues entry={entry} />
          </TabsContent>
          <TabsContent value="deploy" className="space-y-3 pt-2">
            <DeployConfig entry={entry} />
          </TabsContent>
          <TabsContent value="versions" className="space-y-3 pt-2">
            <Versions entry={entry} />
          </TabsContent>
          {op && (
            <TabsContent value="operator" className="space-y-3 pt-2">
              <Operator op={op} />
            </TabsContent>
          )}
        </Tabs>
        <DialogFooter showCloseButton>
          {isAdmin && (
            <button
              type="button"
              onClick={onEdit}
              disabled={Boolean(readOnlyReason)}
              title={readOnlyReason ?? undefined}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit add-on
            </button>
          )}
          <DefaultsLink team={entry.team} name={entry.name} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
