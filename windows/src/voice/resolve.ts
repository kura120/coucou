// Naming things (doc/voice-turns.md, section 4). Whatever a sentence names —
// an app, a pill, a folder, a session, a view, a setting, a contact, a
// playlist — goes through one function, which says how sure one can be that
// the name is that thing:
//
//   sure    the tool acts
//   unsure  the tool asks: "Remove Stripe?", or a choice between two or three
//   none    nothing by that name: said at once
//
// Sure means the name was said as it is written, or written with other
// letters for the same sounds ("versal" is how a speech model spells Vercel).
// A name that is only a letter or two away may be another word altogether
// ("strife"): it is asked about. And when the speech model says how sure it
// was of each word (the Parakeet models do), a name it was not sure of is
// asked about unless it is spelt exactly: on the user's own recordings every
// word written wrong scored under 0.7, and most of the right ones above.
//
// Apps are ranked in Rust (src-tauri/src/voice/apps.rs `near`); everything
// else here, on the same idea: letters, and a key of how a name sounds.

import type { PillDefinition } from "../core/pills";
import { levenshtein, matchPill, normalise, soundKey, spokenForms, type NamedHow, type PillMatch } from "./entity";

export type NameKind = "app" | "pill" | "workspace" | "folder" | "session" | "view" | "setting" | "contact" | "playlist";

export type Resolved =
  | { is: "sure"; id: string; label: string }
  // 1 to 3, best first
  | { is: "unsure"; candidates: { id: string; label: string; score: number }[] }
  | { is: "none" };

/** Something that can be named: how it is written, and other ways it is said. */
export interface Named {
  id: string;
  label: string;
  spoken?: readonly string[];
}

/** Where the names the resolver lists itself come from: the island's, or a test's. */
export interface NameSources {
  /**
   * The installed apps a name may be: the one it is (`found`, as "open …"
   * would find it), and the nearest ones with how near each is.
   */
  apps(said: string): Promise<{ found?: string | null; names: string[]; scores?: number[]; clear: boolean }>;
  pills(): readonly PillDefinition[];
  /** The pills with a session that can be brought to the front. */
  sessions(): readonly { id: string }[];
}

let sources: NameSources | null = null;

/** Says where apps, pills and sessions are listed. Called once by whoever runs voice. */
export function provideNames(given: NameSources | null) {
  sources = given;
}

/** The user's own folders voice may open (apps.rs `folder`). */
const FOLDERS: readonly Named[] = ["Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos"].map((label) => ({
  id: label,
  label,
  spoken: [label.toLowerCase().replace(/s$/, "")],
}));

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

/** The speech model said it was not sure of these words. Unknown is not unsure. */
const doubted = (said: string) => (sureOf(said) ?? 1) < UNSURE_WORD;

// ── How alike two names are ───────────────────────────────────────────────────

/** By letters, three in ten may be wrong; by sound, one in four (apps.rs). */
const BY_LETTERS = 0.7;
const BY_SOUND = 0.75;
const SHORTEST_KEY = 4;
const SHORTEST_NAME = 4;

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

/** One thing among several by a name: as it is said, by its sound, or near it. */
function among(said: string, things: readonly Named[]): Resolved {
  const q = normalise(said);
  if (!q || !things.length) return { is: "none" };
  const forms = (thing: Named) => [normalise(thing.label), ...(thing.spoken ?? []).map(normalise)];
  const sure = (thing: Named): Resolved => ({ is: "sure", id: thing.id, label: thing.label });
  const one = (list: readonly Named[]) => (list.length === 1 ? list[0] : null);

  const exact = one(things.filter((thing) => forms(thing).includes(q)));
  if (exact) return sure(exact);
  // A whole word of its name, or its name among a few other words ("the downloads folder").
  const words = q.split(" ");
  const worded = things.filter((thing) => forms(thing).some((form) => form.split(" ").includes(q) || ` ${q} `.includes(` ${form} `)));
  if (worded.length === 1) return sure(worded[0]);

  const scored = things
    .map((thing) => ({ thing, score: Math.max(...forms(thing).map((form) => likeness(q, form)), ...words.filter((w) => w.length >= SHORTEST_NAME).map((w) => 0.9 * Math.max(...forms(thing).map((form) => likeness(w, form))))) }))
    .filter((c) => c.score > 0)
    .sort((x, y) => y.score - x.score || x.thing.label.length - y.thing.label.length || x.thing.label.localeCompare(y.thing.label));
  if (worded.length > 1) return unsure(worded.map((thing) => ({ thing, score: 0.9 })));
  if (!scored.length || q.replace(/ /g, "").length < SHORTEST_NAME) return { is: "none" };
  // The same sounds in other letters, and nothing else as near: that name.
  const best = scored[0];
  const same = forms(best.thing).some((form) => soundKey(form) === soundKey(q) && soundKey(q).length >= SHORTEST_KEY);
  if (same && (scored.length === 1 || scored[1].score < best.score) && !doubted(said)) return sure(best.thing);
  return unsure(scored);
}

/** How much nearer the first must be than the next to be asked about alone (apps.rs `AHEAD`). */
const AHEAD = 0.15;

function unsure(scored: readonly { thing: Named; score: number }[]): Resolved {
  const clear = scored.length === 1 || scored[0].score - scored[1].score >= AHEAD;
  const candidates = (clear ? scored.slice(0, 1) : scored.slice(0, 3)).map(({ thing, score }) => ({ id: thing.id, label: thing.label, score }));
  return { is: "unsure", candidates };
}

// ── Pills ─────────────────────────────────────────────────────────────────────

/**
 * Whether a pill named this way is acted on without asking: said as it is,
 * or by its sound and the speech model did not say it was unsure of the word.
 */
export function certain(match: Pick<PillMatch, "how" | "heard">): boolean {
  if (match.how === "said") return true;
  return match.how === "sound" && !doubted(match.heard);
}

const RANK: Record<NamedHow, number> = { said: 2, sound: 1, near: 0 };

/**
 * How a sentence names a pill, taking one to three of its words in a row: the
 * surest way it does, or null when it does not name it. For a pill a model
 * proposes for a sentence said freely ("get rid of strife").
 */
export function howNamed(said: string, id: string, pills: readonly PillDefinition[]): PillMatch | null {
  const words = normalise(said).split(" ").filter(Boolean);
  const found: { from: number; to: number; match: PillMatch }[] = [];
  for (let size = 1; size <= 3; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      for (const text of [words.slice(i, i + size).join(" "), words.slice(i, i + size).join("")]) {
        const match = matchPill(text, pills);
        if (match) found.push({ from: i, to: i + size, match });
      }
    }
  }
  // Words that are part of another pill's name as it is said are that pill's:
  // the "code" of "claude code" is not Codex.
  const taken = found.filter((f) => f.match.how === "said" && f.match.id !== id);
  let best: PillMatch | null = null;
  for (const { from, to, match } of found) {
    if (match.id !== id) continue;
    // Unless it is itself said outright, a run that shares a word with one is not counted.
    if (match.how !== "said" && taken.some((t) => from < t.to && t.from < to)) continue;
    if (taken.some((t) => t.from <= from && to <= t.to && t.to - t.from > to - from)) continue;
    if (!best || RANK[match.how] > RANK[best.how]) best = match;
  }
  return best;
}

function pill(said: string, pills: readonly PillDefinition[], category?: "workspace"): Resolved {
  const pool = category ? pills.filter((p) => p.category === category) : pills;
  const label = (id: string) => pool.find((p) => p.id === id)?.name ?? id;
  const match = matchPill(said, pool);
  if (match) {
    if (certain(match)) return { is: "sure", id: match.id, label: label(match.id) };
    return { is: "unsure", candidates: [{ id: match.id, label: label(match.id), score: match.how === "sound" ? 0.9 : 0.8 }] };
  }
  // Two as near as each other, which is nobody to the parser: a choice here.
  const near = among(said, pool.map((p) => ({ id: p.id, label: p.name, spoken: spokenForms(p) })));
  return near.is === "sure" ? { is: "unsure", candidates: [{ id: near.id, label: near.label, score: 0.9 }] } : near;
}

// ── The one function ──────────────────────────────────────────────────────────

/**
 * What `said` names among the things of one kind. `things` is given for the
 * kinds only the caller can list (views, settings, contacts, playlists); apps,
 * pills, folders and sessions are listed here.
 */
export async function resolveName(kind: NameKind, said: string, things?: readonly Named[]): Promise<Resolved> {
  const text = said.trim().slice(0, 80);
  if (!normalise(text)) return { is: "none" };
  switch (kind) {
    case "app": {
      if (!sources) return { is: "none" };
      const near = await sources.apps(text);
      if (near.found) {
        // Found by its letters or its sound: opened, unless the speech model
        // was unsure of a name that is not spelt as the app's.
        const spelt = normalise(text).split(" ").every((w) => normalise(near.found ?? "").split(" ").includes(w));
        if (spelt || !doubted(text)) return { is: "sure", id: near.found, label: near.found };
        return { is: "unsure", candidates: [{ id: near.found, label: near.found, score: 0.9 }] };
      }
      if (!near.names.length) return { is: "none" };
      const names = near.clear ? near.names.slice(0, 1) : near.names.slice(0, 3);
      return { is: "unsure", candidates: names.map((name, i) => ({ id: name, label: name, score: near.scores?.[i] ?? 0.8 })) };
    }
    case "pill":
      return sources ? pill(text, sources.pills()) : { is: "none" };
    case "workspace":
      return sources ? pill(text, sources.pills(), "workspace") : { is: "none" };
    case "session": {
      if (!sources) return { is: "none" };
      const running = new Set(sources.sessions().map((s) => s.id));
      return pill(text, sources.pills().filter((p) => running.has(p.id)));
    }
    case "folder":
      return among(text.replace(/\b(folder|my|the)\b/gi, " "), things ?? FOLDERS);
    default:
      return among(text, things ?? []);
  }
}
