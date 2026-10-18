// Which thing a name is, among the things of one kind. It computes: letters
// (Levenshtein), a key of how a name sounds, and how alike two names are. It
// holds no list of words, names or phrases — the names are the things' own.
//
//   sure    said as it is written, or written with other letters for the same sounds
//   unsure  near one, or as near two or three: the executor asks
//   none    nothing by that name; `near` holds what it might have been
//
// This is the one matcher: every name a capability is given goes through
// `among`. `likeness`, `soundKey` and `normalise` are imported from where they
// live (voice/resolve.ts, voice/entity.ts); the thresholds were set on speech
// models' own spellings, and the apps' are Rust's (apps.rs).

import { levenshtein, normalise, soundKey } from "../../voice/entity";
import { likeness } from "../../voice/resolve";
import type { Entity } from "./types";

export type Resolved =
  | { is: "sure"; id: string; label: string }
  // 1 to 3, best first
  | { is: "unsure"; candidates: Candidate[] }
  | { is: "none"; near: string[] };

export interface Candidate {
  id: string;
  label: string;
  hint?: string;
  score: number;
}

export interface MatchOptions {
  /** The speech model said it was not sure of these words: a name found by its sound alone is then asked about. */
  doubted?(said: string): boolean;
  /**
   * How near each thing is (0…1), when the source ranked them itself
   * (`EntitySource.near`). Without it, they are ranked here.
   */
  scores?: ReadonlyMap<string, number>;
}

/** Under this many letters, a sound key or a name is too short to tell a thing by. */
const SHORTEST_KEY = 4;
const SHORTEST_NAME = 4;
/** How much nearer the first must be than the next to be asked about alone (apps.rs `AHEAD`). */
const AHEAD = 0.15;
/** A word of what was said, against a whole name, counts for a little less than the whole of it. */
const ONE_WORD = 0.9;
/** For `near` of a name that is nothing: letters in common, with no sound key. Half of them at least. */
const LOOSELY = 0.5;

const forms = (thing: Entity) => [normalise(thing.label), ...(thing.spoken ?? []).map(normalise)].filter(Boolean);

/**
 * The things whose name is said whole in a sentence. A name that is part of
 * another one also said is left out: "claude code" is not Claude too.
 */
export function contained(said: string, things: readonly Entity[]): Entity[] {
  const q = ` ${normalise(said)} `;
  const found: { thing: Entity; form: string }[] = [];
  for (const thing of things) {
    const inside = forms(thing).filter((form) => q.includes(` ${form} `));
    if (inside.length) found.push({ thing, form: inside.reduce((a, b) => (b.length > a.length ? b : a)) });
  }
  return found
    .filter((one) => !found.some((other) => other.form !== one.form && ` ${other.form} `.includes(` ${one.form} `)))
    .map((one) => one.thing);
}

/** The longest run of words of a sentence compared with a name: names are one to three words. */
const SPAN_WORDS = 3;

/**
 * The things a sentence perhaps names: a run of its words that is a name
 * misheard, a letter or a sound away ("strife" for Stripe, "cortex" for
 * Codex, "get hub" for GitHub) — the measures `among` asks about, made
 * stricter for a sentence, where every word is a chance to sound like some
 * name: a run of several words by its letters only, and a word by its sound
 * only when it starts as the name does ("thanks" is not Settings). Nearest
 * first, with how near. Nothing is resolved here: what is said whole is `contained`'s.
 */
export function nearly(said: string, things: readonly Entity[], least: number): (Entity & { score: number })[] {
  const words = normalise(said).split(" ").filter(Boolean);
  const spans: string[] = [];
  for (let from = 0; from < words.length; from++) {
    for (let to = from + 1; to <= Math.min(words.length, from + SPAN_WORDS); to++) {
      const span = words.slice(from, to).join(" ");
      if (span.replace(/ /g, "").length >= SHORTEST_NAME) spans.push(span);
    }
  }
  return things
    .map((thing) => ({ ...thing, score: Math.max(0, ...spans.flatMap((span) => forms(thing).map((form) => heardAs(span, form)))) }))
    .filter((thing) => thing.score >= least)
    .sort((x, y) => y.score - x.score || x.label.localeCompare(y.label));
}

/** How near a run of words of a sentence is to a name, by `nearly`'s rules. */
function heardAs(span: string, form: string): number {
  if (span.includes(" ") || span[0] !== form[0]) return letters(span, form);
  return likeness(span, form);
}

/** How alike two names are by their letters alone, spaces aside, 0…1. */
function letters(a: string, b: string): number {
  const x = a.replace(/ /g, "");
  const y = b.replace(/ /g, "");
  return x && y ? 1 - levenshtein(x, y) / Math.max(x.length, y.length) : 0;
}

/** One thing among several by a name or an id. */
export function among(said: string, things: readonly Entity[], options: MatchOptions = {}): Resolved {
  const sure = (thing: Entity): Resolved => ({ is: "sure", id: thing.id, label: thing.label });
  // Its id as the app writes it: what a model that read the snapshot gives, and what an inverse holds.
  const byId = things.filter((thing) => thing.id === said.trim());
  if (byId.length === 1) return sure(byId[0]);

  const q = normalise(said);
  if (!q || !things.length) return { is: "none", near: [] };
  const exact = things.filter((thing) => forms(thing).includes(q));
  if (exact.length === 1) return sure(exact[0]);

  // A whole word of its name ("code"), or its name among other words ("the downloads folder").
  const worded = [...new Set([...things.filter((thing) => forms(thing).some((form) => form.split(" ").includes(q))), ...contained(q, things)])];
  if (worded.length === 1) return sure(worded[0]);
  if (worded.length > 1) return unsure(worded.map((thing) => ({ thing, score: ONE_WORD })));

  const words = q.split(" ").filter((word) => word.length >= SHORTEST_NAME);
  const ranked = (thing: Entity) => {
    const all = forms(thing);
    return Math.max(0, ...all.map((form) => likeness(q, form)), ...words.flatMap((word) => all.map((form) => ONE_WORD * likeness(word, form))));
  };
  const given = options.scores;
  const scored = things
    .map((thing) => ({ thing, score: given ? (given.get(thing.id) ?? 0) : ranked(thing) }))
    .filter((c) => c.score > 0)
    .sort((x, y) => y.score - x.score || x.thing.label.length - y.thing.label.length || x.thing.label.localeCompare(y.thing.label));
  // A source that ranked them itself has already judged short names.
  if (!scored.length || (!given && q.replace(/ /g, "").length < SHORTEST_NAME)) return { is: "none", near: loosely(q, things) };

  // The same sounds in other letters, and nothing else as near: that name.
  const best = scored[0];
  const key = soundKey(q);
  const same = key.length >= SHORTEST_KEY && forms(best.thing).some((form) => soundKey(form) === key);
  if (same && (scored.length === 1 || scored[1].score < best.score) && !options.doubted?.(said)) return sure(best.thing);
  return unsure(scored);
}

function unsure(scored: readonly { thing: Entity; score: number }[]): Resolved {
  const clear = scored.length === 1 || scored[0].score - scored[1].score >= AHEAD;
  const candidates = (clear ? scored.slice(0, 1) : scored.slice(0, 3)).map(({ thing, score }) => ({
    id: thing.id,
    label: thing.label,
    ...(thing.hint ? { hint: thing.hint } : {}),
    score,
  }));
  return { is: "unsure", candidates };
}

/** Up to three names that share half their letters with what was said: for "did you mean", never acted on. */
function loosely(q: string, things: readonly Entity[]): string[] {
  const a = q.replace(/ /g, "");
  return things
    .map((thing) => ({ label: thing.label, score: Math.max(0, ...forms(thing).map((form) => spelt(a, form.replace(/ /g, "")))) }))
    .filter((c) => c.score >= LOOSELY)
    .sort((x, y) => y.score - x.score || x.label.localeCompare(y.label))
    .slice(0, 3)
    .map((c) => c.label);
}

/** The share of letters two names have in the same order, 0…1 (the longest common subsequence). */
function spelt(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  if (!ac.length || !bc.length) return 0;
  let row = new Array<number>(bc.length + 1).fill(0);
  for (const ca of ac) {
    const next = [0];
    for (let j = 1; j <= bc.length; j++) next[j] = ca === bc[j - 1] ? row[j - 1] + 1 : Math.max(row[j], next[j - 1]);
    row = next;
  }
  return row[bc.length] / Math.max(ac.length, bc.length);
}
