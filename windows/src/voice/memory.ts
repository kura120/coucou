// A short memory of the last turns, so a follow-up means something: "open
// Spotify", then "what about Steam?". It is data for a model — what was said,
// what was called for it, what came of it — given as the conversation so far
// (src-tauri/src/voice/brain.rs). What a follow-up means is the model's to
// work out: there is no rule about wording here.
//
// In memory only: never written to disk, never logged, forgotten ninety
// seconds after the last turn and when voice is turned off. Pure: no DOM, no
// Tauri, no clock of its own.

/** A capability as a model asks for it: its name, and arguments as it wrote them. */
export interface ModelCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface VoiceTurn {
  /** The sentence as it was heard. */
  said: string;
  /** The capabilities called for it; none for an answer in words. */
  calls: ModelCall[];
  /** The line the card showed. */
  result: string;
}

/** A conversation is over ninety seconds after its last turn (the Mac's). */
export const FORGOTTEN_AFTER_MS = 90_000;
/** A few exchanges, not a transcript. */
export const MOST_TURNS = 6;

export class VoiceMemory {
  private turns: VoiceTurn[] = [];
  private at = 0;

  remember(turn: VoiceTurn, now: number) {
    this.recent(now);
    this.turns.push(turn);
    if (this.turns.length > MOST_TURNS) this.turns.shift();
    this.at = now;
  }

  /** The turns still remembered, oldest first. */
  recent(now: number): readonly VoiceTurn[] {
    if (now - this.at >= FORGOTTEN_AFTER_MS) this.turns = [];
    return this.turns;
  }

  clear() {
    this.turns = [];
  }
}
