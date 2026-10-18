// How sure one can be of a name as it was heard: how alike two names are, by
// letters and by sound, and how sure the speech model said it was of the
// words. The executor uses both to decide whether a name is acted on or asked
// about (core/capabilities/match.ts, registry.ts):
//
//   sure    said as it is written, or written with other letters for the same
//           sounds ("versal" is how a speech model spells Vercel)
//   unsure  a letter or two away ("strife"), or a name the speech model was
//           not sure it heard: asked about, never acted on
//
// When the speech model says how sure it was of each word (the Parakeet
// models do), a name it was not sure of is asked about unless it is spelt
// exactly: on the user's own recordings every word written wrong scored under
// 0.7, and most of the right ones above.

import { levenshtein, normalise, soundKey } from "./entity";

// ── How sure the speech model was ─────────────────────────────────────────────

/** Under this, the speech model was not sure of a word. */
export const UNSURE_WORD = 0.5;

let heard: { words: string[]; sure: number[] } | null = null;

/**
 * The sentence as it was written down and how sure the speech model was of
 * each word (0…1), as Rust reports them with the sentence. No numbers, or not
 * one for each word: nothing is known about it.
 */
export function heardWith(text: string, sure: readonly number[] | null | undefined) {
  const words = text.split(/\s+/).filter(Boolean).map(normalise);
  heard = sure && sure.length === words.length && words.length > 0 ? { words, sure: [...sure] } : null;
}

/**
 * How sure the speech model was of these words, taken from the last sentence
 * it wrote: the least sure of them. Null when nothing is known — no numbers
 * came, or the words are not in that sentence.
 */
export function sureOf(said: string): number | null {
  if (!heard) return null;
  const wanted = normalise(said).split(" ").filter(Boolean);
  if (!wanted.length) return null;
  // One written word may be two once normalised ("it's"): compared joined.
  const written = heard.words.map((w) => w.replace(/ /g, ""));
  const joined = wanted.join("");
  for (let from = 0; from < written.length; from++) {
    let text = "";
    for (let to = from; to < written.length && text.length < joined.length; to++) {
      text += written[to];
      if (text === joined) return Math.min(...heard.sure.slice(from, to + 1));
    }
  }
  return null;
}

// ── How alike two names are ───────────────────────────────────────────────────

/** By letters, three in ten may be wrong; by sound, one in four (apps.rs). */
const BY_LETTERS = 0.7;
const BY_SOUND = 0.75;
const SHORTEST_KEY = 4;

/** How alike two names are, 0…1, or 0 when they are not: apps.rs `alike`. */
export function likeness(said: string, name: string): number {
  const a = normalise(said).replace(/ /g, "");
  const b = normalise(name).replace(/ /g, "");
  if (!a || !b) return 0;
  const spelt = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  let best = spelt >= BY_LETTERS ? spelt : 0;
  const ka = soundKey(a);
  const kb = soundKey(b);
  if (Math.min(ka.length, kb.length) >= SHORTEST_KEY) {
    const sounds = 1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length);
    if (sounds >= BY_SOUND) best = Math.max(best, sounds);
  }
  return best;
}
