// Coucou's settings, as the assistant may read and change them. One schema:
// a setting that is not in it does not exist here, and each one that is has
// its type, its range or its values, and how carefully it is changed —
//
//   reversible  done at once and said; `undo` puts it back
//   confirm     the exact change is shown and only a click makes it
//
// The schema describes the settings; it does not say how they are asked for.
// A setting is an entity (its key, and a plain name), and the model picks it.
//
// What is left out is left out on purpose (CLAUDE.md, doc/voice-brain.md):
// hooks and the status line write the agents' own configuration; addresses,
// keys and folders are not things to dictate; the phone link is Rust's to
// switch; shortcuts and colours are set by hand; turning voice on is the
// user's alone. Where what was said may go — the model server, the cloud, the
// web — is here, and each such change waits for the click.

import type { Args, Call, Tier, ToolResult } from "../core/capabilities/types";
import { SEARCH_ENGINES } from "../core/search";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost, Awaitable, Option } from "./host";
import { capability, cut, str, type Area } from "./shared";

const AREA = "settings";

export type SettingSpec = {
  /** The path in the settings: "soundEnabled", "voice.followUp". */
  key: string;
  /** A plain name for it. */
  label: string;
  /** What it does, in a few words a model reads. */
  about: string;
  tier: Extract<Tier, "reversible" | "confirm">;
} & (
  | { kind: "switch" }
  /** `percent`: given and shown as 0…100 of `max`. `unit`: what the number counts. */
  | { kind: "number"; min: number; max: number; step?: number; percent?: boolean; unit?: string }
  /** The values it may take now, as Settings offers them. */
  | { kind: "choice"; options: (host: AppHost) => Awaitable<readonly Option[]> }
);

const fixed = (...options: [value: string, label: string][]) => () => options.map(([value, label]) => ({ value, label }));

/** Every setting the assistant knows of. */
export const SETTINGS: readonly SettingSpec[] = [
  // ── Done at once ──
  { key: "soundEnabled", label: "Sound effects", about: "Mochi's sounds; off is muted", tier: "reversible", kind: "switch" },
  { key: "soundVolume", label: "Sound effects volume", about: "how loud Coucou's own sounds and Mochi's voice are, not the music", tier: "reversible", kind: "number", min: 0, max: 0.2, percent: true },
  { key: "openOnHover", label: "Open on hover", about: "hovering the island opens it all the way", tier: "reversible", kind: "switch" },
  { key: "autoCloseInterval", label: "Auto-close delay", about: "how long the open island stays before it folds", tier: "reversible", kind: "number", min: 5, max: 120, step: 1, unit: "seconds" },
  { key: "showPlanInNotch", label: "Claude plan usage in the island", about: "shows Claude's plan limits in the island's header", tier: "reversible", kind: "switch" },
  { key: "showCodexPlanInNotch", label: "Codex plan usage in the island", about: "shows Codex's plan limits in the island's header", tier: "reversible", kind: "switch" },
  { key: "voice.speak", label: "Spoken answers", about: "Mochi says his answers out loud", tier: "reversible", kind: "switch" },
  { key: "voice.speaker", label: "Mochi's voice", about: "which voice he speaks with", tier: "reversible", kind: "choice", options: fixed(["female", "Female"], ["male", "Male"]) },
  { key: "voice.followUp", label: "Follow-up time", about: "how long another sentence needs no wake phrase; 0 for none", tier: "reversible", kind: "number", min: 0, max: 30, step: 1, unit: "seconds" },

  // ── A click first ──
  { key: "language", label: "Language", about: "the language of Coucou's interface", tier: "confirm", kind: "choice", options: async (host) => (await host.languages()).map(inEnglish) },
  { key: "autostart", label: "Start with the computer", about: "Coucou starts when the session opens", tier: "confirm", kind: "switch" },
  { key: "screen", label: "Screen", about: "the display the island lives on", tier: "confirm", kind: "choice", options: (host) => host.monitors() },
  { key: "voice.wake", label: "Wake phrase", about: "the microphone listens for the wake phrase all the time", tier: "confirm", kind: "switch" },
  { key: "voice.hearingModel", label: "Speech model", about: "the model the downloaded engine hears with", tier: "confirm", kind: "choice", options: (host) => host.hearingModels() },
  { key: "voice.brain", label: "Voice model server", about: "the model server asked what a sentence means", tier: "confirm", kind: "choice", options: fixed(["", "None"], ["ollama", "Ollama"], ["lmstudio", "LM Studio"], ["custom", "Custom server"]) },
  { key: "claudeCodeMode", label: "Claude Code mode", about: "the permission mode Claude Code runs in from the chat", tier: "confirm", kind: "choice", options: fixed(["default", "Default"], ["plan", "Plan"]) },
  // Where what was said, or a question, may go: each waits for the click.
  { key: "voice.embedModel", label: "Voice ranking model", about: "the embedding model, on the voice model server, that ranks what a sentence is about; none turns the instant answers and the follow-up time off", tier: "confirm", kind: "choice", options: (host) => host.embedModels() },
  { key: "voice.cloud", label: "Cloud model for voice", about: "what the local model cannot do is handed to the provider chosen for the chat, with what was said", tier: "confirm", kind: "switch" },
  { key: "voice.webAnswers", label: "Web answers", about: "a question asked out loud may be answered from a web search", tier: "confirm", kind: "switch" },
  { key: "voice.webSearch", label: "Web search service", about: "who answers a web question: Brave Search with the user's key, Anthropic, or nobody (the browser opens)", tier: "confirm", kind: "choice", options: fixed(["browser", "The browser"], ["brave", "Brave Search"], ["anthropic", "Anthropic"]) },
  { key: "searchEngine", label: "Search engine", about: "the search engine the browser opens a search on", tier: "confirm", kind: "choice", options: () => SEARCH_ENGINES.map(({ id, name }) => ({ value: id, label: name })) },
];

export const settingSpec = (key: string): SettingSpec | undefined => SETTINGS.find((s) => s.key === key);

/** A language also by its name in English, as the platform writes it: what voice, English only, hears ("French" for Français). */
function inEnglish(option: Option): Option {
  try {
    const name = option.value ? new Intl.DisplayNames(["en"], { type: "language" }).of(option.value) : undefined;
    return name && name.toLowerCase() !== option.label.toLowerCase() ? { ...option, spoken: [name] } : option;
  } catch {
    return option;
  }
}

type Value = boolean | number | string;

/** A value as a person reads it: "on", "50 %", "Français". */
function shown(spec: SettingSpec, value: unknown, options: readonly Option[] = []): string {
  switch (spec.kind) {
    case "switch":
      return value ? "on" : "off";
    case "number":
      if (spec.percent) return `${Math.round((Number(value) / spec.max) * 100)} %`;
      return spec.unit ? `${Number(value)} ${spec.unit}` : String(value);
    case "choice":
      return options.find((o) => o.value === value)?.label ?? String(value ?? "");
  }
}

/** What the setting takes, in a few words: for the entity's hint and for a refusal. */
function shape(spec: SettingSpec): string {
  switch (spec.kind) {
    case "switch":
      return "a switch: 'on' true or false";
    case "number":
      return spec.percent ? "'number' from 0 to 100 (percent)" : `'number' from ${spec.min} to ${spec.max}${spec.unit ? ` ${spec.unit}` : ""}`;
    case "choice":
      return "'option', one of its values";
  }
}

/** The value the arguments give for this setting, in the setting's own terms; or why they give none. */
function wanted(spec: SettingSpec, args: Args, options: readonly Option[]): { value: Value } | { why: string } {
  switch (spec.kind) {
    case "switch":
      if (typeof args.on === "boolean") return { value: args.on };
      // A level asked of a switch: the settings that take one are named.
      // A switch given no on or off may have been meant as a level: the settings that take one are named.
      return { why: `${spec.label} is ${shape(spec)}. A level is one of: ${SETTINGS.filter((s) => s.kind === "number").map((s) => `${s.label} (${shape(s)})`).join(", ")}.` };
    case "number": {
      const given = args.number;
      if (typeof given !== "number" || !Number.isFinite(given)) return { why: `${spec.label} takes ${shape(spec)}.` };
      const value = spec.percent ? (given / 100) * spec.max : given;
      if (value < spec.min - 1e-9 || value > spec.max + 1e-9) return { why: `${spec.label} takes ${shape(spec)}.` };
      return { value: spec.step ? Math.round(value / spec.step) * spec.step : Math.round(value * 1000) / 1000 };
    }
    case "choice": {
      const given = typeof args.option === "string" ? args.option.trim() : null;
      // By its value, or by its label as it is written.
      const option = given == null ? undefined
        : options.find((o) => o.value === given)
          ?? options.find((o) => [o.label, ...(o.spoken ?? [])].some((name) => name.toLowerCase() === given.toLowerCase()));
      return option ? { value: option.value } : { why: `${spec.label} takes one of: ${options.map((o) => o.label).join(", ")}.` };
    }
  }
}

/** The arguments that set this setting to a stored value: what an inverse is written with. */
function argumentsFor(spec: SettingSpec, value: unknown): Args {
  switch (spec.kind) {
    case "switch":
      return { setting: spec.key, on: Boolean(value) };
    case "number":
      return { setting: spec.key, number: spec.percent ? (Number(value) / spec.max) * 100 : Number(value) };
    case "choice":
      return { setting: spec.key, option: String(value ?? "") };
  }
}

export function settings(host: AppHost): Area {
  const optionsOf = async (spec: SettingSpec): Promise<readonly Option[]> => (spec.kind === "choice" ? await spec.options(host) : []);
  const unknown = (args: Args): ToolResult =>
    failed(t("That is changed in Settings, not by voice"), `'${cut(str(args.setting), 40)}' is not a setting that can be read or changed from here.`);

  return {
    sources: [
      {
        kind: "setting",
        description: "Coucou's settings that can be read or changed from here, each with what it does and what it takes.",
        list: () => SETTINGS.map((spec) => ({ id: spec.key, label: spec.label, hint: `${spec.about}; ${shape(spec)}` })),
      },
    ],
    capabilities: [
      capability({
        name: "get_setting",
        area: AREA,
        description: "Reads one of Coucou's settings: its value now, and for a choice the values it may take.",
        args: { setting: { type: "entity", kind: "setting", description: "The setting to read." } },
        tier: "read",
        async run(args) {
          const spec = settingSpec(str(args.setting));
          if (!spec) return unknown(args);
          const options = await optionsOf(spec);
          const value = host.setting(spec.key);
          return done(`${spec.label}: ${shown(spec, value, options)}`, true, {
            setting: spec.label, value: shown(spec, value, options),
            ...(spec.kind === "choice" ? { options: options.map((o) => o.label) } : {}),
          });
        },
      }),
      capability({
        name: "set_setting",
        area: AREA,
        description: "Changes one of Coucou's settings: its sound effects (muting them) and their volume, the language, the island, how voice listens and speaks. A switch takes 'on'; a level or a delay takes 'number' (a volume from 0 to 100); a choice takes 'option', one of its values. Some are changed at once and can be undone; the others wait for the user's click. Coucou's own sound is the Sound effects switch (off mutes it) and the Sound effects volume. Not for the pills, the music or Mochi's outfit, which have their own.",
        args: {
          setting: { type: "entity", kind: "setting", description: "The setting to change." },
          on: { type: "boolean", optional: true, description: "For a switch: true for on, false for off." },
          number: { type: "number", optional: true, description: "For a level or a delay: the number, in the setting's own unit." },
          option: { type: "string", optional: true, maxLength: 80, description: "For a choice: the value to pick, as get_setting lists them." },
        },
        // A setting the schema does not know is refused in `check`; until then it is treated with the most care.
        tier: (args) => settingSpec(str(args.setting))?.tier ?? "confirm",
        // Before the click: a value the setting does not take is said, with the values it does.
        async check(args) {
          const spec = settingSpec(str(args.setting));
          if (!spec) return unknown(args);
          const options = await optionsOf(spec);
          const next = wanted(spec, args, options);
          return "why" in next ? { ...failed(t("That did not change"), next.why), ...(options.length ? { near: options.map((o) => o.label) } : {}) } : null;
        },
        async describe(args) {
          const spec = settingSpec(str(args.setting));
          if (!spec) return { title: t("Change a setting?"), change: cut(str(args.setting), 80), action: t("Change") };
          const options = await optionsOf(spec);
          const next = wanted(spec, args, options);
          const before = shown(spec, host.setting(spec.key), options);
          return {
            title: t("Change a setting?"),
            change: "value" in next ? `${spec.label}: ${before} → ${shown(spec, next.value, options)}` : `${spec.label}: ${before}`,
            action: t("Change"),
          };
        },
        inverse(args): Call | null {
          const spec = settingSpec(str(args.setting));
          if (!spec) return null;
          const before = host.setting(spec.key);
          return before === undefined ? null : { name: "set_setting", arguments: argumentsFor(spec, before) };
        },
        async run(args) {
          const spec = settingSpec(str(args.setting));
          if (!spec) return unknown(args);
          const options = await optionsOf(spec);
          const next = wanted(spec, args, options);
          if ("why" in next) {
            return { ...failed(t("That did not change"), next.why), ...(options.length ? { near: options.map((o) => o.label) } : {}) };
          }
          const line = `${spec.label}: ${shown(spec, next.value, options)}`;
          if (host.setting(spec.key) === next.value) return { ...done(line, true), detail: `${line} already.` };
          // `setSetting` saves and reads back: true only when the setting now has the value.
          return (await host.setSetting(spec.key, next.value)) ? done(line, true) : failed(t("That did not change"), `${spec.label} was not saved.`);
        },
      }),
    ],
  };
}
