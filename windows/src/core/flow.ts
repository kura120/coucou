// Flow dictation's settings (src-tauri/src/settings.rs `FlowPref`) and the
// small rules for the lists the Settings page edits: what may be added, what a
// duplicate is, how many there can be. Pure, so the tests can run it as it is.

/** The keys that can be held to dictate: each a modifier on its own, so holding it does nothing in any app. */
export const FLOW_KEYS = ["RightCtrl", "RightAlt", "RightShift"] as const;
export type FlowKeyName = (typeof FLOW_KEYS)[number];

/** How a key is written in the interface: the same in every language. */
export const FLOW_KEY_LABELS: Record<FlowKeyName, string> = {
  RightCtrl: "Right Ctrl",
  RightAlt: "Right Alt",
  RightShift: "Right Shift",
};

export interface FlowPref {
  enabled: boolean;
  key: string;
  /** What is said, what is written instead. */
  replacements: [string, string][];
  dictionary: string[];
}

export const DEFAULT_FLOW: FlowPref = { enabled: false, key: "RightCtrl", replacements: [], dictionary: [] };

/** Entries a list may hold: a dictionary is not a database. */
export const MAX_ENTRIES = 200;
/** The longest a phrase or a word may be. */
export const MAX_LENGTH = 200;

/** A key name as one of ours; a name this build does not know reads as right Ctrl, as Rust does. */
export function flowKeyName(key: unknown): FlowKeyName {
  return FLOW_KEYS.find((k) => k === key) ?? "RightCtrl";
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `list` with a replacement added: both sides need text; one that says the
 * same thing as an existing entry's "you say" replaces it. Null when it
 * cannot be added (an empty side, too long, too many).
 */
export function addReplacement(list: [string, string][], from: string, to: string): [string, string][] | null {
  const f = from.trim();
  const t = to.trim();
  if (!f || !t || f.length > MAX_LENGTH || t.length > MAX_LENGTH) return null;
  const at = list.findIndex(([existing]) => same(existing, f));
  if (at >= 0) return list.map((entry, i): [string, string] => (i === at ? [f, t] : entry));
  if (list.length >= MAX_ENTRIES) return null;
  return [...list, [f, t]];
}

/** `list` with a word added; null when it is empty, too long, already there (whatever its case) or too many. */
export function addWord(list: string[], word: string): string[] | null {
  const w = word.trim();
  if (!w || w.length > MAX_LENGTH || list.length >= MAX_ENTRIES || list.some((x) => same(x, w))) return null;
  return [...list, w];
}

export function removeAt<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** What the pill window shows (src-tauri/src/flow/pill.rs `PillState`). */
export type FlowPillName = "hidden" | "listening" | "locked" | "working" | "message";

export interface FlowPillState {
  state: FlowPillName;
  /** The dictation the level events are about. */
  id: number;
  /** For "message": a code the page puts in words (pill/dots.ts `messageText`). */
  message: string;
  detail: string;
}

/** Flow's settings from whatever a settings.json or a page gave, with the defaults for what is missing. */
export function normalizeFlow(raw: unknown): FlowPref {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof FlowPref, unknown>>;
  const text = (v: unknown): v is string => typeof v === "string";
  return {
    enabled: r.enabled === true,
    key: text(r.key) ? r.key : DEFAULT_FLOW.key,
    replacements: Array.isArray(r.replacements)
      ? r.replacements.filter((p): p is [string, string] => Array.isArray(p) && text(p[0]) && text(p[1])).map(([a, b]) => [a, b])
      : [],
    dictionary: Array.isArray(r.dictionary) ? r.dictionary.filter(text) : [],
  };
}
