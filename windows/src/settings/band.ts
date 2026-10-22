// The band of mini Peikas at the top of the Peika window's pane: three tiny
// clouds that walk slowly left and right, drawn by the same BotEngine as the
// island's pills (src/peika/minibots.ts) on canvases of their own.
//
// It costs nothing when it is not seen: the requestAnimationFrame loop runs
// only while the window is shown (motion.ts says so through `setBandShown`),
// the page is visible, and the user has not asked for reduced motion — in
// which case the clouds are drawn once, standing still.

import { BotEngine, hexToRGB } from "../peika/engine";
import { pillDefinition } from "../core/pills";
import { IS_TAURI } from "../core/bridge";

/** The band's height in CSS pixels. */
export const BAND_HEIGHT = 56;
/** The width of a cloud's body; its canvas is 1/0.6 of it (see createMiniBot). */
const BODY = 30;
const CANVAS = BODY / 0.6;
/** One frame in two at 60 Hz is plenty for a cloud this size. */
const FRAME_MS = 33;
/** The pill colours of the default pills (core/pills.ts). */
const PILLS = ["agent_claude-desktop", "agent_gemini", "agent_codex"];

// ── The walk (pure) ────────────────────────────────────────────────────────────

export interface Walker {
  /** Left edge of the cloud's canvas, 0…span. */
  x: number;
  dir: 1 | -1;
  /** Pixels per second. */
  speed: number;
  /** Seconds left standing at an edge before turning back. */
  rest: number;
  /** Advances while walking: drives the little hop. */
  phase: number;
}

/** How long a cloud stands at the end of its walk, in seconds. */
export const REST_AT_EDGE = 1.6;

export function makeWalker(index: number, span: number): Walker {
  // Spread over the band, each heading its own way at its own slow pace.
  const share = (index + 0.5) / 3;
  return {
    x: Math.max(0, span) * share,
    dir: index % 2 === 0 ? 1 : -1,
    speed: 13 + index * 4,
    rest: 0,
    phase: index * 2.1,
  };
}

/** `w` after `dt` seconds on a band `span` pixels wide; it never leaves it. */
export function stepWalker(w: Walker, dt: number, span: number): Walker {
  const max = Math.max(0, span);
  const x = Math.min(max, Math.max(0, w.x));
  if (w.rest > 0) return { ...w, x, rest: Math.max(0, w.rest - dt) };
  const next = x + w.dir * w.speed * dt;
  if (next >= max) return { ...w, x: max, dir: -1, rest: REST_AT_EDGE };
  if (next <= 0) return { ...w, x: 0, dir: 1, rest: REST_AT_EDGE };
  return { ...w, x: next, phase: w.phase + dt * 7 };
}

/** The hop and the lean of a cloud mid-step, in pixels and radians. */
export function stride(w: Walker): { dy: number; lean: number } {
  if (w.rest > 0) return { dy: 0, lean: 0 };
  return { dy: -Math.abs(Math.sin(w.phase)) * 2.5, lean: Math.sin(w.phase) * 0.05 };
}

// ── The band ───────────────────────────────────────────────────────────────────

interface Cloud {
  canvas: HTMLCanvasElement;
  engine: BotEngine;
  walker: Walker;
}

let band: HTMLElement | null = null;
let clouds: Cloud[] = [];
let span = 0;
let observer: ResizeObserver | null = null;
let raf = 0;
let lastFrame = 0;
/** The window is on screen (motion.ts). Outside Tauri there is nothing to say. */
let shown = !IS_TAURI;
let listening = false;

const reducedQuery = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
const reduced = () => reducedQuery()?.matches === true;
const seen = () => shown && document.visibilityState === "visible";

/** Called when the window is shown (true) or starts to close or is hidden (false). */
export function setBandShown(on: boolean) {
  shown = on;
  sync();
}

/** Whether the loop is running; for tests and for the sake of the report. */
export const bandRunning = () => raf !== 0;

/** Starts the loop when the band is seen and may move, stops it otherwise. */
function sync() {
  const play = band !== null && seen() && !reduced();
  if (play && raf === 0) {
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  } else if (!play && raf !== 0) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  // Standing still: drawn once whenever it may have changed.
  if (!play && band !== null && seen()) paint(0);
}

function frame(time: number) {
  raf = 0;
  if (!band || !seen() || reduced()) return;
  raf = requestAnimationFrame(frame);
  if (lastFrame !== 0 && time - lastFrame < FRAME_MS) return;
  const dt = lastFrame === 0 ? 0 : Math.min(0.1, (time - lastFrame) / 1000);
  lastFrame = time;
  paint(dt);
}

function paint(dt: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const cloud of clouds) {
    cloud.walker = dt > 0 ? stepWalker(cloud.walker, dt, span) : cloud.walker;
    const { dy, lean } = reduced() ? { dy: 0, lean: 0 } : stride(cloud.walker);
    cloud.canvas.style.transform = `translate(${cloud.walker.x.toFixed(1)}px, ${dy.toFixed(2)}px) rotate(${lean.toFixed(3)}rad)`;
    const ctx = cloud.canvas.getContext("2d");
    if (!ctx) continue;
    cloud.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    cloud.engine.draw(ctx, CANVAS, CANVAS);
  }
}

function measure() {
  const wide = Math.max(0, (band?.clientWidth ?? 0) - CANVAS);
  // The first real width spreads the clouds; later ones only keep them inside.
  const first = span === 0 && wide > 0;
  span = wide;
  clouds.forEach((cloud, index) => {
    cloud.walker = first ? makeWalker(index, span) : stepWalker(cloud.walker, 0, span);
  });
  if (raf === 0 && seen()) paint(0);
}

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", sync);
  reducedQuery()?.addEventListener?.("change", sync);
}

/**
 * Builds the band, for the top of the settings pane above the heading. Called
 * again by every redraw of the window: the previous band's clouds and loop are
 * dropped first. Its width is only known once it is in the page, which the
 * resize observer waits for.
 */
export function mountBand(): HTMLElement {
  unmountBand();
  const el = document.createElement("div");
  el.id = "band";
  el.setAttribute("aria-hidden", "true");
  el.style.height = `${BAND_HEIGHT}px`;
  band = el;

  clouds = PILLS.map((id, index) => {
    const canvas = document.createElement("canvas");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(CANVAS * dpr);
    canvas.height = Math.round(CANVAS * dpr);
    canvas.style.width = `${CANVAS}px`;
    canvas.style.height = `${CANVAS}px`;
    // Centred in the band's padding box (the 1 px border is outside it).
    canvas.style.top = `${(BAND_HEIGHT - 2 - CANVAS) / 2}px`;
    el.append(canvas);
    const engine = new BotEngine();
    engine.isMini = true;
    const color = pillDefinition(id)?.color;
    if (color) engine.bodyColor = hexToRGB(color);
    engine.setState("idle", true);
    return { canvas, engine, walker: makeWalker(index, 0) };
  });

  span = 0;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(measure);
    observer.observe(el);
  }
  listen();
  sync();
  return el;
}

function unmountBand() {
  if (raf !== 0) cancelAnimationFrame(raf);
  raf = 0;
  observer?.disconnect();
  observer = null;
  band?.remove();
  band = null;
  clouds = [];
}
