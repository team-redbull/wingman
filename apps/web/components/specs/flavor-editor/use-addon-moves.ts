"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { addonKey } from "@/lib/addon-transfer";

interface Move {
  key: string;
  /** Where the add-on was on screen before it moved. */
  from: DOMRect | null;
  /** The button pressed, when it had the focus: the focus goes to the one that takes its place. */
  focus: { selector: string; index: number } | null;
}

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** The buttons of a list that can take the focus: not those of a collapsed team. */
const peersOf = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.checkVisibility?.() ?? true);

/**
 * The add-on slides from where it was to where it landed, so the eye
 * follows it from one list to the other; under reduced motion it fades in
 * where it lands instead (WAAPI is not slowed by the stylesheet's rule).
 */
function land(el: HTMLElement, from: DOMRect | null) {
  if (typeof el.animate !== "function") return;
  if (!from || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    return;
  }
  const to = el.getBoundingClientRect();
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(0.96)`, opacity: 0.35 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 380, easing: EASE_OUT }
  );
}

/**
 * Moving an add-on between Available and Selected, legibly: `move` is
 * called with the button pressed, before the lists change. Once they have,
 * the add-on travels from its old place into its new one, the focus stays
 * where it was in the list it left (on the button that took its place, or
 * the search when none is left), and `message` says what moved, for the
 * page's live region.
 */
export function useAddonMoves() {
  const pending = useRef<Move | null>(null);
  const [message, setMessage] = useState("");

  const move = useCallback((addon: { team: string; name: string }, button: HTMLElement, selector: string, text: string) => {
    const peers = peersOf(selector);
    pending.current = {
      key: addonKey(addon),
      from: button.closest("[data-flight]")?.getBoundingClientRect() ?? null,
      focus: document.activeElement === button ? { selector, index: peers.indexOf(button) } : null,
    };
    setMessage(text);
  }, []);

  // After every render, so the move lands in the render the lists changed in
  useLayoutEffect(() => {
    const done = pending.current;
    if (!done) return;
    pending.current = null;
    const landed = document.querySelector<HTMLElement>(`[data-flight="${CSS.escape(done.key)}"]`);
    if (landed) land(landed, done.from);
    if (done.focus) {
      const peers = peersOf(done.focus.selector);
      const next = peers[Math.min(done.focus.index, peers.length - 1)] ?? document.querySelector<HTMLElement>("[data-addon-search]");
      next?.focus({ preventScroll: true });
    }
  });

  return { move, message };
}
