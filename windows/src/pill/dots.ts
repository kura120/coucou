// The Flow pill's pure parts: the dots that show the voice, and the words for
// what the pill has to say. Nothing here touches the DOM, so the tests run it
// as it is.

import { t } from "../i18n/i18n";

/** How many dots the pill draws. */
export const DOTS = 9;
/** Levels kept: the middle dot is the newest, each one out is older. */
export const HISTORY = Math.ceil(DOTS / 2);
/** A dot's smallest height, as a fraction of its largest. */
export const REST = 0.14;

/** `history` (newest first) with `level` (0…1) in front, kept to HISTORY. */
export function pushLevel(history: readonly number[], level: number): number[] {
  const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return [v, ...history].slice(0, HISTORY);
}

/** The dots' targets, left to right: the newest level in the middle, older ones out to the edges. */
export function targets(history: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < DOTS; i++) {
    const age = Math.abs(i - Math.floor(DOTS / 2));
    out.push(REST + (1 - REST) * (history[age] ?? 0));
  }
  return out;
}

/** Heights `dt` seconds on: quick to rise, slower to fall. */
export function glide(shown: readonly number[], goal: readonly number[], dt: number): number[] {
  const up = 1 - Math.exp(-dt * 30);
  const down = 1 - Math.exp(-dt * 9);
  return goal.map((g, i) => {
    const s = shown[i] ?? REST;
    return s + (g - s) * (g > s ? up : down);
  });
}

/** Whether the dots have come to rest (the page then stops drawing them). */
export function atRest(shown: readonly number[], goal: readonly number[]): boolean {
  return goal.every((g, i) => Math.abs((shown[i] ?? REST) - g) < 0.01);
}

/** What the pill says for a message code from Rust (src-tauri/src/flow/mod.rs). */
export function messageText(code: string, detail: string): string {
  switch (code) {
    case "empty":
      return t("Nothing was heard.");
    case "noengine":
      return t("Flow needs the speech engine: download it in Settings → Voice.");
    case "busy":
      return t("Still writing down the last words.");
    case "elevated":
      return t("That window runs as administrator, so Peika cannot type into it. The words are copied: press Ctrl+V.");
    case "away":
      return t("Peika could not go back to the window you were in. The words are copied: press Ctrl+V.");
    case "copied":
      return t("Windows refused the keystroke. The words are copied: press Ctrl+V.");
    default:
      return detail ? t("Flow stopped: {reason}", { reason: detail }) : t("Flow stopped.");
  }
}
