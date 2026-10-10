// What a command means. Port of VoiceIntent.swift and IntentParser.swift, the
// English half: voice is English only here for now. Deterministic — the same
// sentence gives the same intent every time, and the same one as on the Mac.
// No DOM, no Tauri, no state: text and the pill catalog in, an intent out.
//
// Two things the Mac does not have: shuffle and repeat (Spotify's, on the
// music card here), and "never mind", which the Mac's listener handles itself.

import type { PillDefinition } from "../core/pills";
import { normalise, resolvePill } from "./entity";

export type MusicTarget = "appleMusic" | "spotify";

export type VoiceIntent =
  // target null: whatever is playing
  | { kind: "musicPlay"; target: MusicTarget | null }
  | { kind: "musicPause" }
  | { kind: "musicNext" }
  | { kind: "musicPrevious" }
  | { kind: "musicPlaySearch"; name: string }
  | { kind: "musicPlayPlaylist"; name: string }
  | { kind: "musicVolumeUp" }
  | { kind: "musicVolumeDown" }
  | { kind: "musicSetVolume"; percent: number }
  // on null: the other way round from now
  | { kind: "musicShuffle"; on: boolean | null }
  | { kind: "musicRepeat"; on: boolean | null }
  | { kind: "pillAdd"; id: string }
  | { kind: "pillAddMultiple"; ids: string[] }
  | { kind: "pillRemove"; id: string }
  | { kind: "pillRemoveMultiple"; ids: string[] }
  // workspace pills only
  | { kind: "pillSetMain"; id: string }
  | { kind: "pillReplace"; old: string; new: string }
  | { kind: "pillOnly"; ids: string[] }
  | { kind: "cancel" }
  | { kind: "unknown" };

const UNKNOWN: VoiceIntent = { kind: "unknown" };

// ── Keyword tables (IntentParser's, English entries) ──────────────────────────

/** Stripped from the start, longest first. */
const POLITENESS = [["could", "you"], ["can", "you"], ["please"]];
/** The whole command, nothing else. */
const CANCEL = [["never", "mind"], ["cancel"], ["forget", "it"]];
const PAUSE = [["pause"], ["stop"]];
const NEXT = [["next", "track"], ["next", "song"], ["next"], ["skip"]];
const PREVIOUS = [["previous", "track"], ["previous", "song"], ["previous"], ["back"]];
const VOLUME_UP = [["volume", "up"], ["louder"], ["turn", "up"]];
const VOLUME_DOWN = [["volume", "down"], ["quieter"], ["turn", "down"]];
const PLAYLIST = [["play", "playlist"], ["start", "playlist"]];
/** Main pill only: no falling through to music when the name is not a pill. */
const MAIN = [["switch", "to"], ["set", "main", "to"], ["change", "to"], ["use"]];
/** A pill first, then music. */
const MUSIC_OR_PILL = [["play"], ["start"], ["resume"]];
const ADD = [["add"], ["enable"], ["show"], ["activate"]];
const REMOVE = [["remove"], ["disable"], ["hide"], ["delete"]];
const BARE_MUSIC = new Set(["play", "start", "resume"]);
const GENERIC_MUSIC = new Set(["music", "audio"]);
const MUSIC_SERVICES = new Set(["integration_music", "integration_spotify"]);
const PLAY = [["play", "music"], ["start", "music"], ["resume", "music"], ["resume"], ["play", "some", "music"]];
const REPLACE_STARTS = [["replace"], ["swap"], ["change"]];
const REPLACE_SEPARATORS = ["for", "with", "by"];
const ONLY = [["keep", "only"]];
const ARTICLES = new Set(["some", "the", "a", "an", "pill"]);
const AND = "and";
const SHUFFLE = new Set(["shuffle", "shuffling", "shuffled"]);
const REPEAT = new Set(["repeat", "repeating", "repeated"]);
/** With shuffle or repeat: it is being turned off. */
const TURN_OFF = new Set(["off", "stop", "no", "disable", "quit"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function indexOfSequence(words: readonly string[], seq: readonly string[]): number {
  if (!seq.length || seq.length > words.length) return -1;
  for (let i = 0; i <= words.length - seq.length; i++) {
    if (seq.every((w, k) => words[i + k] === w)) return i;
  }
  return -1;
}

const hasAny = (words: readonly string[], table: readonly string[][]) =>
  table.some((seq) => indexOfSequence(words, seq) >= 0);

const startsWith = (words: readonly string[], seq: readonly string[]) =>
  seq.length <= words.length && seq.every((w, i) => words[i] === w);

/** What follows the first trigger found, longest trigger first; null when nothing does. */
function after(
  words: readonly string[],
  raw: readonly string[],
  triggers: readonly string[][],
): { norm: string[]; raw: string[] } | null {
  for (const trigger of [...triggers].sort((a, b) => b.length - a.length)) {
    if (trigger.length >= words.length) continue;
    for (let i = 0; i <= words.length - trigger.length; i++) {
      if (!trigger.every((w, k) => words[i + k] === w)) continue;
      const from = i + trigger.length;
      if (from < words.length) return { norm: words.slice(from), raw: raw.slice(from) };
    }
  }
  return null;
}

/** Leading "the", "a", "some", "pill"… go; `raw` loses the same words. */
function stripArticles(norm: readonly string[], raw: readonly string[] = norm): { norm: string[]; raw: string[] } {
  let i = 0;
  while (i < norm.length && ARTICLES.has(norm[i])) i++;
  // English puts it after the name: "the github pill" (French says "la pilule GitHub").
  const end = norm.length - i > 1 && norm[norm.length - 1] === "pill" ? norm.length - 1 : norm.length;
  return { norm: norm.slice(i, end), raw: raw.slice(i, end) };
}

function splitOn(words: readonly string[], separators: ReadonlySet<string>): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  for (const w of words) {
    if (separators.has(w)) {
      if (current.length) parts.push(current);
      current = [];
    } else {
      current.push(w);
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

const AND_ONLY = new Set([AND]);

/** The pills named by "x and y", when there are at least two of them. */
function pillsIn(entity: readonly string[], pills: readonly PillDefinition[]): string[] | null {
  const parts = splitOn(entity, AND_ONLY);
  if (parts.length < 2) return null;
  const ids = parts
    .map((part) => stripArticles(part).norm.join(" "))
    .filter(Boolean)
    .map((name) => resolvePill(name, pills))
    .filter((id): id is string => id != null);
  return ids.length >= 2 ? ids : null;
}

/** The words as they were said: same splits as `normalise`, case and accents kept. */
function rawWords(s: string): string[] {
  return s.replace(/['’-]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

const isNumber = (w: string) => /^\d+$/.test(w);

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseIntent(text: string, pills: readonly PillDefinition[]): VoiceIntent {
  let words = normalise(text).split(" ").filter(Boolean);
  let raw = rawWords(text);
  // Punctuation glued to a word changes nothing; a word that vanishes when
  // normalised would shift the two lists apart, so the raw text is dropped.
  if (raw.length !== words.length) raw = [...words];
  if (!words.length) return UNKNOWN;

  for (const prefix of POLITENESS) {
    if (startsWith(words, prefix)) {
      words = words.slice(prefix.length);
      raw = raw.slice(prefix.length);
      break;
    }
  }
  if (!words.length) return UNKNOWN;

  if (CANCEL.some((seq) => seq.length === words.length && startsWith(words, seq))) return { kind: "cancel" };

  // Shuffle and repeat first: "stop repeating this" is not "stop".
  for (const [stems, kind] of [[SHUFFLE, "musicShuffle"], [REPEAT, "musicRepeat"]] as const) {
    if (!words.some((w) => stems.has(w))) continue;
    const off = words.some((w) => TURN_OFF.has(w));
    return { kind, on: off ? false : words.includes("on") ? true : null };
  }

  // 1. Music, said outright.
  if (hasAny(words, PAUSE)) return { kind: "musicPause" };
  if (hasAny(words, NEXT)) return { kind: "musicNext" };
  if (hasAny(words, PREVIOUS)) return { kind: "musicPrevious" };
  if (hasAny(words, VOLUME_UP)) return { kind: "musicVolumeUp" };
  if (hasAny(words, VOLUME_DOWN)) return { kind: "musicVolumeDown" };
  // 2. "volume 50", "set volume to 50".
  const volumeAt = words.indexOf("volume");
  const numberAt = words.reduce((last, w, i) => (isNumber(w) ? i : last), -1);
  if (volumeAt >= 0 && numberAt > volumeAt) {
    const percent = Number(words[numberAt]);
    if (percent >= 0 && percent <= 100) return { kind: "musicSetVolume", percent };
  }

  // 3. "… on Spotify".
  const onAt = words.lastIndexOf("on");
  if (onAt >= 0 && onAt + 1 < words.length) {
    const id = resolvePill(words.slice(onAt + 1).join(" "), pills);
    if (id === "integration_spotify") return { kind: "musicPlay", target: "spotify" };
    if (id === "integration_music") return { kind: "musicPlay", target: "appleMusic" };
  }

  // 5. "replace n8n with github".
  for (const start of REPLACE_STARTS) {
    const at = indexOfSequence(words, start);
    if (at < 0) continue;
    const rest = words.slice(at + start.length);
    for (const separator of REPLACE_SEPARATORS) {
      const sep = rest.indexOf(separator);
      if (sep <= 0 || sep >= rest.length - 1) continue;
      const old = resolvePill(stripArticles(rest.slice(0, sep)).norm.join(" "), pills);
      const next = resolvePill(stripArticles(rest.slice(sep + 1)).norm.join(" "), pills);
      if (old && next) return { kind: "pillReplace", old, new: next };
    }
  }

  // 6. "keep only github and vercel".
  for (const start of ONLY) {
    if (indexOfSequence(words, start) < 0) continue;
    const ids = splitOn(words.slice(start.length), AND_ONLY)
      .map((part) => stripArticles(part).norm.join(" "))
      .filter(Boolean)
      .map((name) => resolvePill(name, pills))
      .filter((id): id is string => id != null);
    if (ids.length) return { kind: "pillOnly", ids };
  }

  // 7. A playlist, before the verbs that also mean a pill.
  const playlist = after(words, raw, PLAYLIST);
  if (playlist) {
    const name = stripArticles(playlist.norm, playlist.raw);
    if (name.norm.length) return { kind: "musicPlayPlaylist", name: name.raw.join(" ") || name.norm.join(" ") };
  }

  // 8. The main pill.
  const main = after(words, raw, MAIN);
  if (main) {
    const name = stripArticles(main.norm).norm.join(" ");
    if (name) {
      const id = resolvePill(name, pills, "workspace");
      return id ? { kind: "pillSetMain", id } : UNKNOWN;
    }
  }

  // 9. "play …": a pill first, then music.
  const played = after(words, raw, MUSIC_OR_PILL);
  if (played) {
    const entity = stripArticles(played.norm, played.raw);
    const name = entity.norm.join(" ");
    if (name) {
      const several = pillsIn(entity.norm, pills);
      if (several) return { kind: "pillAddMultiple", ids: several };
      if (GENERIC_MUSIC.has(name)) return { kind: "musicPlay", target: null };
      const any = resolvePill(name, pills);
      if (any && MUSIC_SERVICES.has(any)) {
        return { kind: "musicPlay", target: any === "integration_spotify" ? "spotify" : "appleMusic" };
      }
      // "pill" said: a pill to add, even a workspace one.
      if (words.includes("pill")) return any ? { kind: "pillAdd", id: any } : UNKNOWN;
      const workspace = resolvePill(name, pills, "workspace");
      if (workspace) return { kind: "pillSetMain", id: workspace };
      if (any) return { kind: "pillAdd", id: any };
      return { kind: "musicPlaySearch", name: entity.raw.join(" ") || name };
    }
  }

  // 10, 11. Remove, add.
  for (const [triggers, one, many] of [
    [REMOVE, "pillRemove", "pillRemoveMultiple"],
    [ADD, "pillAdd", "pillAddMultiple"],
  ] as const) {
    const match = after(words, raw, triggers);
    if (!match) continue;
    const entity = stripArticles(match.norm).norm;
    if (!entity.length) continue;
    const several = pillsIn(entity, pills);
    if (several) return { kind: many, ids: several };
    const id = resolvePill(entity.join(" "), pills);
    return id ? { kind: one, id } : UNKNOWN;
  }

  // 12. Music with no name.
  if (hasAny(words, PLAY)) return { kind: "musicPlay", target: null };
  if (words.length === 1 && BARE_MUSIC.has(words[0])) return { kind: "musicPlay", target: null };

  return UNKNOWN;
}

/**
 * Two or more commands joined by "and" or "then", or null when the sentence is
 * not that (IntentParser.parseMultiAction). Any part that means nothing makes
 * it one command again: "add gemini and cursor" is one, adding two pills.
 */
export function parseSeveral(text: string, pills: readonly PillDefinition[]): VoiceIntent[] | null {
  const parts = splitOn(normalise(text).split(" ").filter(Boolean), new Set([AND, "then"]));
  if (parts.length < 2) return null;
  const intents = parts.map((part) => parseIntent(part.join(" "), pills));
  return intents.every((i) => i.kind !== "unknown") ? intents : null;
}
