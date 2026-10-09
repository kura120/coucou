// Opening and closing motion of the settings window, borrowed from the island's
// view reveal (style.css `.view.on`): the sections fade in with the island's
// slight overshoot, one after the other, and the page fades out before Rust
// hides the window. The window itself is never moved or resized — only what is
// drawn inside it. The timings live in settings.css.
//
// Like the island's own motion, it plays whatever Windows' "Animation effects"
// setting says: honouring it here only made this one window open flat.

import { Bridge, IS_TAURI, onEvent } from "../core/bridge";

/** settings.css `#settings-root.leaving`. */
const LEAVE_MS = 160;
/** Longest stagger (10 × 30 ms) plus the 300 ms reveal, with some slack. */
const ENTER_TOTAL_MS = 700;

type Phase = "hidden" | "open" | "closing";

let phase: Phase = "hidden";
/** Bumped by every transition, so a timer from an older one does nothing. */
let token = 0;

function enter(root: HTMLElement) {
  if (phase === "open") return;
  phase = "open";
  const mine = ++token;
  root.classList.remove("before", "leaving", "entering");
  // Restart the animation even if `entering` was only just removed.
  void root.offsetWidth;
  root.classList.add("entering");
  // Off once played, so a redraw (a language change) does not replay it.
  window.setTimeout(() => {
    if (token === mine) root.classList.remove("entering");
  }, ENTER_TOTAL_MS);
}

function leave(root: HTMLElement) {
  if (phase === "closing") return;
  phase = "closing";
  const mine = ++token;
  root.classList.remove("entering");
  root.classList.add("leaving");
  window.setTimeout(() => {
    // Opened again during the fade: stay.
    if (token !== mine) return;
    phase = "hidden";
    void Bridge.hideSettingsWindow();
  }, LEAVE_MS);
}

/**
 * The window is created hidden at launch, so the page starts in its "before"
 * state and waits to be shown. Rust says when (`settings-shown`); focus is the
 * safety net for a show that happened before this listener existed.
 */
export function initMotion(root: HTMLElement) {
  if (!IS_TAURI) return;
  root.classList.add("before");
  void onEvent("settings-shown", () => enter(root));
  void onEvent("settings-closing", () => leave(root));
  window.addEventListener("focus", () => {
    if (phase === "hidden") enter(root);
  });
  if (document.visibilityState === "visible" && document.hasFocus()) enter(root);
}
