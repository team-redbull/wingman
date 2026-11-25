/**
 * The day2 MRs a sync or an import opens with its day1 MR (ADR-0037's
 * 2026-11-25 amendment): day1 asks day2 once its own MR is open, and the
 * answer says what day2 opened, what was open already, what it refused or
 * did not confirm (in its words) and why it was not asked. Nothing in it is
 * retried; what did not open is for a person to install by hand.
 */

import type { AddonDrift, AddonInstalls, Day2Install, MRDetail, SyncPreview } from "@/types";

/** Nothing missing, nothing asked. */
export const NO_INSTALLS: AddonInstalls = {
  missing: [], opened: [], already_open: [], failed: [], not_asked: null, not_opened: [],
};

/** What `approvalHref` needs to address a day2 install MR (`/approvals/day2-<team>-<iid>`). */
export function day2Ref(install: Day2Install): Pick<MRDetail, "repo" | "iid" | "team"> {
  return { repo: "day2", iid: install.iid, team: install.team };
}

/**
 * A sync's answer, or, from a day1 that predates it, what the preview said:
 * then nothing was asked, and every missing add-on is left to install by hand.
 */
export function syncInstalls(addons: AddonInstalls | undefined, preview: SyncPreview): AddonInstalls {
  if (addons) return addons;
  const missing = preview.addons_to_install;
  return { ...NO_INSTALLS, missing, not_opened: missing, not_asked: preview.addons_error };
}

/** Whether there is anything about day2 to show: a missing add-on, or why it is unknown. */
export function hasDay2News(installs: AddonInstalls): boolean {
  return installs.missing.length > 0 || installs.not_asked !== null;
}

/** Day2 said it may have opened an MR it did not confirm: check before installing again. */
export function mayHaveOpened(installs: AddonInstalls): boolean {
  return installs.failed.some((line) => /may have opened/i.test(line));
}

/** The add-ons left to install by hand, while day2 still says what is missing. */
export function leftToInstall(installs: AddonInstalls): AddonDrift[] {
  return installs.missing.length > 0 ? installs.not_opened : [];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line for a list: `1 day2 MR opened · 1 already open · 1 not opened`. */
export function installsSummary(installs: AddonInstalls): string {
  if (installs.missing.length === 0) {
    return installs.not_asked ? "add-ons unknown: day2 did not say what is installed" : "no add-on missing";
  }
  if (installs.not_asked) return `${plural(installs.missing.length, "add-on")} missing, day2 not asked`;
  const parts: string[] = [];
  if (installs.opened.length > 0) parts.push(`${plural(installs.opened.length, "day2 MR")} opened`);
  if (installs.already_open.length > 0) parts.push(`${installs.already_open.length} already open`);
  if (installs.not_opened.length > 0) parts.push(`${plural(installs.not_opened.length, "add-on")} not opened`);
  return parts.join(" · ");
}
