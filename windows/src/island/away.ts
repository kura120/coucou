// "While you were away": what the sessions did while the user was not at the
// computer, told once on return in one card (views/away.ts).
//
// The record is built from the state changes the island already makes: a
// session that finishes, fails, or asks for the user. It keeps a pill's id,
// its name, its colour, what happened and when — nothing of what was said or
// run — and a pill has one line, its latest. It is thrown away as soon as the
// user is seen active again, whether the card was shown or not.
//
// Nothing runs while nothing happened. Rust is asked how long the keyboard
// and mouse have been idle only on a slow timer, started by the first notable
// event and stopped when the record is empty. Where the system cannot say
// (Linux) the answer is "unknown", the record is dropped and there is no card.

import { Bridge } from "../core/bridge";
import type { BotStateName, IslandViewName } from "../core/layout";
import { State, type AgentTask } from "../core/state";

/** What a line says happened. */
export type AwayKind = "finished" | "error" | "approval" | "question";

export interface AwayEvent {
  id: string;
  name: string;
  color: string;
  kind: AwayKind;
  /** Epoch milliseconds. */
  at: number;
}

/** What the card shows: how long the user was away, and what happened. */
export interface AwayReport {
  minutes: number;
  /** One line per pill, in the order the card lists them (see `rank`). */
  events: AwayEvent[];
}

/** How often Rust is asked, while something is waiting to be told. */
export const POLL_MS = 30_000;
/** A pill's latest event is kept; this bounds how many pills are. */
export const MAX_EVENTS = 20;
/**
 * Two idle readings whose last-input times differ by less than this are the
 * same stretch of idleness: the reading is in whole seconds, and the poll
 * takes a moment to be answered.
 */
export const SAME_IDLE_MS = 5_000;
/** The setting's default: minutes away before the card is shown. */
export const DEFAULT_AWAY_MINUTES = 10;

const NOTABLE: Partial<Record<BotStateName, AwayKind>> = {
  finished: "finished",
  error: "error",
  approval: "approval",
  question: "question",
};

/** What asks for the user comes first, then failures, then what simply finished. */
function rank(kind: AwayKind): number {
  return kind === "approval" || kind === "question" ? 0 : kind === "error" ? 1 : 2;
}

export class AwayRecord {
  events: AwayEvent[] = [];
  private states = new Map<string, BotStateName>();
  private primed = false;
  /** When the current stretch of idleness began (the last input), once measured. */
  private idleSince: number | null = null;

  /** Looks at the tasks after a state change; true when something notable was recorded. */
  observe(tasks: readonly AgentTask[], now: number): boolean {
    let recorded = false;
    const live = new Set<string>();
    for (const task of tasks) {
      live.add(task.id);
      const before = this.states.get(task.id);
      this.states.set(task.id, task.state);
      const kind = NOTABLE[task.state];
      // The first look only learns what is there; it is not news.
      if (!this.primed || !kind || before === task.state) continue;
      this.events = this.events.filter((e) => e.id !== task.id);
      this.events.push({ id: task.id, name: task.name, color: task.color, kind, at: now });
      if (this.events.length > MAX_EVENTS) this.events.shift();
      recorded = true;
    }
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id);
    this.primed = true;
    return recorded;
  }

  /**
   * One reading of the idle time (`idleMs`: null when the system cannot say),
   * `thresholdMs` being how long away counts. Returns the report when the user
   * has just come back from a stretch that long with something to tell.
   * Otherwise the events from before the user's last input are dropped (they
   * were seen live), and what remains waits for the next reading.
   */
  poll(idleMs: number | null, now: number, thresholdMs: number): AwayReport | null {
    if (idleMs == null || thresholdMs <= 0) {
      this.clear();
      return null;
    }
    const lastInput = now - idleMs;
    const since = this.idleSince;
    if (since != null && lastInput - since > SAME_IDLE_MS) {
      // Input since the last reading: the stretch from `since` to it is over.
      const away = lastInput - since;
      const told = this.events.filter((e) => e.at >= since && e.at <= lastInput);
      this.clear();
      if (away < thresholdMs || told.length === 0) return null;
      told.sort((a, b) => rank(a.kind) - rank(b.kind) || b.at - a.at);
      return { minutes: Math.max(1, Math.round(away / 60_000)), events: told };
    }
    const from = since ?? lastInput;
    this.events = this.events.filter((e) => e.at >= from);
    this.idleSince = this.events.length > 0 ? from : null;
    return null;
  }

  /** The user has seen it, or nothing is to be told: forgets the events, keeps the states. */
  clear() {
    this.events = [];
    this.idleSince = null;
  }
}

/** The record, and the report on the card while the card is up. */
export const Away: { record: AwayRecord; report: AwayReport | null } = {
  record: new AwayRecord(),
  report: null,
};

/** What the record needs from the island. */
export interface AwayHost {
  alert(view: IslandViewName): void;
}

/** Views the card may come up over: the ones that are not something the user is in the middle of. */
const OVER: ReadonlySet<IslandViewName> = new Set(["overview", "empty", "away"]);

/** Minutes of the setting; 0 for off. */
function thresholdMinutes(): number {
  const minutes = Number(State.settings.awayMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/**
 * The card may come up now: not paused, and not over a chat or settings. A
 * request still waiting does not stop it: the card lists it first, and its line
 * (or OK) brings the request's own card back.
 */
function canShow(): boolean {
  if (State.paused) return false;
  return State.mode !== "expanded" || OVER.has(State.view);
}

export function registerAwayHandlers(host: AwayHost, record: AwayRecord = Away.record): void {
  let timer: number | null = null;
  let onCard = false;

  const arm = () => {
    if (timer == null && record.events.length > 0) timer = window.setTimeout(() => void look(), POLL_MS);
  };

  async function look() {
    timer = null;
    const minutes = thresholdMinutes();
    const idle = minutes > 0 ? await Bridge.idleSeconds() : null;
    const report = record.poll(idle == null ? null : idle * 1000, Date.now(), minutes * 60_000);
    if (report && canShow()) {
      Away.report = report;
      host.alert("away");
    }
    arm();
  }

  State.subscribe(() => {
    // Seen: the report goes when the card is left (folded, or another view).
    const shown = State.mode === "expanded" && State.view === "away";
    if (onCard && !shown) Away.report = null;
    onCard = shown;
    // The states are followed even when the card is off, so that turning it on
    // does not take an old change for news.
    const recorded = record.observe(State.tasks, Date.now());
    if (thresholdMinutes() === 0) record.clear();
    else if (recorded) arm();
  });
}
