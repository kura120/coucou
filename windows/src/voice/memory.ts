// A short memory of the last turns, so a follow-up means something: "open
// Spotify", then "what about Steam?". Port of ConversationContext.swift (the
// last action, "and Vercel too", "same for Stripe", "put it back") — extended
// to opening an app, and to the turns themselves, which a model is given as
// the conversation so far (src-tauri/src/voice/brain.rs).
//
// In memory only: never written to disk, never logged, forgotten ninety
// seconds after the last turn and when voice is turned off. Pure: no DOM, no
// Tauri, no clock of its own.

import type { PillDefinition } from "../core/pills";
import { normalise, resolvePill } from "./entity";
import { parseIntent, type VoiceIntent } from "./intent";
import type { BrainCall } from "./tools";

/** What a turn did, when it is something a follow-up can repeat or undo. */
export type VoiceAction =
  | { kind: "open" }
  | { kind: "add"; ids: string[] }
  | { kind: "remove"; ids: string[] }
  // `before`: the main pill it replaced
  | { kind: "main"; id: string; before: string | null }
  | { kind: "music"; intent: VoiceIntent };

export interface VoiceTurn {
  /** The sentence as it was heard. */
  said: string;
  /** What was done for it, as the tools a model knows; none for an answer in words. */
  calls: BrainCall[];
  /** The line the card showed. */
  result: string;
  action: VoiceAction | null;
}

/** The Mac's: a conversation is over ninety seconds after its last turn. */
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

  /** The last thing done that a follow-up can build on; a question in between changes nothing. */
  last(now: number): VoiceAction | null {
    const turns = this.recent(now);
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].action) return turns[i].action;
    return null;
  }

  clear() {
    this.turns = [];
  }
}

// ── A turn, from what the parser understood ───────────────────────────────────

const MUSIC_CALLS: Partial<Record<VoiceIntent["kind"], string>> = {
  musicPlay: "play", musicPause: "pause", musicNext: "next", musicPrevious: "previous",
};

/**
 * What an intent was, as the tool call a model would have made for it and as
 * the action a follow-up builds on. `opened`: the app's name, for "open".
 */
export function recordOf(
  intent: VoiceIntent,
  pills: readonly PillDefinition[],
  mainBefore: string | null = null,
  opened: string | null = null,
): { calls: BrainCall[]; action: VoiceAction | null } {
  const name = (id: string) => pills.find((p) => p.id === id)?.name ?? id;
  const call = (tool: string, args: Record<string, unknown> = {}): BrainCall[] => [{ name: tool, arguments: args }];
  switch (intent.kind) {
    case "musicPlay":
    case "musicPause":
    case "musicNext":
    case "musicPrevious":
      return { calls: call("music", { action: MUSIC_CALLS[intent.kind] }), action: { kind: "music", intent } };
    case "musicShuffle":
    case "musicRepeat": {
      const what = intent.kind === "musicShuffle" ? "shuffle" : "repeat";
      // Turned the other way round from what it was: nothing to say it as.
      if (intent.on == null) return { calls: [], action: null };
      return { calls: call("music", { action: `${what}_${intent.on ? "on" : "off"}` }), action: { kind: "music", intent } };
    }
    case "pillAdd":
      return { calls: call("add_pills", { pills: [name(intent.id)] }), action: { kind: "add", ids: [intent.id] } };
    case "pillAddMultiple":
      return { calls: call("add_pills", { pills: intent.ids.map(name) }), action: { kind: "add", ids: intent.ids } };
    case "pillRemove":
      return { calls: call("remove_pills", { pills: [name(intent.id)] }), action: { kind: "remove", ids: [intent.id] } };
    case "pillRemoveMultiple":
      return { calls: call("remove_pills", { pills: intent.ids.map(name) }), action: { kind: "remove", ids: intent.ids } };
    case "pillSetMain":
      return { calls: call("set_main_pill", { pill: name(intent.id) }), action: { kind: "main", id: intent.id, before: mainBefore } };
    case "pillReplace":
      return { calls: call("replace_pill", { remove: name(intent.old), add: name(intent.new) }), action: null };
    case "pillOnly":
      return { calls: call("keep_only_pills", { pills: intent.ids.map(name) }), action: null };
    case "open":
      return { calls: call("open_app", { name: opened ?? intent.name }), action: opened ? { kind: "open" } : null };
    default:
      return { calls: [], action: null };
  }
}

/** The action a model's checked call was, for the follow-up after it. */
export function actionOf(call: BrainCall, intent: VoiceIntent | null, pills: readonly PillDefinition[], mainBefore: string | null): VoiceAction | null {
  if (intent) return recordOf(intent, pills, mainBefore).action;
  return call.name === "open_app" || call.name === "open_folder" || call.name === "open_url" ? { kind: "open" } : null;
}

// ── A follow-up with no verb ──────────────────────────────────────────────────

/** "put it back": the last action, the other way round. */
const UNDO = ["put it back", "undo", "undo that", "undo this", "undo it", "cancel that", "bring it back", "take it back", "revert that"];

/** Words about a permission: nothing is ever carried over to them. */
const PERMISSION = /\b(allow|approve|accept|grant|authori[sz]e|permit|decline|declined|deny|denied|refuse|reject|block|permission|request)\b/;

export const aboutPermission = (said: string) => PERMISSION.test(normalise(said));

/** What a follow-up names, and whether a lead-in said it was one ("and …", "what about …"). */
function followUpName(words: readonly string[]): { name: string[]; led: boolean; also: boolean; instead: boolean } {
  // "and vercel too", "vercel as well", "discord instead".
  const last = words[words.length - 1];
  const tail = words.length < 2 ? 0 : last === "too" || last === "also" || last === "instead" ? 1 : words.slice(-2).join(" ") === "as well" ? 2 : 0;
  const body = words.slice(0, words.length - tail);
  const said = tail > 0 && last === "instead";
  for (const [lead, also] of LEAD_INS) {
    if (lead.length < body.length && lead.every((w, i) => body[i] === w)) {
      return { name: body.slice(lead.length), led: true, also, instead: said || CORRECTING.has(lead.join(" ")) };
    }
  }
  return { name: body, led: tail > 0, also: tail > 0 && !said, instead: said };
}

/** The lead-ins that say the last name was the wrong one. */
const CORRECTING = new Set(["no", "not", "no i meant", "no i said", "i meant", "i said"]);

/** "it", "that one": what was named last. Longest first. */
const PRONOUNS = ["that one", "this one", "those", "them", "that", "this", "it"];

/**
 * The sentence with its "it" or "that one" said as the pill the last action
 * was about — "take that one off" after "add GitHub" is "take github off" —
 * or null when there is no such word, or nothing it can mean. Never for a
 * sentence about a permission, where "that" is the request.
 */
export function withPronoun(said: string, last: VoiceAction | null, pills: readonly PillDefinition[]): string | null {
  const norm = normalise(said);
  if (!last || aboutPermission(said) || UNDO.includes(norm)) return null;
  const ids = last.kind === "add" || last.kind === "remove" ? last.ids : last.kind === "main" ? [last.id] : [];
  if (ids.length !== 1) return null;
  const name = pills.find((p) => p.id === ids[0])?.name;
  if (!name) return null;
  const text = ` ${norm} `;
  const pronoun = PRONOUNS.find((p) => text.includes(` ${p} `));
  if (!pronoun) return null;
  // "hide it again", "remove that one now": what trails the name is not part of it.
  return text.replace(` ${pronoun} `, ` ${normalise(name)} `).trim().replace(/( (again|now|please|too|then))+$/, "");
}

/**
 * What a follow-up starts with, longest first, and whether it adds to what
 * was done ("also …") rather than only pointing at something else ("no, …").
 */
const LEAD_INS: readonly (readonly [string[], boolean])[] = [
  [["same", "thing", "for"], true], [["same", "thing", "with"], true],
  [["no", "i", "meant"], false], [["no", "i", "said"], false],
  [["and", "also"], true], [["same", "for"], true], [["same", "with"], true],
  [["what", "about"], false], [["how", "about"], false], [["i", "meant"], false], [["i", "said"], false],
  [["and"], true], [["also"], true], [["no"], false], [["not"], false], [["now"], false], [["try"], false],
];

const NAME_FILLERS = new Set(["the", "a", "an", "my", "pill", "app", "please", "one", "that", "this"]);

/**
 * A follow-up that only makes sense after the last action, as the intent it
 * means — or null when the sentence is not one (the caller parses it as
 * usual). `last`: what was done last, if anything still remembered.
 *
 * - "and Vercel too", "also Stripe", "same for Stripe", "what about Steam?",
 *   "no, Discord", "I meant Figma": the last action again, with that name.
 * - "put it back", "undo": the last action the other way round.
 * - A bare name ("Vercel"), only when `bare` allows it: after the wake phrase,
 *   not for a sentence that was said to nobody in particular.
 *
 * - "no, Vercel", "I meant Vercel", "Vercel instead" after "add GitHub": a
 *   correction, so the two are swapped — GitHub goes, Vercel comes; after
 *   "remove GitHub", GitHub comes back and Vercel goes (`also` is the second
 *   of the two intents). After "open Spotify" it only opens the other one.
 *
 * Nothing about a permission is ever carried over, and a name is a pill for a
 * pill action, anything for "open" (it is looked up among the installed apps).
 */
export function resolveRelative(
  said: string,
  last: VoiceAction | null,
  pills: readonly PillDefinition[],
  bare = true,
): { intent: VoiceIntent; also?: VoiceIntent; led: boolean; undo: boolean } | null {
  const norm = normalise(said);
  const words = norm.split(" ").filter(Boolean);
  if (!words.length || aboutPermission(said)) return null;

  if (UNDO.includes(norm)) {
    const inverse = last ? undo(last) : null;
    return inverse ? { intent: inverse, led: true, undo: true } : null;
  }

  const { name: named, led, also, instead } = followUpName(words);
  if (!led && !bare) return null;
  const name = named.filter((w) => !NAME_FILLERS.has(w));
  if (!name.length || name.length > 4) return null;
  const text = name.join(" ");

  if (last?.kind === "open") {
    // What follows may be a command of its own: "and pause".
    if (parseIntent(text, pills).kind !== "unknown") return null;
    return { intent: { kind: "open", name: text }, led, undo: false };
  }
  const id = resolvePill(text, pills);
  if (!id) return null;
  switch (last?.kind) {
    case "add":
      // A correction of the one pill just added: that one goes, this one comes.
      if (instead && last.ids.length === 1 && last.ids[0] !== id) return { intent: { kind: "pillReplace", old: last.ids[0], new: id }, led, undo: false };
      return { intent: { kind: "pillAdd", id }, led, undo: false };
    case "remove":
      if (instead && last.ids.length === 1 && last.ids[0] !== id) {
        return { intent: { kind: "pillAdd", id: last.ids[0] }, also: { kind: "pillRemove", id }, led, undo: false };
      }
      return { intent: { kind: "pillRemove", id }, led, undo: false };
    case "main": {
      const workspace = resolvePill(text, pills, "workspace");
      return workspace ? { intent: { kind: "pillSetMain", id: workspace }, led, undo: false } : null;
    }
    case undefined:
      // Nothing before it: "also Vercel" adds it, as on the Mac. A bare name, or
      // "what about Vercel", says too little.
      return also ? { intent: { kind: "pillAdd", id }, led, undo: false } : null;
    default:
      return null;
  }
}

function undo(last: VoiceAction): VoiceIntent | null {
  switch (last.kind) {
    case "add":
      return last.ids.length === 1 ? { kind: "pillRemove", id: last.ids[0] } : { kind: "pillRemoveMultiple", ids: last.ids };
    case "remove":
      return last.ids.length === 1 ? { kind: "pillAdd", id: last.ids[0] } : { kind: "pillAddMultiple", ids: last.ids };
    case "main":
      return last.before ? { kind: "pillSetMain", id: last.before } : null;
    case "music":
      switch (last.intent.kind) {
        case "musicPause": return { kind: "musicPlay", target: null };
        case "musicPlay": return { kind: "musicPause" };
        case "musicNext": return { kind: "musicPrevious" };
        case "musicPrevious": return { kind: "musicNext" };
        case "musicShuffle": return last.intent.on == null ? null : { kind: "musicShuffle", on: !last.intent.on };
        case "musicRepeat": return last.intent.on == null ? null : { kind: "musicRepeat", on: !last.intent.on };
        default: return null;
      }
    // An app that was opened is not closed by voice.
    case "open":
      return null;
  }
}
