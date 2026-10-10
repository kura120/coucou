// The toast stack: which toasts are on screen, which wait their turn, when each
// one leaves, and the answer every one of them ends with. Pure — no DOM, no
// timers of its own: the page (./main.ts) asks `nextWake` when to call `tick`
// again, and the tests drive it with a clock of their own.
//
// A toast's life counts only while it is on screen and the pointer is not on
// the stack: one that waits in the queue, or sits under the pointer, never
// runs out. A decision has no time limit unless its caller gives it one.

export type ToastKind = "info" | "success" | "warning" | "error";

/** How a toast ended. A decision ends with the user's choice; everything else with "dismissed". */
export type ToastAnswer = "yes" | "no" | "dismissed";

/** Yes/No buttons. Labels are optional: the toast's own "Yes" and "No" otherwise. */
export interface ToastActions {
  yes?: string;
  no?: string;
}

/**
 * One toast, as any caller describes it — the same shape Rust sends
 * (src-tauri/src/toast.rs, `Toast`).
 */
export interface ToastSpec {
  id: string;
  kind: ToastKind;
  title: string;
  text?: string | null;
  /** A pill ID: the toast takes that pill's colour (and the user's own, if they picked one). */
  pill?: string | null;
  /** Life on screen, ms. Absent: the kind's default; a decision then never runs out. */
  durationMs?: number | null;
  /** Present: Yes and No buttons, and the decision shortcuts while it is on screen. */
  actions?: ToastActions | null;
}

export const TOAST_KINDS: readonly ToastKind[] = ["info", "success", "warning", "error"];

/** How long each kind stays when its caller doesn't say. */
export const DEFAULT_DURATION_MS: Readonly<Record<ToastKind, number>> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  error: 10000,
};

/** On screen at once; the others wait. */
export const MAX_VISIBLE = 3;
/** The slide in, and the stack making room (toast.css). */
export const ENTER_MS = 380;
/** The slide out (toast.css). A leaving toast keeps its place until then. */
export const LEAVE_MS = 260;
/** Never shorter than this, whatever the caller asks: time to read the title. */
export const MIN_DURATION_MS = 1500;

export type Phase = "queued" | "shown" | "leaving";

export interface Entry {
  spec: ToastSpec;
  phase: Phase;
  /** Life left, ms; Infinity for a toast that waits for an answer. */
  remaining: number;
  /** When its life started counting down again, or null while it doesn't. */
  runningSince: number | null;
  /** When it started leaving. */
  leftAt: number;
  answer: ToastAnswer | null;
}

export function isDecision(spec: ToastSpec): boolean {
  return spec.actions != null;
}

/** How long `spec` stays on screen, ms. Infinity: until answered. */
export function lifetime(spec: ToastSpec): number {
  const asked = spec.durationMs;
  if (asked == null || !Number.isFinite(asked) || asked <= 0) {
    return isDecision(spec) ? Infinity : DEFAULT_DURATION_MS[spec.kind] ?? DEFAULT_DURATION_MS.info;
  }
  return Math.max(MIN_DURATION_MS, asked);
}

/** A description from anywhere (another page, Rust), made safe to show. Null when it can't be. */
export function normalize(raw: unknown): ToastSpec | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  const kind = TOAST_KINDS.includes(r.kind as ToastKind) ? (r.kind as ToastKind) : "info";
  const duration = typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? r.durationMs : null;
  let actions: ToastActions | null = null;
  if (r.actions != null && typeof r.actions === "object") {
    const a = r.actions as Record<string, unknown>;
    actions = {};
    if (str(a.yes)) actions.yes = a.yes as string;
    if (str(a.no)) actions.no = a.no as string;
  }
  return { id, kind, title, text: str(r.text), pill: str(r.pill), durationMs: duration, actions };
}

export class ToastStack {
  /** Newest first: the order they are drawn in, top to bottom. */
  private entries: Entry[] = [];
  private hovered = false;

  private readonly answered: (id: string, answer: ToastAnswer) => void;

  /** `answered` hears how every toast ended, exactly once per toast. */
  constructor(answered: (id: string, answer: ToastAnswer) => void = () => {}) {
    this.answered = answered;
  }

  /**
   * Adds a toast. One with the id of a toast still on screen or waiting
   * replaces its content in place and starts its life over; the first one's
   * question, if it had one, is then settled as dismissed.
   */
  push(spec: ToastSpec, now: number) {
    // One still sliding out under that id makes way at once.
    this.entries = this.entries.filter((e) => !(e.spec.id === spec.id && e.phase === "leaving"));
    const same = this.entries.find((e) => e.spec.id === spec.id && e.phase !== "leaving");
    if (same) {
      if (same.phase === "shown" && isDecision(same.spec) && !isDecision(spec)) {
        // The question it asked is gone from the screen.
        this.answered(spec.id, "dismissed");
      }
      same.spec = spec;
      same.remaining = lifetime(spec);
      same.runningSince = same.phase === "shown" && !this.hovered ? now : null;
      return;
    }
    this.entries.unshift({
      spec, phase: "queued", remaining: lifetime(spec), runningSince: null, leftAt: 0, answer: null,
    });
    this.tick(now);
  }

  /** The pointer came onto the stack (true) or left it: every clock stops, then runs again. */
  hover(on: boolean, now: number) {
    if (on === this.hovered) return;
    this.hovered = on;
    for (const e of this.entries) {
      if (e.phase !== "shown") continue;
      if (on) this.stopClock(e, now);
      else e.runningSince = now;
    }
  }

  isHovered(): boolean {
    return this.hovered;
  }

  /** Ends a toast with `answer` (a click, or its caller taking it back). False when it was already gone. */
  answer(id: string, answer: ToastAnswer, now: number): boolean {
    const e = this.entries.find((x) => x.spec.id === id && x.phase !== "leaving");
    if (!e) return false;
    if (e.phase === "queued") {
      // Never seen: it goes without a slide.
      this.entries = this.entries.filter((x) => x !== e);
      this.answered(id, answer === "dismissed" || !isDecision(e.spec) ? "dismissed" : answer);
      this.tick(now);
      return true;
    }
    this.leave(e, isDecision(e.spec) ? answer : "dismissed", now);
    this.tick(now);
    return true;
  }

  /**
   * A decision shortcut: answers the decision nearest the top of the screen.
   * The id it answered, or null when no decision is on screen.
   */
  key(answer: "yes" | "no", now: number): string | null {
    const e = this.entries.find((x) => x.phase === "shown" && isDecision(x.spec));
    if (!e) return null;
    this.answer(e.spec.id, answer, now);
    return e.spec.id;
  }

  /** Moves time on: toasts whose life is over leave, the ones done leaving go, waiting ones come in. */
  tick(now: number) {
    for (const e of this.entries) {
      if (e.phase === "shown" && e.runningSince != null && now - e.runningSince >= e.remaining) {
        this.leave(e, "dismissed", now);
      }
    }
    this.entries = this.entries.filter((e) => !(e.phase === "leaving" && now - e.leftAt >= LEAVE_MS));
    // A toast still sliding out keeps its place until it is gone.
    let room = MAX_VISIBLE - this.entries.filter((e) => e.phase !== "queued").length;
    // Oldest waiting first: the queue is first in, first out.
    for (let i = this.entries.length - 1; i >= 0 && room > 0; i--) {
      const e = this.entries[i];
      if (e.phase !== "queued") continue;
      e.phase = "shown";
      e.runningSince = this.hovered ? null : now;
      room--;
    }
  }

  /** When `tick` next has something to do, ms from `now`; null when nothing will change by itself. */
  nextWake(now: number): number | null {
    let soonest = Infinity;
    for (const e of this.entries) {
      if (e.phase === "shown" && e.runningSince != null && Number.isFinite(e.remaining)) {
        soonest = Math.min(soonest, e.runningSince + e.remaining - now);
      } else if (e.phase === "leaving") {
        soonest = Math.min(soonest, e.leftAt + LEAVE_MS - now);
      }
    }
    return Number.isFinite(soonest) ? Math.max(0, soonest) : null;
  }

  /** What is drawn, top to bottom: the toasts on screen and those still sliding out. */
  onScreen(): readonly Entry[] {
    return this.entries.filter((e) => e.phase !== "queued");
  }

  /** How many wait for room. */
  queued(): number {
    return this.entries.filter((e) => e.phase === "queued").length;
  }

  /** True while a decision is on screen and not yet answered: the shortcuts are held only then. */
  decisionOnScreen(): boolean {
    return this.entries.some((e) => e.phase === "shown" && isDecision(e.spec));
  }

  /** Where a toast is: waiting, on screen, sliding out, or null when it is gone. */
  phaseOf(id: string): Phase | null {
    return this.entries.find((e) => e.spec.id === id)?.phase ?? null;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Life left of a toast on screen, ms (for its progress line). */
  remaining(id: string, now: number): number {
    const e = this.entries.find((x) => x.spec.id === id);
    if (!e) return 0;
    if (e.runningSince == null) return e.remaining;
    return Math.max(0, e.remaining - (now - e.runningSince));
  }

  private stopClock(e: Entry, now: number) {
    if (e.runningSince == null) return;
    e.remaining = Math.max(0, e.remaining - (now - e.runningSince));
    e.runningSince = null;
  }

  private leave(e: Entry, answer: ToastAnswer, now: number) {
    this.stopClock(e, now);
    e.phase = "leaving";
    e.leftAt = now;
    e.answer = answer;
    this.answered(e.spec.id, answer);
  }
}
