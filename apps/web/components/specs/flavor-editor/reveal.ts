"use client";

import { useEffect, useState } from "react";
import { SECTIONS, type SectionId } from "./parts";

const SECTION_IDS = SECTIONS.map((s) => s.id);

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Scroll a field (or a part) into view and, unless `focus` is false, put
 * the cursor in its first control; a part's own toggle is passed over for
 * the first control in it. Call it a frame after opening what holds the field.
 */
export function reveal(id: string, focus = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  if (!focus) return;
  const scope = el.querySelector<HTMLElement>("[data-slot='collapsible-panel']") ?? el;
  scope.querySelector<HTMLElement>("input, textarea, [role='combobox'], button[aria-checked='true'], button")?.focus({ preventScroll: true });
}

/** The section being read: the last one whose top has passed the upper part of the view. */
export function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>("basics");
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      let current: SectionId = "basics";
      for (const id of SECTION_IDS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // The page scrolls inside the app shell's <main>: listen in the capture phase to hear it.
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return active;
}
