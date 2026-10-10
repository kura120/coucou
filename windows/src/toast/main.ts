// The toasts' window (toast.html): draws the stack in the top-right corner and
// animates it. What is on screen, and for how long, is ./stack.ts; this file
// turns it into cards, sounds and the window's height, and hands answers back
// to Rust (src-tauri/src/toast.rs), which gives them to whoever asked.
//
// At rest — no toast — nothing runs here: no timer, no frame, the window is
// off screen and the sound context suspended. Like every other window of the
// app, the motion plays whatever the system's animation setting says
// (src/settings/motion.ts).

import "../style.css";
import "./toast.css";

import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { pillColor } from "../core/pill-colors";
import { pillDefinition } from "../core/pills";
import { Sound, type SoundName } from "../core/sound";
import type { Settings } from "../core/state";
import { Msg, applyDocumentLanguage, resolveLanguage, setLanguage, systemLanguages, tl } from "../i18n/i18n";
import { ICONS } from "../views/icons";
import { h, svg } from "../views/dom";
import {
  ENTER_MS, ToastStack, isDecision, lifetime, normalize,
  type Entry, type ToastAnswer, type ToastKind, type ToastSpec,
} from "./stack";
import { invoke } from "@tauri-apps/api/core";

/** Between two toasts, logical pixels. */
const GAP = 8;

/** Each kind's colour when no pill gives one: the island's own (style.css :root). */
const KIND_COLOR: Record<ToastKind, string> = {
  info: "#22d3ee",
  success: "#34d399",
  warning: "#f5a524",
  error: "#f4505e",
};

/** The island's sounds: what each kind sounds like, and a question. */
const KIND_SOUND: Record<ToastKind, SoundName> = {
  info: "pop",
  success: "finish",
  warning: "peek",
  error: "error",
};
const DECISION_SOUND: SoundName = "question";

interface KeyLabels {
  yes: string;
  no: string;
}

interface ToastBoot {
  backlog: unknown[];
  keys: KeyLabels | null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

/** "#RRGGBB" → rgba() at `alpha`, for the card's wash. */
function rgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

interface Card {
  el: HTMLElement;
  spec: ToastSpec;
  /** Laid out once: from then on a move is a transition. */
  placed: boolean;
}

class ToastPage {
  private stack = new ToastStack((id, answer) => this.answered(id, answer));
  private cards = new Map<string, Card>();
  private root: HTMLElement;
  private timer: number | null = null;
  private keys: KeyLabels | null = null;
  private keysHeld = false;
  private settings: Pick<Settings, "pillColors" | "soundEnabled" | "soundVolume"> = {
    pillColors: {}, soundEnabled: true, soundVolume: 0.12,
  };
  /** The height Rust last gave the window; 0 when it is off screen. */
  private reported = 0;
  private shrinkTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.addEventListener("pointerenter", () => this.hover(true));
    root.addEventListener("pointerleave", () => this.hover(false));
  }

  async start() {
    const boot = await Bridge.boot();
    if (boot) this.applySettings(boot.settings);
    void Sound.preload().then(() => Sound.idle());

    // Listening before saying so: nothing sent in between is lost.
    await onEvent<Settings>("settings-changed", (s) => this.applySettings(s));
    await onEvent<unknown>("toast-push", (raw) => this.push(raw));
    await onEvent<string>("toast-dismiss", (id) => {
      this.stack.answer(id, "dismissed", performance.now());
      this.sync();
    });
    await onEvent<"yes" | "no">("toast-key", (answer) => {
      this.stack.key(answer, performance.now());
      this.sync();
    });
    const ready = await call<ToastBoot>("toast_ready");
    this.keys = ready?.keys ?? null;
    for (const raw of ready?.backlog ?? []) this.push(raw);
  }

  private applySettings(s: Settings) {
    this.settings = { pillColors: s.pillColors, soundEnabled: s.soundEnabled, soundVolume: s.soundVolume };
    Sound.setEnabled(s.soundEnabled);
    Sound.setVolume(s.soundVolume);
    setLanguage(resolveLanguage(s.language, systemLanguages()));
    applyDocumentLanguage();
  }

  private push(raw: unknown) {
    const spec = normalize(raw);
    if (!spec) return;
    let old = this.cards.get(spec.id);
    if (old && this.stack.phaseOf(spec.id) === "leaving") {
      // Sliding out: the new one comes in on its own.
      old.el.remove();
      this.cards.delete(spec.id);
      old = undefined;
    }
    this.stack.push(spec, performance.now());
    if (old) {
      // Same id, new content: rebuilt in place.
      const fresh = this.build(spec);
      old.el.replaceChildren(...fresh.childNodes);
      old.el.className = fresh.className;
      old.el.classList.remove("entering");
      old.el.style.cssText = old.el.style.cssText + fresh.style.cssText;
      old.spec = spec;
      this.startLife(old, performance.now());
    }
    this.sync();
  }

  private hover(on: boolean) {
    this.stack.hover(on, performance.now());
    this.root.classList.toggle("paused", on);
    this.sync();
  }

  private answered(id: string, answer: ToastAnswer) {
    void call("toast_answer", { id, answer });
  }

  /** Brings the cards, the window, the keys and the next wake-up in step with the stack. */
  private sync() {
    const now = performance.now();
    this.stack.tick(now);
    this.render(now);
    this.holdKeys(this.stack.decisionOnScreen());
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    const wait = this.stack.nextWake(now);
    if (wait != null) this.timer = window.setTimeout(() => this.sync(), wait + 4);
    if (this.stack.isEmpty()) {
      // The window goes off screen under the pointer, with no pointerleave:
      // the next toast must not start out paused.
      if (this.stack.isHovered()) this.hover(false);
      Sound.idle();
    }
  }

  private render(now: number) {
    const entries = this.stack.onScreen();
    const live = new Set(entries.map((e) => e.spec.id));
    for (const [id, card] of this.cards) {
      if (!live.has(id)) {
        card.el.remove();
        this.cards.delete(id);
      }
    }
    const fresh: Card[] = [];
    for (const e of entries) {
      let card = this.cards.get(e.spec.id);
      if (!card) {
        card = { el: this.build(e.spec), spec: e.spec, placed: false };
        this.cards.set(e.spec.id, card);
        this.root.append(card.el);
        this.startLife(card, now);
        fresh.push(card);
        Sound.play(isDecision(e.spec) ? DECISION_SOUND : KIND_SOUND[e.spec.kind]);
      }
      card.el.classList.toggle("leaving", e.phase === "leaving");
    }
    this.layout(entries);
    // Placed off to the right first, then let go: the slide in.
    if (fresh.length) {
      void this.root.offsetWidth;
      for (const card of fresh) card.el.classList.remove("entering");
    }
  }

  /** Stacks the cards top to bottom and sizes the window to them. */
  private layout(entries: readonly Entry[]) {
    let y = 0;
    for (const e of entries) {
      const card = this.cards.get(e.spec.id);
      if (!card) continue;
      card.el.style.setProperty("--y", `${y}px`);
      if (!card.placed) {
        // Its first place is where it slides in: no vertical travel.
        card.el.classList.add("no-move");
        void card.el.offsetWidth;
        card.el.classList.remove("no-move");
        card.placed = true;
      }
      y += card.el.offsetHeight + GAP;
    }
    this.resize(entries.length ? Math.ceil(y - GAP) : 0);
  }

  /**
   * Taller at once, so nothing is cut while it slides in; shorter only once
   * the cards have moved up, and off screen as soon as the last one is gone.
   */
  private resize(height: number) {
    if (this.shrinkTimer != null) window.clearTimeout(this.shrinkTimer);
    this.shrinkTimer = null;
    if (height === this.reported) return;
    if (height > this.reported || height === 0) {
      this.reported = height;
      void call("toast_layout", { height });
      return;
    }
    this.shrinkTimer = window.setTimeout(() => {
      this.shrinkTimer = null;
      this.reported = height;
      void call("toast_layout", { height });
    }, ENTER_MS);
  }

  private holdKeys(on: boolean) {
    if (on === this.keysHeld || !this.keys) return;
    this.keysHeld = on;
    void call("toast_keys", { on });
  }

  /** The thin line at the bottom that runs out with the toast's life. */
  private startLife(card: Card, now: number) {
    const line = card.el.querySelector<HTMLElement>(".toast-life");
    if (!line) return;
    const total = lifetime(card.spec);
    if (!Number.isFinite(total)) {
      line.remove();
      return;
    }
    const left = this.stack.remaining(card.spec.id, now);
    line.style.setProperty("--from", String(Math.min(1, left / total)));
    line.style.setProperty("--life", `${Math.round(left)}ms`);
    // Restarted, in case the toast was replaced.
    line.style.animation = "none";
    void line.offsetWidth;
    line.style.animation = "";
  }

  private color(spec: ToastSpec): string {
    if (spec.pill) {
      const def = pillDefinition(spec.pill);
      if (def) return pillColor(spec.pill, def.color, this.settings.pillColors);
    }
    return KIND_COLOR[spec.kind];
  }

  private build(spec: ToastSpec): HTMLElement {
    const color = this.color(spec);
    const answer = (a: ToastAnswer) => () => {
      Sound.resume();
      this.stack.answer(spec.id, a, performance.now());
      this.sync();
    };
    const button = (label: string | Msg, kind: "primary" | "secondary", a: ToastAnswer, kbd?: string) =>
      h(
        "button",
        { class: `btn ${kind}`, onclick: answer(a) },
        h("span", { text: label }),
        kbd ? h("span", { class: "kbd", text: kbd }) : null,
      );
    const actions = spec.actions
      ? h(
          "div",
          { class: "toast-actions" },
          button(spec.actions.no ?? tl("No"), "secondary", "no", this.keys?.no),
          button(spec.actions.yes ?? tl("Yes"), "primary", "yes", this.keys?.yes),
        )
      : null;
    const close = h("button", { class: "icon-btn toast-close", "aria-label": tl("Close"), onclick: answer("dismissed") });
    close.append(svg(ICONS.xmark, 9));
    const el = h(
      "div",
      { class: `toast entering kind-${spec.kind}`, role: isDecision(spec) ? "alertdialog" : "status" },
      h(
        "div",
        { class: "card wash toast-card" },
        h(
          "div",
          { class: "toast-body" },
          h("i", { class: "dot toast-dot" }),
          h(
            "div",
            { class: "toast-words" },
            h("div", { class: "toast-title", text: spec.title }),
            spec.text ? h("div", { class: "toast-text", text: spec.text }) : null,
          ),
          close,
        ),
        actions,
        h("div", { class: "toast-life" }),
      ),
    );
    el.style.setProperty("--accent", color);
    el.style.setProperty("--wash", rgba(color, 0.42));
    return el;
  }
}

const root = document.getElementById("toasts");
if (root) void new ToastPage(root).start();
