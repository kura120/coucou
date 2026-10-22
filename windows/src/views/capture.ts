// The screen capture card (CaptureCardView): the picture the user selected, its
// size, and what to do with it. Nothing is captured here: Rust takes the picture
// and sends it as `capture-taken` (island/capture.ts). Copy and Draw on it are
// the card's own calls; Paste, Ask and the ✕ change the island, so they go
// through the view's actions.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";
import { Bridge } from "../core/bridge";
import { washRGBA } from "../core/layout";
import { State } from "../core/state";
import { t, tl, type Msg } from "../i18n/i18n";

/** How long a fresh card ignores clicks on its buttons (views.ts CLICK_GUARD_MS). */
const CLICK_GUARD_MS = 600;
/** How long "Copied" stands in for the size. */
const COPIED_MS = 1500;

// Built the way views.ts builds its cards (card, stack, btn, the same classes).
function button(label: Msg, kind: "primary" | "secondary", onClick: () => void): HTMLElement {
  return h("button", { class: `btn ${kind}`, onclick: onClick }, h("span", { text: label }));
}

export function buildCapture(actions: ViewActions): ViewHost {
  const thumb = h("img", { class: "capture-thumb", alt: "" });
  const size = h("div", { class: "sub" });

  // The card pops up under a cursor that was busy elsewhere: clicks in the first
  // moments after a capture appears are ignored (as the permission card's are).
  let shownFor: string | null = null;
  let shownAt = 0;
  let copiedUntil = 0;

  const guarded = (fn: () => void) => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    fn();
  };

  function sync() {
    const shot = State.capture;
    const path = shot?.path ?? null;
    if (path !== shownFor) {
      shownFor = path;
      shownAt = performance.now();
      copiedUntil = 0;
    }
    if (!shot) return;
    if (thumb.getAttribute("src") !== shot.thumb) thumb.setAttribute("src", shot.thumb);
    size.textContent = performance.now() < copiedUntil ? t("Copied") : `${shot.width} × ${shot.height}`;
  }

  const copy = () => {
    const shot = State.capture;
    if (!shot) return;
    void Bridge.captureCopy(shot.path);
    copiedUntil = performance.now() + COPIED_MS;
    sync();
    // The timer's notify redraws the card once the confirmation is over, and
    // keeps the island's frame loop running until then.
    window.setTimeout(() => State.notify(), COPIED_MS);
  };

  const draw = () => {
    const shot = State.capture;
    if (shot) void Bridge.captureOpen(shot.path);
  };

  const row = h(
    "div",
    { class: "actions capture-actions" },
    button(tl("Paste"), "primary", guarded(() => actions.capturePaste())),
    button(tl("Copy"), "secondary", guarded(copy)),
    button(tl("Ask"), "secondary", guarded(() => actions.captureAsk())),
    button(tl("Draw on it"), "secondary", guarded(draw)),
  );
  const close = h(
    "button",
    { class: "icon-btn capture-close", title: tl("Close"), onclick: guarded(() => actions.captureClose()) },
    svg(ICONS.xmark, 8),
  );

  const body = h("div", { class: "stack capture-body" }, thumb, h("div", { class: "capture-side" }, size, row));
  const card = h("div", { class: "card wash" }, body, close);
  card.style.setProperty("--wash", washRGBA("soft"));

  return { el: h("div", { class: "view" }, card), sync };
}
