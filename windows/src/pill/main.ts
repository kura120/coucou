// The Flow pill's window (pill.html, src-tauri/src/flow/pill.rs): a small
// card at the bottom centre of the screen with Peika, the dots that show the
// voice, and a line for whatever needs saying. Rust says what to show with one
// event, `flow-pill` ("listening", "locked", "working", "message", "hidden");
// the level of the voice comes from the speech service's own `dictation`
// events, for the dictation the state names.
//
// At rest nothing runs here: when the pill is hidden its frame loop is
// stopped and no timer is left. Shown, it draws at 30 frames a second.
//
// The window takes no focus: the words go to the window the user is typing in,
// so a click on the ✕ or ✓ must not move the keyboard.

import "../style.css";
import "./pill.css";

import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import type { FlowPillState } from "../core/flow";
import type { Settings } from "../core/state";
import { Msg, applyDocumentLanguage, resolveLanguage, setLanguage, systemLanguages, t, tl } from "../i18n/i18n";
import { BotEngine } from "../peika/engine";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { DOTS, REST, atRest, glide, messageText, pushLevel, targets } from "./dots";

/** Peika's square, logical pixels; he is drawn at 0.8 of it, as on the desktop. */
const SIZE = 64;
const DRAW_W = SIZE * 0.8;
const SIDE = (SIZE - DRAW_W) / 2;
const FRAME_MS = 1000 / 30;
/** The card fades out (pill.css) before the loop stops. */
const FADE_MS = 280;
/** No level for this long: the voice has stopped, and the dots settle. */
const QUIET_AFTER_MS = 250;
const DECAY_EVERY_MS = 90;

interface Heard {
  id: number;
  phase: string;
  level: number;
}

class Pill {
  private engine = new BotEngine();
  private canvas = h("canvas", { class: "pill-peika" }) as HTMLCanvasElement;
  private dots: HTMLElement[] = Array.from({ length: DOTS }, () => h("i", {}));
  private caption = h("div", { class: "pill-caption" });
  private card: HTMLElement;
  private state: FlowPillState = { state: "hidden", id: 0, message: "", detail: "" };

  private history: number[] = [];
  private shown: number[] = Array(DOTS).fill(REST);
  private lastLevelAt = 0;
  private lastDecay = 0;
  private lastFrame = 0;
  private timer: number | null = null;
  private stopTimer: number | null = null;
  private running = false;
  /** Bumped when the loop stops, so a frame already asked for does not carry on. */
  private generation = 0;

  constructor(root: HTMLElement) {
    // The canvas is sized to the display in draw().
    this.engine.particleOverhang = 0;
    this.engine.setState("idle", true);

    const button = (cls: string, label: Msg, glyph: string, onClick: () => void) => {
      const b = h("button", { class: `pill-btn ${cls}`, title: label, "aria-label": label });
      b.append(svg(glyph, 12, { stroke: 2.4 }));
      // Pressed without taking the keyboard from the window being typed in.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", onClick);
      return b;
    };
    const cancel = button("cancel", tl("Cancel"), ICONS.xmark, () => void Bridge.flowPillCancel());
    const done = button("done", tl("Paste"), ICONS.check, () => void Bridge.flowPillFinish());

    this.card = h(
      "div",
      { class: "pill-card", "data-state": "hidden" },
      this.canvas,
      h("div", { class: "pill-middle" }, h("div", { class: "pill-dots" }, ...this.dots), this.caption),
      h("div", { class: "pill-actions" }, cancel, done),
    );
    root.append(this.card);
    document.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  async start() {
    // Listening before asking: nothing sent in between is lost.
    await onEvent<FlowPillState>("flow-pill", (s) => this.apply(s));
    await onEvent<Heard>("dictation", (e) => this.heard(e));
    await onEvent<Settings>("settings-changed", (s) => this.language(s.language));
    const boot = await Bridge.boot();
    if (boot) this.language(boot.settings.language);
    const now = await Bridge.flowPillState();
    if (now) this.apply(now);
  }

  private language(code: string) {
    setLanguage(resolveLanguage(code, systemLanguages()));
    applyDocumentLanguage();
    this.caption.textContent = this.captionFor(this.state);
  }

  private captionFor(s: FlowPillState): string {
    switch (s.state) {
      case "listening":
        return t("Listening…");
      case "locked":
        return t("Hands-free");
      case "working":
        return t("Writing it down…");
      case "message":
        return messageText(s.message, s.detail);
      default:
        return this.caption.textContent ?? "";
    }
  }

  apply(next: FlowPillState) {
    const before = this.state;
    this.state = next;
    this.card.dataset.state = next.state;
    if (next.state === "hidden") {
      this.card.classList.remove("on");
      this.engine.exitListening();
      // The loop runs on while the card fades, then stops for good.
      if (this.stopTimer != null) window.clearTimeout(this.stopTimer);
      this.stopTimer = window.setTimeout(() => {
        this.stopTimer = null;
        if (this.state.state === "hidden") this.stopLoop();
      }, FADE_MS);
      return;
    }
    if (this.stopTimer != null) window.clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.caption.textContent = this.captionFor(next);
    this.card.classList.add("on");
    const voice = next.state === "listening" || next.state === "locked";
    if (voice) {
      if (before.state === "hidden" || before.id !== next.id) {
        this.history = [];
        this.shown = Array(DOTS).fill(REST);
      }
      this.engine.setState("idle");
      this.engine.enterListening();
    } else {
      this.engine.exitListening();
      this.engine.setState(next.state === "working" ? "thinking" : "idle");
    }
    this.startLoop();
  }

  heard(e: Heard) {
    if (this.state.state === "hidden" || e.id !== this.state.id) return;
    if (e.phase === "level") {
      this.history = pushLevel(this.history, e.level);
      this.lastLevelAt = performance.now();
      this.startLoop();
    } else if (e.phase === "partial") {
      // Words are coming: he stops swaying and looks at who is speaking.
      this.engine.listeningHasWords = true;
    }
  }

  // ── Frames ──────────────────────────────────────────────────────────────────

  private startLoop() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.schedule(++this.generation);
  }

  private stopLoop() {
    this.running = false;
    this.generation++;
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(generation: number) {
    this.timer = window.setTimeout(() => {
      this.timer = null;
      requestAnimationFrame((now) => {
        // A loop stopped, or stopped and started again, meanwhile is not this one.
        if (generation !== this.generation) return;
        this.frame(now, generation);
      });
    }, FRAME_MS);
  }

  private frame(now: number, generation: number) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.draw(dt, now);
    if (this.running && generation === this.generation) this.schedule(generation);
  }

  private draw(dt: number, now: number) {
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      this.engine.update(dt);
      // The window is placed on whichever display the cursor is on: its scale may differ.
      const dpr = this.dpr();
      const pixels = Math.round(SIZE * dpr);
      if (this.canvas.width !== pixels) {
        this.canvas.width = pixels;
        this.canvas.height = pixels;
      }
      ctx.setTransform(dpr, 0, 0, dpr, SIDE * dpr, 0);
      ctx.clearRect(-SIDE, 0, SIZE, SIZE);
      ctx.save();
      this.engine.draw(ctx, DRAW_W, SIZE);
      ctx.restore();
    }
    // The voice has stopped: the levels run down instead of staying where they were.
    const voice = this.state.state === "listening" || this.state.state === "locked";
    if (voice && now - this.lastLevelAt > QUIET_AFTER_MS && now - this.lastDecay > DECAY_EVERY_MS) {
      this.lastDecay = now;
      if (this.history.some((v) => v > 0)) this.history = pushLevel(this.history, 0);
    }
    const goal = targets(voice ? this.history : []);
    if (!atRest(this.shown, goal)) {
      this.shown = glide(this.shown, goal, dt);
      this.dots.forEach((dot, i) => {
        dot.style.transform = `scaleY(${this.shown[i].toFixed(3)})`;
      });
    }
  }

  private dpr(): number {
    return Math.min(2, window.devicePixelRatio || 1);
  }
}

const root = document.getElementById("pill");
if (root) {
  const pill = new Pill(root);
  void pill.start();
  // In a plain browser (npm run dev, /pill.html?state=listening) there is no
  // app to say what to show: the state comes from the address, with a voice.
  if (!IS_TAURI) {
    const params = new URLSearchParams(location.search);
    const state = (params.get("state") ?? "listening") as FlowPillState["state"];
    pill.apply({ state, id: 1, message: params.get("message") ?? "", detail: params.get("detail") ?? "" });
    if (state === "listening" || state === "locked") {
      window.setInterval(() => {
        const level = (Math.sin(performance.now() / 260) * 0.5 + 0.5) * (0.4 + Math.random() * 0.6);
        pill.heard({ id: 1, phase: "level", level });
      }, 66);
    }
  }
}
