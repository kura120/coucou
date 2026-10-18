// Which of the app's capabilities a sentence is about (doc/voice-brain.md,
// section 3.2). An embedding model on the user's own model server turns each
// capability's description and the sentence into vectors, and the nearest
// descriptions are the answer. That ranking does three jobs:
//
//   shortlist  the few tools a small local model is shown
//   instant    a clear, simple command runs with no model call at all (tier 1)
//   directed   a sentence said without the wake phrase: was it for Coucou?
//
// Numbers and vectors only. Nothing here reads a word of the sentence: it is
// embedded whole — less the names of the app's own things the registry found
// in it — and every decision below is a comparison of scores. The three names
// at the end are capabilities' names, not things said.
//
// Without an embedding model `rank` is null: there is no tier 1, and the
// model is shown areas first.
//
// Measured 2026-10-18 with nomic-embed-text on Ollama, on the app's own 64
// declarations (`scripts/voice-rank-eval.mjs --app`, 105 sentences meant for
// Coucou, 14 negations, 12 for nobody). Before: whole descriptions embedded,
// names left in — top-1 43 %, top-3 63 %, in the shortlist 77 %. Now: the
// first sentence of each description (`indexText`), the twins reworded, the
// names taken out and NAMED_BOOST — top-1 55 %, top-3 75 %, shortlist 85 %.
// The local model is the normal path; tier 1 is a small saving.
//
// `directed` is NOT used to decide alone whether a sentence said without the
// wake phrase was for Coucou: on those measurements sentences for nobody
// score 0.48 to 0.64 and sentences for Coucou 0.50 to 0.94, so no band drops
// strays without dropping real commands (ignoring every stray would ignore
// 46 % of those). The local model decides instead (voice/turn.ts). It stays
// here, measured, for when an embedding model separates them.

import type { Capability } from "../core/capabilities/types";

/** Texts in, one vector each out, in order. Null: no embedding model, or it did not answer. */
export type Embed = (texts: string[]) => Promise<number[][] | null>;

/** A capability and how near the sentence is to it: cosine, best first. */
export interface Ranked {
  name: string;
  score: number;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

/**
 * Tier 1: how far the best must be ahead of the second. Negation is where
 * embeddings fail: "don't pause the music" lands where "pause the music"
 * does. On the rank session's invented table nothing ran wrongly from 0.10
 * up; on the app's own declarations (2026-10-18, nomic-embed-text) a wrong
 * one ran at every margin up to 0.182 — "don't pause the music" paused it,
 * ahead by 0.182 — and at 0.12 nine ran rightly and two wrongly, both
 * negations. From 0.20 up none ran wrongly; one ran rightly. So tier 1 fires
 * for about one sentence in a hundred: it is a small saving, never the path
 * a command depends on, and it never runs `confirm`.
 */
export const INSTANT_MARGIN = 0.2;

/**
 * Tier 1: the least the best may score. A margin alone would let a sentence
 * that is near nothing run whatever it is least far from. PROVISIONAL, not
 * measured; cosines differ a lot from one embedding model to the next, so
 * this one above all is to be set per model.
 */
export const INSTANT_SCORE = 0.6;

/** Without the wake phrase: under this the sentence was for someone else, and nothing shows. PROVISIONAL, not measured. */
export const DIRECTED_ASK = 0.45;

/** Without the wake phrase: from this up it is acted on; between the two Coucou asks on screen. PROVISIONAL, not measured. */
export const DIRECTED_ACT = 0.6;

/**
 * How much lower both bands sit when a turn came just before: someone who
 * has just spoken to Coucou is likelier to be speaking to it still.
 * PROVISIONAL, not measured.
 */
export const FOLLOWS_TURN_EASE = 0.05;

/**
 * Under this, on average over its words, the speech model was not sure of
 * what it wrote, and the sentence drops one band: speech from across the room
 * is written down with low numbers. The same floor as `UNSURE_WORD`
 * (resolve.ts), which was set on one word, not on a sentence's average:
 * PROVISIONAL here.
 */
export const HEARD_UNSURE = 0.5;

/**
 * How much of what the previous turn adds is counted. A follow-up ("and
 * Vercel too") says little alone and is scored with its turn; but anything
 * said after "pause the music" is near the music once the two are joined, so
 * only this share of the gain is kept. PROVISIONAL, not measured.
 */
export const CONTEXT_SHARE = 0.5;

/**
 * How many capabilities a model is shown, besides those always shown. With
 * fifteen tools a 7B model picked right; with ten more, 39 of 39 became 35
 * (doc/voice.md, 7.3 and D32). Eight leaves room for the three below.
 */
export const SHORTLIST = 8;

/**
 * How much nearer a capability is counted when the sentence names a thing of
 * a kind it takes ("remove Stripe": Stripe is a pill, and remove_pills takes
 * pills). An embedding model knows nothing of most names, and a name it does
 * not know drowns the verb: "remove Stripe" ranked undo first. Measured on
 * the app's declarations (names taken out, then the boost): top-1 50 % at 0,
 * 51 % at 0.03, 53 % at 0.05, 55 % at 0.08 and at 0.10; in the shortlist 81,
 * 84, 85, 85, 85 %. The least that gives the most.
 */
export const NAMED_BOOST = 0.08;

/** The way out when the right capability was not ranked. */
const MORE_TOOLS = "more_tools";
/** The sentence asks for nothing, or was not for Coucou. */
const NOTHING = "nothing";
/** Beyond the local model: hand over to the cloud one. */
const ESCALATE = "escalate";
/** Shown to a model whatever the sentence is. */
export const ALWAYS_SHOWN: readonly string[] = [MORE_TOOLS, NOTHING, ESCALATE];

// ── Vectors ───────────────────────────────────────────────────────────────────

/** A text's fingerprint (FNV-1a, with its length): enough to see that a description changed. */
function keyOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** The vectors at length one, so that a dot product is the cosine. Null when they are not what was asked for. */
function unit(raw: number[][] | null, count: number): Float64Array[] | null {
  if (!Array.isArray(raw) || raw.length !== count || count === 0) return null;
  const width = Array.isArray(raw[0]) ? raw[0].length : 0;
  if (width === 0) return null;
  const vectors: Float64Array[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== width) return null;
    let squares = 0;
    for (const x of row) squares += x * x;
    // Also catches a NaN or a string among the numbers.
    if (!(squares > 0) || !Number.isFinite(squares)) return null;
    const length = Math.sqrt(squares);
    vectors.push(Float64Array.from(row, (x) => x / length));
  }
  return vectors;
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// ── The index ─────────────────────────────────────────────────────────────────

interface Entry {
  key: string;
  vector: Float64Array;
  /** The kinds of thing it takes as an argument. */
  kinds: readonly string[];
}

/** What a sentence names, as the app's registry found it: the kinds, and the names as they are written. */
export interface Named {
  kinds: readonly string[];
  labels: readonly string[];
}

/**
 * The sentence with the names it holds taken out, so that what is embedded is
 * what is asked: "remove Stripe" is embedded as "remove". The names are the
 * app's own (the registry found them in the sentence); nothing here knows a
 * word. When nothing is left, the sentence stays as it was.
 */
export function withoutNames(sentence: string, labels: readonly string[]): string {
  let out = ` ${sentence} `;
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const at = out.toLowerCase().indexOf(` ${label.toLowerCase()}`);
    if (at < 0) continue;
    const end = at + label.length + 1;
    // Whole words only: "Claude" is not taken out of "Claudette".
    if (/[\p{L}\p{N}]/u.test(out[end] ?? "")) continue;
    out = `${out.slice(0, at)}${out.slice(end)}`;
  }
  const left = out.replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(left) ? left : sentence.trim();
}

/** The capabilities' descriptions as vectors, kept between sentences. */
export class CapabilityIndex {
  /** In the order given to `sync`: equal scores keep it. */
  private entries = new Map<string, Entry>();
  /** Every capability given to the last `sync` has its vector. */
  private whole = false;
  /** One `sync` at a time: two at once would each embed what the other is embedding. */
  private syncing: Promise<unknown> = Promise.resolve();

  private readonly embed: Embed;

  constructor(embed: Embed) {
    this.embed = embed;
  }

  /**
   * Embeds what is new or changed; keeps the rest. Text: the capability's
   * area and description. False when the embedding model did not answer:
   * `rank` is then null until a `sync` goes through.
   */
  sync(capabilities: readonly { name: string; text: string; kinds?: readonly string[] }[]): Promise<boolean> {
    const done = this.syncing.then(() => this.syncNow(capabilities));
    this.syncing = done.catch(() => undefined);
    return done;
  }

  private async syncNow(capabilities: readonly { name: string; text: string; kinds?: readonly string[] }[]): Promise<boolean> {
    const wanted = capabilities.map((c) => ({ name: c.name, text: c.text, key: keyOf(c.text), kinds: c.kinds ?? [] }));
    const kept = new Map<string, Entry>();
    for (const w of wanted) {
      const entry = this.entries.get(w.name);
      if (entry?.key === w.key) kept.set(w.name, { ...entry, kinds: w.kinds });
    }
    let fresh = wanted.filter((w) => !kept.has(w.name));
    let vectors = fresh.length > 0 ? await this.embedded(fresh.map((w) => w.text)) : [];
    // The embedding model was changed under us: what was kept is another
    // model's, and cannot be compared with what just came back.
    const width = [...kept.values()][0]?.vector.length;
    if (vectors && vectors.length > 0 && width !== undefined && vectors[0].length !== width) {
      kept.clear();
      fresh = wanted;
      vectors = await this.embedded(fresh.map((w) => w.text));
    }
    if (!vectors) {
      // What is still right is kept, so the next try embeds only the rest.
      this.entries = kept;
      this.whole = false;
      return false;
    }
    const made = new Map(fresh.map((w, i) => [w.name, { key: w.key, vector: vectors[i], kinds: w.kinds }]));
    this.entries = new Map();
    for (const w of wanted) {
      const entry = made.get(w.name) ?? kept.get(w.name);
      if (entry) this.entries.set(w.name, entry);
    }
    this.whole = true;
    return true;
  }

  /**
   * Every capability with its score, best first. `context`: the previous
   * turn, scored with the sentence (a short follow-up says little alone).
   * One call to the embedding model. Null when there is no ranking to trust:
   * no model, no answer, an index that is not whole, an empty sentence.
   * `named`: what the registry found named in the sentence — those names are
   * not embedded, and what takes their kind is counted nearer.
   */
  async rank(sentence: string, context?: string, named?: Named): Promise<Ranked[] | null> {
    const said = named?.labels.length ? withoutNames(sentence, named.labels) : sentence.trim();
    if (!this.whole || this.entries.size === 0 || !said) return null;
    const before = context?.trim();
    const vectors = await this.embedded(before ? [said, `${before}\n${said}`] : [said]);
    if (!vectors) return null;
    const [alone, joined] = vectors;
    const width = [...this.entries.values()][0].vector.length;
    if (alone.length !== width) {
      // Another model answers now: the index is its predecessor's.
      this.entries = new Map();
      this.whole = false;
      return null;
    }
    const ranked: Ranked[] = [];
    for (const [name, entry] of this.entries) {
      let score = dot(alone, entry.vector);
      if (joined) score += CONTEXT_SHARE * Math.max(0, dot(joined, entry.vector) - score);
      if (named?.kinds.some((kind) => entry.kinds.includes(kind))) score += NAMED_BOOST;
      ranked.push({ name, score });
    }
    // Stable: equal scores stay in the order the capabilities were declared.
    return ranked.sort((a, b) => b.score - a.score);
  }

  /** Never throws: a model server that fails is one that did not answer. */
  private async embedded(texts: string[]): Promise<Float64Array[] | null> {
    try {
      return unit(await this.embed(texts), texts.length);
    } catch {
      return null;
    }
  }
}

// ── What the ranking decides ──────────────────────────────────────────────────

/**
 * Tier 1: the one capability to run with no model, or null. Only when the
 * best is near and far ahead of the second, is not `confirm` (a click is
 * never skipped), and needs nothing a model would have to write: no required
 * argument but things the executor finds in the sentence itself.
 */
export function instant(ranked: readonly Ranked[], capabilities: readonly Capability[]): string | null {
  const best = ranked[0];
  if (!best || !(best.score >= INSTANT_SCORE)) return null;
  // Alone in the ranking, it is ahead by all it scored.
  if (!(best.score - (ranked[1]?.score ?? 0) >= INSTANT_MARGIN)) return null;
  // These two speak to a model, and tier 1 has none.
  if (best.name === MORE_TOOLS || best.name === ESCALATE) return null;
  const capability = capabilities.find((c) => c.name === best.name);
  if (!capability) return null;
  const required = Object.values(capability.args).filter((arg) => !arg.optional);
  if (required.some((arg) => arg.type !== "entity" && arg.type !== "entities")) return null;
  let tier = capability.tier;
  if (typeof tier === "function") {
    // A tier that depends on the arguments is known only once they are: here
    // there are none to give it.
    if (required.length > 0) return null;
    try {
      tier = tier({});
    } catch {
      return null;
    }
  }
  return tier === "read" || tier === "free" || tier === "reversible" ? capability.name : null;
}

/**
 * A sentence said without the wake phrase: was it meant for Coucou? Low: it
 * is ignored and nothing shows. Middle: Coucou asks on screen. High: it is
 * acted on. `sure`: how sure the speech model was of each word, when it says.
 * With no ranking there is nothing to judge by, and it is ignored.
 */
export function directed(ranked: readonly Ranked[] | null, heard: { sure?: readonly number[]; followsTurn: boolean }): "ignore" | "ask" | "act" {
  const best = ranked?.[0];
  if (!best) return "ignore";
  const ease = heard.followsTurn ? FOLLOWS_TURN_EASE : 0;
  let band: "ignore" | "ask" | "act" = best.score >= DIRECTED_ACT - ease ? "act" : best.score >= DIRECTED_ASK - ease ? "ask" : "ignore";
  const sure = heard.sure ?? [];
  const doubted = sure.length > 0 && sure.reduce((sum, x) => sum + x, 0) / sure.length < HEARD_UNSURE;
  if (doubted) band = band === "act" ? "ask" : "ignore";
  // Nearest to asking for nothing: there is no question worth putting on screen.
  if (band === "ask" && best.name === NOTHING) return "ignore";
  return band;
}

/**
 * The capabilities a model is shown: the best few, then those always shown,
 * when they are declared. With no ranking, none: the caller shows areas.
 */
export function shortlist(ranked: readonly Ranked[] | null, capabilities: readonly Capability[], most: number = SHORTLIST): string[] {
  if (!ranked) return [];
  const declared = new Set(capabilities.map((c) => c.name));
  const names: string[] = [];
  for (const { name } of ranked) {
    if (names.length >= most) break;
    if (declared.has(name) && !ALWAYS_SHOWN.includes(name) && !names.includes(name)) names.push(name);
  }
  return [...names, ...ALWAYS_SHOWN.filter((name) => declared.has(name))];
}

/**
 * What a capability is embedded as: its area, and the first sentence of its
 * description — what it does. The sentences after it are for a model ("Not
 * for pausing Coucou itself", "to add, it is add_pills"); an embedding knows
 * no "not", and those words pull the vector towards the very capability they
 * point away from. Measured on the app's declarations with
 * scripts/voice-rank-eval.mjs --app (see NAMED_BOOST).
 */
export function indexText(capability: Pick<Capability, "area" | "description">): string {
  const description = capability.description.trim();
  const end = description.search(/[.!?](\s|$)/);
  return `${capability.area}: ${end < 0 ? description : description.slice(0, end + 1)}`;
}
