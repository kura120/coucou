// A line of text that passes through its place when it is too long for it —
// a track's title in the compact island and on the music cards. One that fits
// stays still.
//
// Passing is a CSS animation on the element (style.css `.marquee`): no timer
// and no frame loop of ours. It runs only while the element is drawn, and the
// island pauses everything inside its content while it is not open.

import { h } from "./dom";
import { marquee } from "../core/spotify";

export interface Marquee {
  el: HTMLElement;
  /** The line to show. The same line again changes nothing. */
  set(text: string): void;
  /**
   * Decides whether the line has to pass, once it can be measured. Cheap to
   * call again and again: it only measures a line it has not placed yet.
   * `room` is the width the line will have, where the element's own is not
   * the one to trust (the compact island, while it is still shrinking).
   */
  fit(room?: number): void;
}

export function createMarquee(className: string): Marquee {
  const run = h("div", { class: "marquee-run" });
  const el = h("div", { class: `marquee ${className}` }, run);
  let text = "";
  /** The room the current line was placed for; null while it is not placed. */
  let placedFor: number | null = null;
  let pending = false;

  function show() {
    el.classList.remove("scroll");
    run.replaceChildren(h("span", { text }));
    placedFor = null;
  }

  function place(room?: number) {
    const first = run.firstChild as HTMLElement | null;
    if (!first || !text) return;
    const frame = room ?? el.clientWidth;
    const width = first.offsetWidth;
    // Not laid out yet (a view that is not on screen): asked again later.
    if (!(frame > 0) || !(width > 0)) return;
    if (placedFor === frame) return;
    if (placedFor != null) show();
    placedFor = frame;
    const pass = marquee(width, frame);
    if (!pass) return;
    // A second copy follows the first, so the line never leaves a hole.
    run.append(h("span", { text, "aria-hidden": "true" }));
    run.style.setProperty("--mq-distance", `-${pass.distance}px`);
    run.style.setProperty("--mq-seconds", `${pass.seconds}s`);
    el.classList.add("scroll");
  }

  return {
    el,
    set(next) {
      if (next === text) return;
      text = next;
      show();
    },
    fit(room) {
      if (!text || pending) return;
      if (placedFor != null && (room == null || room === placedFor)) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        place(room);
      });
    },
  };
}
