/**
 * The create form's values, as plain functions: what is required and left
 * empty, a path in words, the add-on overrides' nested values. Moved out of
 * the page (ADR-0056) unchanged, but for the node type (ADR-0072).
 */

import { isMirrorInput } from "@/lib/image-mirrors";
import type { OverrideableField, TemplateField } from "@/types";
import { isConfigsPath } from "./flavor-form";

/** `owner_merkaz` → `Owner Merkaz`; a nodepool's `infra_env` is its node type to the customer (ADR-0072). */
export function formatVariableName(name: string) {
  return name === "infra_env" ? "Node type" : name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Every required input left empty, at any depth (`nodepools[1].infra_env`).
 * Not a locked value (the flavor's, which the person cannot change) nor a
 * config list's or the image mirrors' entries (`flavorProblems` checks those).
 */
export function missingRequired(
  schema: TemplateField[], values: Record<string, unknown>, locked: ReadonlyMap<string, unknown>, prefix = ""
): string[] {
  const missing: string[] = [];
  for (const field of schema) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const value = values[field.name];
    if (locked.has(path) || isConfigsPath(path) || isMirrorInput(path)) continue;
    if (field.type === "list" && field.fields?.length) {
      const items = Array.isArray(value) ? value : [];
      if (field.required && items.length === 0) missing.push(path);
      items.forEach((item, i) => {
        if (item && typeof item === "object") {
          missing.push(...missingRequired(field.fields!, item as Record<string, unknown>, locked, `${path}[${i}]`));
        }
      });
    } else if (field.required && isEmptyValue(value)) {
      missing.push(path);
    }
  }
  return missing;
}

/** `nodepools[1].configs[0].name` → `Nodepool 2 › Config 1 › Name`. */
export function labelForPath(path: string): string {
  return path
    .split(".")
    .map((part) => {
      const item = /^(\w+)\[(\d+)\]$/.exec(part);
      return item
        ? `${formatVariableName(item[1]).replace(/s$/, "")} ${Number(item[2]) + 1}`
        : formatVariableName(part);
    })
    .join(" › ");
}

export function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) return { ...obj, [head]: value };
  const child = obj[head];
  const base = child && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>) : {};
  return { ...obj, [head]: setValueAtPath(base, rest.join("."), value) };
}

/** Drop the leaves a form field left blank, and the maps that leaves empty. */
export function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value === undefined) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = pruneEmpty(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Override defaults the spec declares, as nested Helm values. */
export function defaultOverrides(fields: OverrideableField[]): Record<string, unknown> {
  let values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined && field.default !== null) values = setValueAtPath(values, field.path, field.default);
  }
  return values;
}

/** The chart's clusterName for the file name of a network config: the default `ocp4-` stripped (ADR-0015). */
export function chartClusterName(name: string): string {
  return name.replace(/^ocp4-/, "");
}

export function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length !== 1 ? "s" : ""}`;
  if (value && typeof value === "object") return "configured";
  return value === "" || value === undefined || value === null ? "—" : String(value);
}
