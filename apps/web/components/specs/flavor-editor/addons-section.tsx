"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, GripVertical, Package, Settings2, X } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/lib/api-client";
import { addonKey as keyOf, availableAddons } from "@/lib/addon-transfer";
import { buttonVariants } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigureOverrideableDialog, deepMergeValues } from "@/components/specs/configure-overrideable-dialog";
import { chartRevisions, day2Api, day2Keys } from "@/lib/day2";
import { cn } from "@/lib/utils";
import type { CatalogEntry, OverrideableField, SpecAddon } from "@/types";
import { AvailableAddons, flightOf } from "./addon-catalog";
import { useAddonMoves } from "./use-addon-moves";

function SortableAddonItem({
  addon,
  index,
  onRemove,
  onVersionChange,
  onConfigure,
  availableVersions,
}: {
  addon: SpecAddon;
  index: number;
  onRemove: (button: HTMLElement) => void;
  onVersionChange: (version: string) => void;
  onConfigure: () => void;
  availableVersions: string[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: keyOf(addon) });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const overrideCount = addon.overrideable?.length ?? 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...flightOf(addon)}
      data-testid={`selected-addon-${addon.team}-${addon.name}`}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-3 transition-shadow",
        isDragging && "z-10 shadow-lg ring-2 ring-primary/50"
      )}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        data-testid="drag-handle"
        aria-label={`Reorder ${addon.name}`}
        className="shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary tabular">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{addon.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {addon.team}
          {overrideCount > 0 && <span className="ml-2 text-primary">· {overrideCount} overrideable</span>}
        </p>
      </div>
      <button
        type="button"
        onClick={onConfigure}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-8 shrink-0 px-2")}
        title="Configure overrideable fields"
      >
        <Settings2 className="h-4 w-4" />
      </button>
      <div className="shrink-0">
        <Combobox
          options={availableVersions.map((v) => ({ value: v, label: v }))}
          value={addon.version}
          onValueChange={(v) => v && onVersionChange(v)}
          searchPlaceholder="Search revisions…"
          emptyMessage="No revision matches."
          aria-label={`${addon.name} revision`}
          className="w-24 text-xs"
        />
      </div>
      <button
        type="button"
        data-addon-remove
        onClick={(e) => onRemove(e.currentTarget)}
        aria-label="Remove addon"
        title={`Remove ${addon.name}: back to Available`}
        className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The arrow from Available to Selected: across the lists side by side, down them stacked. */
function Direction() {
  return (
    <div aria-hidden className="flex justify-center lg:self-stretch">
      <span
        data-testid="addons-direction"
        className="flex h-8 w-8 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm lg:sticky lg:top-[12rem] lg:mt-28"
      >
        <ArrowRight className="hidden h-4 w-4 lg:block" />
        <ArrowDown className="h-4 w-4 lg:hidden" />
      </span>
    </div>
  );
}

/**
 * Part 3: the day2 charts every cluster of the flavor gets, in install
 * order, each at a revision and with the fields a cluster may override. A
 * transfer list: an add-on moves from Available (the catalog it is not
 * picked from yet) into Selected, and back when it is removed.
 */
export function AddonsSection({ addons, onChange }: { addons: SpecAddon[]; onChange: (addons: SpecAddon[]) => void }) {
  const [search, setSearch] = useState("");
  const [configuring, setConfiguring] = useState<{ team: string; name: string } | null>(null);
  const moves = useAddonMoves();

  const { data: catalog, isLoading, error } = useQuery<CatalogEntry[]>({
    queryKey: day2Keys.catalog,
    queryFn: () => api.get<CatalogEntry[]>(day2Api.catalog),
    staleTime: 120_000,
  });
  const catalogByKey = useMemo(() => new Map((catalog ?? []).map((a) => [keyOf(a), a])), [catalog]);
  const available = useMemo(() => availableAddons(catalog ?? [], addons, search), [catalog, addons, search]);

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = addons.findIndex((a) => keyOf(a) === active.id);
    const to = addons.findIndex((a) => keyOf(a) === over.id);
    onChange(arrayMove(addons, from, to));
  };

  const add = (addon: CatalogEntry, version: string, button: HTMLElement) => {
    moves.move(addon, button, "[data-addon-add]", `${addon.name} added to Selected, ${addons.length + 1} of ${addons.length + 1}.`);
    onChange([...addons, { team: addon.team, name: addon.name, version, overrideable: [] }]);
  };
  const remove = (addon: SpecAddon, button: HTMLElement) => {
    moves.move(addon, button, "[data-addon-remove]", `${addon.name} removed from Selected, back in Available.`);
    onChange(addons.filter((a) => keyOf(a) !== keyOf(addon)));
  };

  const configuringAddon = configuring ? addons.find((a) => keyOf(a) === keyOf(configuring)) : undefined;
  const configuringEntry = configuring ? catalogByKey.get(keyOf(configuring)) : undefined;
  // The chart's own values at the chosen revision (the Sig values merge on top)
  const configuringVersion = configuringAddon?.version ?? configuringEntry?.current_version ?? "HEAD";
  const { data: chartValues, isLoading: chartLoading } = useQuery<Record<string, unknown>>({
    queryKey: day2Keys.chartDefaults(configuring?.team ?? "", configuring?.name ?? "", configuringVersion),
    queryFn: () => api.get<Record<string, unknown>>(day2Api.chartDefaults(configuring!.team, configuring!.name, configuringVersion)),
    enabled: Boolean(configuring),
    staleTime: 300_000,
  });
  const defaultValues = chartValues
    ? deepMergeValues(chartValues, configuringEntry?.default_values ?? {})
    : (configuringEntry?.default_values ?? {});

  const saveOverrideable = (fields: OverrideableField[]) => {
    if (!configuring) return;
    onChange(addons.map((a) => (keyOf(a) === keyOf(configuring) ? { ...a, overrideable: fields } : a)));
    setConfiguring(null);
  };

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] lg:items-start lg:gap-5">
      <AvailableAddons available={available} error={error} search={search} onSearch={setSearch} onAdd={add} />

      <Direction />

      <div className="min-w-0 space-y-4" data-testid="addons-selected">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Selected <span className="font-normal text-muted-foreground tabular" data-testid="addons-selected-count">({addons.length})</span>
          </h3>
          {addons.length > 1 && <span className="text-xs text-muted-foreground">Drag to set the install order</span>}
        </div>
        <p role="status" className="sr-only" data-testid="addons-announcement">
          {moves.message}
        </p>
        {addons.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <Package className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" aria-hidden />
            <p className="text-sm text-muted-foreground">No addons selected</p>
            <p className="mt-1 text-xs text-muted-foreground">Add a chart to install it on every cluster of the flavor.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={addons.map(keyOf)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {addons.map((addon, index) => (
                  <SortableAddonItem
                    key={keyOf(addon)}
                    addon={addon}
                    index={index}
                    onRemove={(button) => remove(addon, button)}
                    onVersionChange={(v) => onChange(addons.map((a) => (keyOf(a) === keyOf(addon) ? { ...a, version: v } : a)))}
                    onConfigure={() => setConfiguring({ team: addon.team, name: addon.name })}
                    availableVersions={chartRevisions(catalogByKey.get(keyOf(addon)), addon.version)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {configuring && (
        <ConfigureOverrideableDialog
          key={keyOf(configuring)}
          open={true}
          onOpenChange={(open) => !open && setConfiguring(null)}
          addonName={configuring.name}
          defaultValues={defaultValues}
          isLoadingValues={chartLoading}
          currentOverrideable={configuringAddon?.overrideable ?? []}
          onSave={saveOverrideable}
        />
      )}
    </div>
  );
}
