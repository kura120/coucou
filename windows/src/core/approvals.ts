// Permission requests and questions waiting for an answer, oldest first.
// Port of ApprovalQueue.swift from the macOS app: pure, no I/O, no timers.
// hooks.ts owns the relay's replies and the clock; State holds the queue, and
// its head is the request on the card (State.pendingApproval).

/** Past this many waiting at once, the newest goes back to its terminal (the Mac's bound). */
export const MAX_PENDING = 5;

/**
 * How long a request waits on the island. The relay gives up 108 s after the
 * acknowledgement, which every request gets on arrival, queued or not; after
 * that the terminal has taken over and the card would be lying.
 */
export const WAIT_MS = 110_000;

/** What the queue needs to know about a request. */
export interface Queued {
  requestId: string;
  sessionId: string;
  pillId: string;
  tool: string;
  /** `tool_input` with its keys sorted (inputKey), to match the PostToolUse that follows. */
  inputKey: string;
  /** When it arrived, in milliseconds (Date.now()). */
  received: number;
}

/** Events after which every waiting request of the same session and pill is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

/** `tool_input` serialised with sorted keys at every level, "" when absent. */
export function inputKey(input: unknown): string {
  if (input == null) return "";
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = sorted((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(input));
}

export class ApprovalQueue<T extends Queued> {
  private entries: T[] = [];

  get head(): T | null {
    return this.entries[0] ?? null;
  }

  get count(): number {
    return this.entries.length;
  }

  get all(): readonly T[] {
    return this.entries;
  }

  has(requestId: string): boolean {
    return this.entries.some((e) => e.requestId === requestId);
  }

  hasPill(pillId: string): boolean {
    return this.entries.some((e) => e.pillId === pillId);
  }

  /** False when the queue is full: the request is not taken. */
  enqueue(entry: T, max = MAX_PENDING): boolean {
    if (this.entries.length >= max) return false;
    this.entries.push(entry);
    return true;
  }

  /** Removes only this request; the others keep their order. */
  remove(requestId: string): T | null {
    const i = this.entries.findIndex((e) => e.requestId === requestId);
    return i < 0 ? null : this.entries.splice(i, 1)[0];
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * The requests a later event of the same agent makes moot. Matched per
   * request (session and pill, plus tool and input for a tool's result), never
   * by pill alone. A question's result is matched by its tool alone: its input
   * may come back with the answers in it, so the keys would differ.
   */
  resolvedBy(event: string, sessionId: string, pillId: string, tool: string, key: string): T[] {
    const ours = (e: T) => e.pillId === pillId && e.sessionId === sessionId;
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      return this.entries.filter(
        (e) => ours(e) && e.tool === tool && (e.inputKey === key || tool === "AskUserQuestion"),
      );
    }
    if (TURN_OVER.has(event)) return this.entries.filter(ours);
    return [];
  }

  /** The requests that have waited their WAIT_MS by `now`. */
  expired(now: number): T[] {
    return this.entries.filter((e) => now - e.received >= WAIT_MS);
  }

  /** When the next request runs out, or null with nothing waiting. */
  nextDeadline(): number | null {
    if (this.entries.length === 0) return null;
    return Math.min(...this.entries.map((e) => e.received)) + WAIT_MS;
  }
}
