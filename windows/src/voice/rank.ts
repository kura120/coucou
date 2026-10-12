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
// embedded whole, and every decision below is a comparison of scores. The
// three names at the end are capabilities' names, not things said.
//
// Without an embedding model `rank` is null: there is no tier 1, the
// follow-up window is off, and the model is shown areas first.
//
// THE THRESHOLDS ARE PROVISIONAL. On 2026-10-11 the model server on the
// development machine (Ollama) had seven chat models and no embedding model,
// and one may not be pulled without the user's yes. Nothing below was
// measured. `scripts/voice-rank-eval.mjs` prints where each one should sit
// for the model in use; set them from it and put its numbers here.

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
 * Tier 1: how far the best must be ahead of the second. PROVISIONAL, not
 * measured. Set wide on purpose: neighbours such as pause and resume, or add
 * and remove a pill, are described in nearly the same words and sit close
 * together, and a sentence between two of them is the model's to read.
 *
 * Negation is where embeddings fail: "don't pause" lands almost where "pause"
 * does, so no margin tells them apart by itself. What the margin can do is
 * leave room for `nothing`, whose description such a sentence is also near:
 * when it comes second and close, tier 1 stands aside. The eval script counts
 * the negations that would still run at each margin; until that count is read
 * for a real model, what protects is that tier 1 never runs `confirm`.
 */
export const INSTANT_MARGIN = 0.15;

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
  sync(capabilities: readonly { name: string; text: string }[]): Promise<boolean> {
    const done = this.syncing.then(() => this.syncNow(capabilities));
    this.syncing = done.catch(() => undefined);
    return done;
  }

  private async syncNow(capabilities: readonly { name: string; text: string }[]): Promise<boolean> {
    const wanted = capabilities.map((c) => ({ name: c.name, text: c.text, key: keyOf(c.text) }));
    const kept = new Map<string, Entry>();
    for (const w of wanted) {
      const entry = this.entries.get(w.name);
      if (entry?.key === w.key) kept.set(w.name, entry);
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
    const made = new Map(fresh.map((w, i) => [w.name, { key: w.key, vector: vectors[i] }]));
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
   */
  async rank(sentence: string, context?: string): Promise<Ranked[] | null> {
    const said = sentence.trim();
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
