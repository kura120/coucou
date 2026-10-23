// The agent sessions living behind each pill. Port of PillSessionRegistry.swift
// from the macOS app: pure, no I/O, no timers. hooks.ts owns the clock and the
// pills; State holds the registry (State.sessions).
//
// A pill is picked from the client that sent the event (VS Code, Cursor, an
// agent), never from the session. Two `claude` started in two folders under VS
// Code therefore land on the same `integration_claude`, which the island shows
// once. Without a set of sessions, the first one to end would wipe the card and
// the diffs the second one is still filling.

/**
 * A session unheard of for this long counts as gone (the Mac's interval). A
 * `SessionEnd` that never arrives (a killed terminal, a crash) would otherwise
 * pin a card to a session nobody is running any more.
 */
export const MAX_SILENCE_MS = 12 * 3600 * 1000;

/** What a pill shows while a session is the one heard last. */
export interface SessionInfo {
  session: string;
  /** Folder of the session, "" until an event carried one. */
  cwd: string;
  /** Name the card shows for it, "" until an event carried a folder. */
  project: string;
}

/** What an event says about its session. Empty strings leave what is known as it is. */
export interface SessionDetails {
  cwd?: string;
  project?: string;
}

interface Entry extends SessionInfo {
  /** When it was last heard, in milliseconds (Date.now()). */
  heard: number;
  /** Order of hearing, so two events in the same millisecond still have a last. */
  seq: number;
}

export class PillSessions {
  private pills = new Map<string, Map<string, Entry>>();
  private seq = 0;

  /** Records that this session was just heard behind this pill. */
  heard(pill: string, session: string, now: number, details: SessionDetails = {}): void {
    const sessions = this.pills.get(pill) ?? new Map<string, Entry>();
    const entry = sessions.get(session) ?? { session, cwd: "", project: "", heard: now, seq: 0 };
    if (details.cwd) {
      entry.cwd = details.cwd;
      if (details.project) entry.project = details.project;
    }
    entry.heard = now;
    entry.seq = ++this.seq;
    sessions.set(session, entry);
    this.pills.set(pill, sessions);
  }

  /**
   * A session ended. True when the pill is now empty, so its card, steps and
   * diffs may go; false while another session is still behind it. An ending
   * session nobody has heard (Peika started in the middle of it) takes nothing
   * from the others.
   */
  ended(pill: string, session: string): boolean {
    const sessions = this.pills.get(pill);
    if (!sessions) return true;
    sessions.delete(session);
    if (sessions.size > 0) return false;
    this.pills.delete(pill);
    return true;
  }

  /**
   * Drops the sessions silent for MAX_SILENCE_MS. `emptied` are the pills left
   * with none (to clear as if their last session had ended); `touched` are the
   * pills that lost one and still have another. (Diffs need no word here:
   * the state forgets them an hour after the last one.)
   */
  stale(now: number): { emptied: string[]; touched: string[] } {
    const emptied: string[] = [];
    const touched: string[] = [];
    for (const [pill, sessions] of [...this.pills]) {
      let lost = false;
      for (const [id, entry] of [...sessions]) {
        if (now - entry.heard >= MAX_SILENCE_MS) {
          sessions.delete(id);
          lost = true;
        }
      }
      if (sessions.size === 0) {
        this.pills.delete(pill);
        emptied.push(pill);
      } else if (lost) {
        touched.push(pill);
      }
    }
    return { emptied, touched };
  }

  /** The session heard last behind this pill: the one its card follows. */
  latest(pill: string): SessionInfo | null {
    let last: Entry | null = null;
    for (const entry of this.pills.get(pill)?.values() ?? []) {
      if (!last || entry.seq > last.seq) last = entry;
    }
    return last ? { session: last.session, cwd: last.cwd, project: last.project } : null;
  }

  has(pill: string, session: string): boolean {
    return this.pills.get(pill)?.has(session) ?? false;
  }

  count(pill: string): number {
    return this.pills.get(pill)?.size ?? 0;
  }

  /** Some pill has a session: the only time anything needs to be watched. */
  get active(): boolean {
    return this.pills.size > 0;
  }

  /** When the first silent session turns stale (Date.now() scale), null with none. */
  nextDeadline(): number | null {
    let first: number | null = null;
    for (const sessions of this.pills.values()) {
      for (const entry of sessions.values()) {
        if (first == null || entry.heard < first) first = entry.heard;
      }
    }
    return first == null ? null : first + MAX_SILENCE_MS;
  }

  clear(): void {
    this.pills.clear();
  }
}
