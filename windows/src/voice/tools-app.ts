// The tools that reach the app itself rather than music and pills: its
// views, its settings, a toast, what a service last reported, a web search
// in the browser, a draft in the mail app, an instruction got ready in the
// chat. Each goes through the guard (voice/guard.ts): what is harmless is
// done, what can be undone is done and said, and what could do damage shows
// the exact change in a toast and waits for a click — never for a "yes".
//
// As everywhere in voice: what a model proposes is checked against what was
// said. A setting is changed only when the sentence names it; nothing here
// approves a permission or sends anything.

import { t } from "../i18n/i18n";
import { normalise } from "./entity";
import { LEVEL_OF, RULES, TOOL_TIERS, plan, ruleFor, shown, SETTING_KEYS, type Rule } from "./guard";
import type { Confirm } from "./result";
import type { VoiceResult } from "./runner";

/** What these tools need of the app. island/voice.ts has the real one; the tests a fake. */
export interface AppWorld {
  /** A setting's value now, by its key ("voice.followUp"). */
  setting(key: string): unknown;
  /** Changes it, saves, and reads it back: true when it now has that value. */
  setSetting(key: string, value: unknown): Promise<boolean>;
  /** Shows the exact change in a toast and waits for a click. True only for a click on its button. */
  confirm(confirm: Confirm): Promise<boolean>;
  notify(title: string, text?: string): void;
  /** Brings a view up. False when it cannot be shown now. */
  showView(view: AppView): boolean;
  /** Turns voice off (the microphone closes) and shows the way back on. */
  stopListening(): void;
  /** Pauses Coucou, as the tray's Pause does, and shows the way back. */
  pause(): void;
  /** What a service's card says now, a line each; empty when it says nothing. */
  serviceInfo(pillId: string): string[];
  openWebSearch(query: string): void;
  /** Opens the mail app on a draft. False when there is none to open it. */
  openMailDraft(to: string, subject: string, body: string): Promise<boolean>;
  /** Puts an instruction in the chat's field for the user to read and send. False when the chat cannot open. */
  prepareForAgent(message: string): boolean;
  /** The model that proposed this runs on another computer: nothing is changed without a click. */
  remote(): boolean;
}

export const APP_VIEWS = ["overview", "chat", "wardrobe", "recap", "settings"] as const;
export type AppView = (typeof APP_VIEWS)[number];

/** How each view is said. */
const VIEW_NAMES: Record<AppView, string[]> = {
  overview: ["overview", "home", "main view", "the pills", "sessions"],
  chat: ["chat", "the chat", "conversation", "prompt"],
  wardrobe: ["wardrobe", "outfits", "outfit", "clothes"],
  recap: ["recap", "summary", "history"],
  // "Open settings" alone is Windows' own, an app like another: Coucou's are asked for as Coucou's.
  settings: ["coucou settings", "coucou s settings", "your settings", "coucou preferences", "your preferences", "preferences"],
};

const ok = (message: string): VoiceResult => ({ outcome: "success", message });
const fail = (message: string): VoiceResult => ({ outcome: "failure", message });
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function fn(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

/**
 * The app's tools a sentence may be about: those whose words it has. A model
 * given all ten for every sentence reaches for them where it used to answer
 * or pick the right tool (measured: 39 of 39 single sentences became 35) — so
 * a sentence that speaks of none of this sees the list it always saw.
 */
export function appToolsFor(said: string, pills: readonly string[]): unknown[] {
  const spoken = normalise(said);
  const all = appToolSchemas(pills) as { function: { name: string } }[];
  const settings = RULES_SAID.some((name) => ` ${spoken} `.includes(` ${name} `)) || has(spoken, ["setting", "settings", "mute", "unmute"]);
  const wanted = new Set<string>();
  if (APP_VIEWS.some((view) => has(spoken, VIEW_NAMES[view]))) wanted.add("show_view");
  if (settings) wanted.add("get_setting").add("set_setting");
  if (has(spoken, ["voice", "microphone", "mic"])) wanted.add("stop_listening");
  if (has(spoken, ["coucou", "yourself", "the app", "a break"])) wanted.add("pause_coucou");
  if (has(spoken, ["note", "notify", "notification", "toast"])) wanted.add("notify");
  if (has(spoken, ["details", "detail", "more about", "report", "tell me more"])) wanted.add("service_info");
  if (has(spoken, SEARCH_WORDS)) wanted.add("open_web_search");
  if (has(spoken, MAIL_WORDS)) wanted.add("open_draft");
  if (has(spoken, TELL_WORDS)) wanted.add("tell_agent");
  return all.filter((tool) => wanted.has(tool.function.name));
}

/** The app's own tools, as a model is given them. `pills`: the catalog's names, for a service's report. */
export function appToolSchemas(pills: readonly string[]): unknown[] {
  return [
    fn("show_view", "Show one of Coucou's views in the island, or open its Settings window.", { view: { type: "string", enum: [...APP_VIEWS] } }, ["view"]),
    fn("get_setting", "Read one of Coucou's settings.", { setting: { type: "string", enum: SETTING_KEYS } }, ["setting"]),
    fn("set_setting", "Change one of Coucou's settings: a switch is 'on' or 'off', a volume a percentage, a choice one of its values.", {
      setting: { type: "string", enum: SETTING_KEYS },
      value: { type: "string" },
    }, ["setting", "value"]),
    fn("stop_listening", "Turn voice off altogether: the microphone closes until it is turned back on in Settings. Only when they ask to turn voice or the microphone off — being done with a request is 'nothing'."),
    fn("pause_coucou", "Pause Coucou itself (not the music), as its tray menu does."),
    fn("notify", "Show a short note on screen.", { text: { type: "string" } }, ["text"]),
    fn("service_info", "Read what a service's card says now (GitHub, Vercel, Stripe, plan usage…), for a question about it.", {
      service: { type: "string", enum: [...pills] },
    }, ["service"]),
    fn("open_web_search", "Open the browser on a web search for what they asked to look up.", { query: { type: "string" } }, ["query"]),
    fn("open_draft", "Open the mail app on a draft for the user to read and send themselves. Nothing is sent.", {
      to: { type: "string", description: "An email address, if they gave one." },
      subject: { type: "string" },
      body: { type: "string" },
    }, ["body"]),
    fn("tell_agent", "Get an instruction ready in Coucou's chat for the user to read and send to their agent. Nothing is sent.", {
      message: { type: "string" },
    }, ["message"]),
  ];
}

/** The names of the app's tools: one that is not here is not theirs to run. */
export const APP_TOOLS = new Set(Object.keys(TOOL_TIERS));

// ── What the sentence must say ────────────────────────────────────────────────

/** Every name a setting goes by, as it is heard. */
const RULES_SAID = RULES.flatMap((rule) => rule.names.map((name) => normalise(name))).filter(Boolean);

const has = (spoken: string, phrases: readonly string[]) => phrases.some((p) => ` ${spoken} `.includes(` ${normalise(p)} `));
const SEARCH_WORDS = ["search", "look up", "google", "find", "look for"];
const MAIL_WORDS = ["email", "mail", "e mail", "message"];
const TELL_WORDS = ["tell", "ask", "say to", "instruct", "have"];
const STOP_WORDS = ["turn voice off", "turn off voice", "turn the voice off", "voice off", "turn off the microphone",
  "turn the microphone off", "close the microphone", "microphone off", "mic off", "stop voice", "disable voice"];
const PAUSE_WORDS = ["pause coucou", "pause yourself", "pause the app", "pause everything", "take a break"];
const SHOW_WORDS = ["show", "open", "go to", "switch to", "bring up", "pull up", "take me to", "back to"];

/** The sentence speaks of this setting: one of its names, or — for a choice — the value asked for. */
export function namesSetting(said: string, rule: Rule, value?: unknown): boolean {
  const spoken = normalise(said);
  if (has(spoken, rule.names) || has(spoken, [rule.key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\./g, " ")])) return true;
  if (rule.key === "soundEnabled" && has(spoken, ["mute", "unmute", "quiet", "silent", "silence"])) return true;
  // A level is named by the switch it belongs to: "the sound effects at thirty percent".
  const owner = RULES.find((r) => LEVEL_OF[r.key] === rule.key);
  if (owner && has(spoken, owner.names)) return true;
  if (rule.kind !== "choice") return false;
  const option = rule.options.find((o) => o.value === value);
  return option != null && has(spoken, option.names);
}

/** The view a sentence names, when it asks to see one. */
export function viewSaid(said: string): AppView | null {
  const spoken = normalise(said);
  if (!has(spoken, SHOW_WORDS)) return null;
  const named = APP_VIEWS.filter((view) => has(spoken, VIEW_NAMES[view]));
  return named.length === 1 ? named[0] : null;
}

/** An address a draft may be opened for: one address, nothing that is not one. */
export function mailAddress(raw: string): string {
  const text = raw.trim().replace(/\s+at\s+/i, "@").replace(/\s+dot\s+/gi, ".").replace(/\s+/g, "");
  return /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(text) ? text : "";
}

// ── Running one ───────────────────────────────────────────────────────────────

export interface AppHeard {
  /** Nobody said the wake phrase: nothing is changed and nothing is shown. */
  quiet?: boolean;
  /** The catalog's pills, to find the one a service's name means. */
  pillId?: (name: string) => string | null;
}

/**
 * One of the app's tools, checked and done. Undefined: not one of them.
 * Null: done, with nothing to say (a view came up).
 */
export async function runAppCall(
  call: { name: string; arguments: Record<string, unknown> },
  said: string,
  app: AppWorld | undefined,
  heard: AppHeard = {},
): Promise<VoiceResult | null | undefined> {
  if (!APP_TOOLS.has(call.name)) return undefined;
  const refused = () => fail(said ? t("Not recognised: « {0} »", { 0: said }) : t("Command not recognised"));
  // A sentence said to nobody changes nothing in the app.
  if (!app || heard.quiet) return refused();
  const a = call.arguments ?? {};
  const spoken = normalise(said);

  switch (call.name) {
    case "show_view": {
      const view = viewSaid(said);
      // The view the sentence names, whatever the model made of it.
      if (!view) return refused();
      return app.showView(view) ? ok(t("{0} opened", { 0: VIEW_NAMES[view][0] })) : fail(t("That cannot be shown right now"));
    }
    case "get_setting": {
      const rule = ruleFor(str(a.setting));
      if (!rule || rule.tier === "never") return refused();
      return ok(`${rule.names[0]}: ${shown(rule, app.setting(rule.key))}`);
    }
    case "set_setting": {
      const change = plan(str(a.setting), a.value, (key) => app.setting(key), app.remote());
      if (change.is === "refused") {
        return change.why === "never" ? fail(t("That is changed in Settings, not by voice")) : refused();
      }
      const { rule, value } = change;
      // The setting the sentence names — or the switch its level belongs to ("the sound at thirty percent").
      const asked = ruleFor(str(a.setting));
      if (!namesSetting(said, rule, value) && !(asked && namesSetting(said, asked, value))) return refused();
      const line = `${rule.names[0]}: ${shown(rule, value)}`;
      if (change.is === "same") return ok(line);
      if (change.is === "confirm") {
        const clicked = await app.confirm({
          title: t("Change a setting?"),
          change: `${rule.names[0]}: ${shown(rule, change.before)} → ${shown(rule, value)}`,
          action: t("Change"),
        });
        if (!clicked) return ok(t("OK, leaving it as is"));
      }
      return (await app.setSetting(rule.key, value)) ? ok(line) : fail(t("That did not change"));
    }
    case "stop_listening":
      if (!has(spoken, STOP_WORDS)) return refused();
      app.stopListening();
      return null;
    case "pause_coucou":
      if (!has(spoken, PAUSE_WORDS)) return refused();
      app.pause();
      return null;
    case "notify": {
      const text = str(a.text).replace(/\s+/g, " ").slice(0, 140);
      if (!text) return refused();
      app.notify(text);
      return ok(text);
    }
    case "service_info": {
      const id = heard.pillId?.(str(a.service)) ?? null;
      if (!id) return refused();
      const lines = app.serviceInfo(id);
      return lines.length ? ok(lines.slice(0, 6).join(" · ").slice(0, 400)) : fail(t("Nothing to report"));
    }
    case "open_web_search": {
      const query = str(a.query).replace(/\s+/g, " ").slice(0, 200);
      if (!query || !has(spoken, SEARCH_WORDS)) return refused();
      app.openWebSearch(query);
      return ok(t("Searching the web for « {0} »", { 0: query.slice(0, 60) }));
    }
    case "open_draft": {
      if (!has(spoken, MAIL_WORDS)) return refused();
      const body = str(a.body).slice(0, 1500);
      if (!body) return refused();
      const opened = await app.openMailDraft(mailAddress(str(a.to)), str(a.subject).replace(/\s+/g, " ").slice(0, 120), body);
      return opened ? ok(t("The draft is open: read it and send it yourself")) : fail(t("No mail app opened"));
    }
    case "tell_agent": {
      if (!has(spoken, TELL_WORDS)) return refused();
      const message = str(a.message).slice(0, 1000);
      if (!message) return refused();
      return app.prepareForAgent(message) ? ok(t("It is in the chat: read it and send it yourself")) : fail(t("That cannot be shown right now"));
    }
    default:
      return refused();
  }
}

// ── Said plainly: no model needed ─────────────────────────────────────────────

const TURN = /^(?:please )?(?:turn|switch|put) (?:the )?(.+?) (on|off)$|^(?:please )?(?:turn|switch) (on|off) (?:the )?(.+)$/;
const SET = /^(?:please )?(?:set|change|put) (?:the )?(.+?) (?:to|at) (.+)$/;

/**
 * The call a sentence means when it is one of the app's own said plainly:
 * "mute", "show the chat", "stop listening", "turn the sound off", "set the
 * language to French". Null for anything else — a model reads the rest.
 */
export function appCall(said: string): { name: string; arguments: Record<string, unknown> } | null {
  const spoken = normalise(said);
  if (!spoken) return null;
  if (has(spoken, STOP_WORDS)) return { name: "stop_listening", arguments: {} };
  if (has(spoken, PAUSE_WORDS)) return { name: "pause_coucou", arguments: {} };
  if (/^(please )?(stop|quit) (talking|speaking|answering out loud)$/.test(spoken)) return { name: "set_setting", arguments: { setting: "voice.speak", value: "off" } };
  if (/^(please )?(mute|be quiet|silence)( the)?( sounds?| yourself| coucou)?$/.test(spoken)) return { name: "set_setting", arguments: { setting: "soundEnabled", value: "off" } };
  if (/^(please )?unmute( the)?( sounds?| yourself| coucou)?$/.test(spoken)) return { name: "set_setting", arguments: { setting: "soundEnabled", value: "on" } };
  const view = viewSaid(said);
  // "Open settings" is a view; "open spotify" is not one of them and is the parser's.
  if (view && spoken.split(" ").length <= 5) return { name: "show_view", arguments: { view } };
  const turned = TURN.exec(spoken);
  if (turned) {
    const rule = ruleFor(turned[1] ?? turned[4]);
    if (rule && rule.kind === "switch") return { name: "set_setting", arguments: { setting: rule.key, value: turned[2] ?? turned[3] } };
  }
  const set = SET.exec(spoken);
  if (set) {
    const rule = ruleFor(set[1]);
    if (rule) return { name: "set_setting", arguments: { setting: rule.key, value: set[2] } };
  }
  return null;
}
