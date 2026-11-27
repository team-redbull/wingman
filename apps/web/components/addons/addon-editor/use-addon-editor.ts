"use client";

import { useState } from "react";
import { editorBlocker, editorBody, focusedPin, initialDraft, type EditorDraft, type EditorFocus } from "./model";
import type { AddonDetail, AddonOperator, CatalogEntry } from "@/types/day2";

/**
 * Edit add-on's state, kept above the dialog: its form unmounts while the
 * plan is reviewed, and comes back as it was left.
 */
export function useAddonEditor(entry: CatalogEntry, detail: AddonDetail, op: AddonOperator | null, focus?: EditorFocus) {
  const [draft, setDraft] = useState<EditorDraft>(() => initialDraft(entry, detail, op, focus));
  // The pin the editor was opened on keeps its key, so it is found again after a review.
  const [focusKey] = useState(() => focusedPin(draft.pins, focus));
  const set = <K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  return {
    draft,
    set,
    focusKey,
    blocker: editorBlocker(entry, op, draft),
    body: () => editorBody(entry, op, draft),
  };
}
