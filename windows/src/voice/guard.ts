// What voice may change, and how carefully. One table: a setting that is not
// in it cannot be changed by voice at all, and each one that is has a tier —
//
//   reversible  done at once; said the other way round, it is back
//   guarded     a toast shows the exact change and only a click makes it
//   never       not by voice: there is no path to it from here
//
// — and the values it may take, the same ones Settings offers. Nothing here
// changes anything: tools-app.ts asks `plan` what a change would be, and does
// or confirms it accordingly.
//
// The reasons for "never" are the app's rules (CLAUDE.md), not caution alone:
// installing hooks writes ~/.claude/settings.json; addresses, keys and folders
// are not things to dictate; the phone link is Rust's to switch; and nothing
// that loosens what an agent may do is ever a sentence away.

import { LANGUAGES } from "../i18n/i18n";
import { normalise } from "./entity";

export type Tier = "free" | "reversible" | "guarded" | "never";

export type Rule = {
  /** The path in the settings: "soundEnabled", "voice.followUp". */
  key: string;
  tier: Exclude<Tier, "free">;
  /** What it is called out loud, the usual name first. */
  names: string[];
} & (
  | { kind: "switch" }
  /** `said`: how a value is given in speech ("percent": 0…100 for 0…max). */
  | { kind: "number"; min: number; max: number; step?: number; said?: "percent" }
  | { kind: "choice"; options: readonly { value: string; names: string[] }[] }
);

const choice = (value: string, ...names: string[]) => ({ value, names: names.length ? names : [value] });

/** Every setting voice knows of. One that is not here is refused. */
export const RULES: readonly Rule[] = [
  // ── Done at once ──
  { key: "soundEnabled", tier: "reversible", kind: "switch", names: ["sound", "sounds", "sound effects"] },
  { key: "soundVolume", tier: "reversible", kind: "number", min: 0, max: 0.2, said: "percent", names: ["sound volume", "volume of the sounds", "mochi's volume"] },
  { key: "openOnHover", tier: "reversible", kind: "switch", names: ["open on hover", "hover to open"] },
  { key: "autoCloseInterval", tier: "reversible", kind: "number", min: 5, max: 120, step: 1, names: ["auto close", "auto close delay", "closing delay"] },
  { key: "showPlanInNotch", tier: "reversible", kind: "switch", names: ["claude plan", "claude usage", "plan in the notch"] },
  { key: "showCodexPlanInNotch", tier: "reversible", kind: "switch", names: ["codex plan", "codex usage"] },
  { key: "voice.speak", tier: "reversible", kind: "switch", names: ["speaking", "mochi's voice", "answers out loud", "answer out loud", "out loud", "aloud", "talking", "speak"] },
  { key: "voice.speaker", tier: "reversible", kind: "choice", names: ["voice", "speaker"], options: [choice("female", "female", "woman", "the woman's"), choice("male", "male", "man", "the man's")] },
  { key: "voice.followUp", tier: "reversible", kind: "number", min: 0, max: 30, step: 1, names: ["follow up", "follow up time", "keep listening"] },

  // ── A click first ──
  {
    key: "language", tier: "guarded", kind: "choice", names: ["language"],
    options: [
      choice("", "system", "the system's", "automatic"),
      ...LANGUAGES.map(({ code, name }) => choice(code, ...languageNames(code), name)),
    ],
  },
  { key: "autostart", tier: "guarded", kind: "switch", names: ["autostart", "start with windows", "launch at login", "start at login"] },
  { key: "screen", tier: "guarded", kind: "choice", names: ["screen", "display", "monitor"], options: [choice("primary", "primary", "main"), choice("cursor", "cursor", "the one with the mouse", "follow the mouse")] },
  { key: "voice.wake", tier: "guarded", kind: "switch", names: ["wake phrase", "listening for ok coucou"] },
  { key: "voice.engine", tier: "guarded", kind: "choice", names: ["free speech", "speech engine"], options: [choice("bundled", "on", "bundled"), choice("system", "off", "system", "windows")] },
  {
    key: "voice.hearingModel", tier: "guarded", kind: "choice", names: ["speech model", "hearing model"],
    options: [choice("moonshine-tiny", "moonshine", "moonshine tiny", "the small one"), choice("parakeet-110m", "parakeet 110", "the medium one"), choice("parakeet-0.6b", "parakeet", "parakeet 0.6", "the large one")],
  },
  { key: "voice.brain", tier: "guarded", kind: "choice", names: ["model server", "voice model server"], options: [choice("", "none", "no model"), choice("ollama"), choice("lmstudio", "lm studio"), choice("custom", "custom", "my own")] },
  { key: "claudeCodeMode", tier: "guarded", kind: "choice", names: ["claude code mode", "permission mode"], options: [choice("default", "default", "normal"), choice("plan", "plan", "plan mode")] },

  // ── Not by voice ──
  ...["hooksInstalled", "planRelayInstalled", "ollamaUrl", "lmstudioUrl", "customUrl", "claudeCodeDir", "shortcuts", "pillColors", "chatModels",
    "chatProvider", "model", "voice.brainModel", "voice.enabled", "phoneLink", "phoneChat", "phoneDetails", "phoneChatModels", "mainPill", "activeIntegrations"]
    .map((key): Rule => ({ key, tier: "never", kind: "switch", names: [] })),
];

/** How each language is said in English, beside its own name. */
function languageNames(code: string): string[] {
  const english: Record<string, string[]> = {
    en: ["english"], "zh-Hans": ["chinese", "simplified chinese", "mandarin"], hi: ["hindi"], es: ["spanish"], ar: ["arabic"],
    fr: ["french"], bn: ["bengali", "bangla"], "pt-BR": ["portuguese", "brazilian portuguese"], ru: ["russian"], id: ["indonesian"],
  };
  return english[code] ?? [code];
}

const said = (text: unknown) => normalise(typeof text === "string" ? text : String(text ?? ""));

/** The rule for a setting, by its key or by what it is called. Null: voice does not know it. */
export function ruleFor(name: string): Rule | null {
  const exact = RULES.find((rule) => rule.key === name);
  if (exact) return exact;
  const wanted = said(name);
  if (!wanted) return null;
  // The key said as words ("sound enabled", "voice follow up"), then its names.
  const keyed = RULES.find((rule) => said(rule.key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\./g, " ")) === wanted);
  return keyed ?? RULES.find((rule) => rule.names.some((n) => said(n) === wanted)) ?? null;
}

/** The names of the settings voice may read or change, for a model's tool list. */
export const SETTING_KEYS = RULES.filter((rule) => rule.tier !== "never").map((rule) => rule.key);

/** A number as it is said: "thirty", "twenty five", "50". NaN when it is none. */
export function numberSaid(text: string): number {
  const units: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
  const words = text.trim().split(/\s+/).filter((w) => w && w !== "a" && w !== "and");
  if (!words.length) return NaN;
  if (words.length === 1 && /^\d+(\.\d+)?$/.test(words[0])) return Number(words[0]);
  if (words.join(" ") === "half") return 50;
  if (words.length === 1) return units[words[0]] ?? tens[words[0]] ?? NaN;
  if (words.length === 2 && words[0] in tens && words[1] in units && units[words[1]] < 10) return tens[words[0]] + units[words[1]];
  if (words.length === 2 && words[0] === "one" && words[1] === "hundred") return 100;
  return NaN;
}

/** A switch that has a level beside it: "set the sound to thirty percent" means the level. */
export const LEVEL_OF: Readonly<Record<string, string>> = { soundEnabled: "soundVolume" };

const ON = new Set(["on", "true", "yes", "enable", "enabled", "1"]);
const OFF = new Set(["off", "false", "no", "disable", "disabled", "0", "none"]);

/** A value for this rule, from what was said or what a model gave. Undefined: not one it may take. */
export function valueFor(rule: Rule, raw: unknown): boolean | number | string | undefined {
  const text = said(raw);
  switch (rule.kind) {
    case "switch":
      if (typeof raw === "boolean") return raw;
      return ON.has(text) ? true : OFF.has(text) ? false : undefined;
    case "number": {
      const number = typeof raw === "number" ? raw : numberSaid(text.replace(/\s*(percent|seconds?|secs?|s)$/, ""));
      if (!Number.isFinite(number)) return ON.has(text) ? undefined : OFF.has(text) ? rule.min : undefined;
      // "Fifty percent" of the range; a model that gives the setting's own number (0.1) is taken as it is.
      const asked = rule.said === "percent" && number > rule.max ? (number / 100) * rule.max : number;
      if (asked < rule.min - 1e-9 || asked > rule.max + 1e-9) return undefined;
      return rule.step ? Math.round(asked / rule.step) * rule.step : Math.round(asked * 1000) / 1000;
    }
    case "choice": {
      const option = rule.options.find((o) => o.value === raw) ?? rule.options.find((o) => o.names.some((n) => said(n) === text));
      return option?.value;
    }
  }
}

/** A value as a person reads it: "on", "50 %", "French". */
export function shown(rule: Rule, value: unknown): string {
  switch (rule.kind) {
    case "switch":
      return value ? "on" : "off";
    case "number":
      return rule.said === "percent" ? `${Math.round((Number(value) / rule.max) * 100)} %` : String(value);
    case "choice": {
      const option = rule.options.find((o) => o.value === value);
      if (rule.key === "language") return LANGUAGES.find((l) => l.code === value)?.name ?? (value === "" ? "System" : String(value));
      return option?.names[0] ?? String(value ?? "");
    }
  }
}

/** What a change would be, before anything is done. */
export type Plan =
  /** Voice does not know this setting, or may never change it. */
  | { is: "refused"; why: "unknown" | "never" | "value"; rule?: Rule }
  /** It already has that value: nothing to do. */
  | { is: "same"; rule: Rule; value: boolean | number | string }
  /** Done at once. */
  | { is: "now"; rule: Rule; value: boolean | number | string; before: unknown }
  /** A click first. */
  | { is: "confirm"; rule: Rule; value: boolean | number | string; before: unknown };

/**
 * What changing a setting to a value comes to. `remote`: a model on another
 * computer proposed it — then nothing is done without a click, whatever its tier.
 */
export function plan(name: string, raw: unknown, current: (key: string) => unknown, remote = false): Plan {
  const named = ruleFor(name);
  if (!named) return { is: "refused", why: "unknown" };
  if (named.tier === "never") return { is: "refused", why: "never", rule: named };
  // A switch given a number is its level: the sound at thirty percent.
  const level = named.kind === "switch" && valueFor(named, raw) === undefined ? RULES.find((r) => r.key === LEVEL_OF[named.key]) : undefined;
  const rule = level && valueFor(level, raw) !== undefined ? level : named;
  const value = valueFor(rule, raw);
  if (value === undefined) return { is: "refused", why: "value", rule };
  const before = current(rule.key);
  if (before === value) return { is: "same", rule, value };
  return { is: rule.tier === "guarded" || remote ? "confirm" : "now", rule, value, before };
}

/** Reads `key` ("voice.followUp") in a settings object. */
export function read(settings: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined), settings);
}

/** A copy of the settings with `key` set: the object that held it is copied, nothing else is touched. */
export function written<T extends object>(settings: T, key: string, value: unknown): T {
  const [head, ...rest] = key.split(".");
  const holder = settings as Record<string, unknown>;
  if (!rest.length) return { ...settings, [head]: value };
  const inner = holder[head] && typeof holder[head] === "object" ? (holder[head] as object) : {};
  return { ...settings, [head]: written(inner, rest.join("."), value) };
}

/** The tools that are not settings, and how carefully each is used. One that is not here is refused. */
export const TOOL_TIERS: Readonly<Record<string, Tier>> = {
  show_view: "free",
  get_setting: "free",
  notify: "free",
  service_info: "free",
  open_web_search: "free",
  // Opens the mail app with a draft; sending is a click there, never here.
  open_draft: "free",
  // Closing the microphone is never made hard: done at once, with a way back on screen.
  stop_listening: "reversible",
  pause_coucou: "reversible",
  set_setting: "reversible",
  // The exact words on screen, and a click sends them.
  tell_agent: "guarded",
};
