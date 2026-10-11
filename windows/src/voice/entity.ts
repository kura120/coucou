// Words → pills. Port of EntityResolver.swift, plus how each pill is said out
// loud: a fixed grammar can only hear words it was given, and "n8n" or
// "LM Studio" are not words. Never touches a pill ID.
//
// Resolution order, as on the Mac: aliases → exact name → a whole word of the
// name → Levenshtein ≤ 2 (≤ 1 for short words), and nothing when two pills are
// equally close. Then, which the Mac does not have, what a speech model wrote
// for a name it did not know: two words for one ("co pilot"), or other letters
// for the same sound ("Kodaks" is Codex) — as apps are found (voice/apps.rs).

import type { PillCategory, PillDefinition } from "../core/pills";

/** Lowercase, no accents, no punctuation, single spaces (IntentParser.normalise). */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’-]/g, " ")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .join(" ");
}

/**
 * How a pill is said, by pill ID: the first is what the grammar is given
 * first, all of them are heard. Written as words a recogniser can pronounce.
 * A pill missing here is said as its name.
 */
export const SPOKEN: Readonly<Record<string, readonly string[]>> = {
  integration_claude: ["v s code", "claude", "claude code"],
  agent_cursor: ["cursor"],
  agent_antigravity: ["antigravity"],
  agent_codex: ["codex"],
  agent_gemini: ["gemini"],
  agent_copilot: ["copilot"],
  agent_muse: ["muse"],
  agent_opencode: ["open code"],
  agent_amp: ["amp"],
  agent_hermes: ["hermes"],
  "agent_claude-desktop": ["claude desktop"],
  ai_anthropic: ["anthropic"],
  ai_google: ["google"],
  ai_openai: ["open a i"],
  ai_ollama: ["ollama"],
  ai_lmstudio: ["l m studio"],
  integration_resend: ["resend"],
  integration_n8n: ["n eight n"],
  integration_vercel: ["vercel"],
  integration_github: ["github"],
  integration_notion: ["notion"],
  integration_calcom: ["cal", "cal dot com"],
  integration_stripe: ["stripe"],
  integration_spotify: ["spotify"],
};

/** EntityResolver.aliases: names that are not a pill's name as written. */
const MAC_ALIASES: Readonly<Record<string, string>> = {
  "claude": "integration_claude",
  "claude code": "integration_claude",
  "gemini": "agent_gemini",
  "copilot": "agent_copilot",
  "muse": "agent_muse",
  "hermes": "agent_hermes",
  "amp": "agent_amp",
  "opencode": "agent_opencode",
  "antigravity": "agent_antigravity",
  "codex": "agent_codex",
  "claude desktop": "agent_claude-desktop",
  "google": "ai_google",
  "openai": "ai_openai",
  "open ai": "ai_openai",
  "ollama": "ai_ollama",
  "lmstudio": "ai_lmstudio",
  "anthropic": "ai_anthropic",
  "github": "integration_github",
  "vercel": "integration_vercel",
  "notion": "integration_notion",
  "stripe": "integration_stripe",
  "resend": "integration_resend",
  "n8n": "integration_n8n",
  "calcom": "integration_calcom",
  "cal": "integration_calcom",
  "spotify": "integration_spotify",
  "apple music": "integration_music",
  "music": "integration_music",
  "musique": "integration_music",
};

const ALIASES: ReadonlyMap<string, string> = new Map([
  ...Object.entries(MAC_ALIASES),
  ...Object.entries(SPOKEN).flatMap(([id, said]) => said.map((s): [string, string] => [s, id])),
]);

/** The ways to say a pill, for the grammar. */
export function spokenForms(def: PillDefinition): readonly string[] {
  return SPOKEN[def.id] ?? [normalise(def.name)];
}

/**
 * The pill `query` means among `pills`, or null: nothing close enough, or two
 * pills as close as each other. `category` keeps to one kind of pill (the
 * workspace ones, for the main pill).
 */
export function resolvePill(
  query: string,
  pills: readonly PillDefinition[],
  category?: PillCategory,
): string | null {
  const q = normalise(query);
  const pool = category ? pills.filter((p) => p.category === category) : pills;
  if (!pool.length || !q) return null;

  const alias = ALIASES.get(q);
  if (alias && pool.some((p) => p.id === alias)) return alias;

  const exact = pool.find((p) => normalise(p.name) === q);
  if (exact) return exact.id;

  // "gemini" is a whole word of "gemini cli".
  const byWord = pool.filter((p) => normalise(p.name).split(" ").includes(q));
  if (byWord.length === 1) return byWord[0].id;
  if (byWord.length > 1) return null;

  let best: { id: string; dist: number } | null = null;
  let second: { id: string; dist: number } | null = null;
  for (const p of pool) {
    const dist = levenshtein(q, normalise(p.name));
    if (dist < (best?.dist ?? Infinity)) {
      second = best;
      best = { id: p.id, dist };
    } else if (dist < (second?.dist ?? Infinity)) {
      second = { id: p.id, dist };
    }
  }
  if (!best) return null;
  const tolerance = [...q].length <= 4 ? 1 : 2;
  if (best.dist > tolerance) return heardAs(q, pool);
  if (second && second.dist <= tolerance) return null;
  return best.id;
}

/**
 * How a name sounds, roughly: its consonants, those a recogniser takes for
 * one another made the same. The keys of `sound` in voice/apps.rs.
 */
export function soundKey(text: string): string {
  const letters = [...normalise(text).replace(/ /g, "").replace(/th/g, "t").replace(/ph/g, "f").replace(/ck/g, "k").replace(/qu/g, "k").replace(/x/g, "ks")];
  let out = "";
  letters.forEach((c, i) => {
    const soft = "eiy".includes(letters[i + 1] ?? " ");
    let key = c;
    if ("aeiouyhw".includes(c)) {
      // Only where a name starts with one.
      if (i > 0) return;
      key = "a";
    } else if (c === "b" || c === "p") key = "p";
    else if (c === "d" || c === "t") key = "t";
    else if (c === "c" && soft) key = "s";
    else if ("cgkq".includes(c)) key = "k";
    else if (c === "f" || c === "v") key = "f";
    else if (c === "s" || c === "z") key = "s";
    else if (c === "m" || c === "n") key = "n";
    if (!out.endsWith(key)) out += key;
  });
  return out;
}

/** Under this many letters, or consonants, a sound is too short to tell a name by. */
const SHORTEST_HEARD = 5;
const FEWEST_CONSONANTS = 4;

/**
 * The pill a speech model meant by something that is nobody's name: the only
 * one said that way once the spaces are gone ("co pilot"), else the only one
 * that sounds the same ("ver sell", "kodaks"). Short sounds are left alone:
 * "could" is not Claude.
 */
function heardAs(q: string, pool: readonly PillDefinition[]): string | null {
  const joined = q.replace(/ /g, "");
  const said = pool.map((p) => ({ id: p.id, forms: [normalise(p.name), ...spokenForms(p)].map((form) => form.replace(/ /g, "")) }));
  const only = (ids: string[]) => (ids.length === 1 ? ids[0] : null);
  if (q.includes(" ")) {
    const same = said.filter((p) => p.forms.includes(joined)).map((p) => p.id);
    if (same.length) return only(same);
  }
  const key = soundKey(joined);
  if ([...joined].length < SHORTEST_HEARD || key.replace(/^a/, "").length < FEWEST_CONSONANTS) return null;
  return only(said.filter((p) => p.forms.some((form) => soundKey(form) === key)).map((p) => p.id));
}

/** Wagner–Fischer, on characters. */
export function levenshtein(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  if (!ac.length) return bc.length;
  if (!bc.length) return ac.length;
  const row = Array.from({ length: bc.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ac.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= bc.length; j++) {
      const kept = row[j];
      row[j] = ac[i - 1] === bc[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = kept;
    }
  }
  return row[bc.length];
}
