// What a model may ask Coucou to do when a sentence is not one the parser
// knows (src-tauri/src/voice/brain.rs asks it). The model proposes tool calls;
// everything here decides: each call is checked against what was actually
// said before anything happens, because a small local model picks the wrong
// tool about one time in four (doc/voice-v2-plan.md has the measurements).
//
// The rules no prompt is trusted with:
// - There is no tool that approves a permission or sends anything.
// - A permission is declined only when the sentence has a word for declining.
// - A pill is touched only when the sentence names it.
// - "Keep only" needs the word that means it.
// - An app is a Start-menu name, a folder one of the user's own, a URL http(s).

import type { PillDefinition } from "../core/pills";
import { t } from "../i18n/i18n";
import { normalise, resolvePill, spokenForms } from "./entity";
import { howNamed } from "./resolve";
import { askNearlyNamed, nearlyNamed } from "./ask";
import type { VoiceIntent } from "./intent";
import type { VoiceAction } from "./memory";
import type { Answer, Ask } from "./result";
import type { VoiceResult, VoiceRunner } from "./runner";
import { answerLine, usable } from "./asking";
import { appToolsFor, runAppCall, type AppWorld } from "./tools-app";
import { isPreviewTool, openPreview, previewToolsFor } from "./tools-preview";

export interface BrainCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What the tools reach beyond music and pills. island/voice.ts has the real one. */
export interface VoiceWorld {
  /** Pills with something going on: what each agent is doing, in a few words. */
  agents(): { id: string; name: string; state: string; doing: string }[];
  /** Brings a pill's session, and its terminal, to the front. False when it has none. */
  openSession(pillId: string): boolean;
  /** The permission request waiting for an answer, if one is. */
  permission(): { agent: string; request: string } | null;
  showPermission(): void;
  declinePermission(): void;
  /** Minutes left on the timer, if one runs. */
  timer(): { label: string; minutesLeft: number } | null;
  setTimer(minutes: number, label: string): void;
  cancelTimer(): boolean;
  /** The name of what was opened, or null when nothing by that name exists. */
  openApp(name: string): Promise<string | null>;
  /**
   * Whether the app `openApp` just started was seen to come to the front.
   * Without it, what was started is taken to have come.
   */
  appSeen?(): boolean;
  /**
   * The installed apps nearest to what was heard, nearest first, for a
   * question: nothing is opened. `clear`: the first is the one to ask about.
   */
  appsNear(said: string): Promise<{ found?: string | null; names: string[]; scores?: number[]; clear: boolean }>;
  openFolder(name: string): Promise<string | null>;
  openUrl(url: string): void;
  /** What is playing, for questions about it. */
  nowPlaying(): string | null;
  /** One line per service about what it last reported (CI, plan usage…). */
  reports(): Record<string, string>;
  /** The app's own views, settings and windows (voice/tools-app.ts). Without it, those tools are refused. */
  app?: AppWorld;
}

const ok = (message: string): VoiceResult => ({ outcome: "success", message });
const fail = (message: string): VoiceResult => ({ outcome: "failure", message });

// ── What the model is given ───────────────────────────────────────────────────

const MUSIC_ACTIONS = ["play", "pause", "next", "previous", "shuffle_on", "shuffle_off", "repeat_on", "repeat_off"] as const;

function fn(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

/**
 * The tools, in the OpenAI format every local server speaks. Pill names are
 * the catalog's. `near`: the installed apps a misheard name in the sentence
 * may be (`misheardApps`), which the model may ask about.
 */
export function toolSchemas(pills: readonly PillDefinition[], near: readonly string[] = [], said = ""): unknown[] {
  const names = pills.map((p) => p.name);
  const workspace = pills.filter((p) => p.category === "workspace").map((p) => p.name);
  const pill = { type: "string", enum: names };
  const list = { type: "array", items: pill };
  return [
    fn("music", "Control the music (Spotify).", { action: { type: "string", enum: [...MUSIC_ACTIONS] } }, ["action"]),
    fn("add_pills", "Show pills in the island.", { pills: list }, ["pills"]),
    fn("remove_pills", "Hide pills from the island.", { pills: list }, ["pills"]),
    fn("replace_pill", "Hide one pill and show another in its place.", { remove: pill, add: pill }, ["remove", "add"]),
    fn("keep_only_pills", "Hide every pill except these. Only for 'only', 'just' or 'nothing but'.", { pills: list }, ["pills"]),
    fn("set_main_pill", "Choose the main workspace tool.", { pill: { type: "string", enum: workspace } }, ["pill"]),
    fn("open_session", "Bring an agent's session and its terminal to the front.", { agent: pill }, ["agent"]),
    fn("show_permission_request", "Open the permission request that is waiting, so the user can read it."),
    fn("decline_permission", "Decline the permission request that is waiting. Approving is not possible: it takes a click."),
    fn("set_timer", "Start a timer or a reminder.", {
      minutes: { type: "number" },
      label: { type: "string", description: "What to remind about, if said." },
    }, ["minutes"]),
    fn("cancel_timer", "Cancel the running timer."),
    fn("open_app", "Open an application installed on this computer.", { name: { type: "string" } }, ["name"]),
    fn("open_url", "Open a web address in the browser.", { url: { type: "string" } }, ["url"]),
    fn("open_folder", "Open one of the user's folders: Downloads, Desktop, Documents, Pictures.", { name: { type: "string" } }, ["name"]),
    // Offered only with a sentence that may hold a misheard app name: for any other, the list is what it was.
    ...(near.length
      ? [fn("ask_which_app", "Ask the user whether they meant one of these applications, when the sentence seems to name an application but no installed one has that name.", {
          apps: { type: "array", items: { type: "string", enum: [...near] } },
        }, ["apps"])]
      : []),
    // The app's own tools, when the sentence speaks of what they do (voice/tools-app.ts).
    ...appToolsFor(said, names),
    // Sample data only (voice/tools-preview.ts): web_search, check_inbox, read_message, write_draft.
    ...previewToolsFor(said),
    fn("nothing", "The user changed their mind, is done ('ok done', 'that's all', 'thanks'), or what was heard is not a request."),
  ];
}

/** What the model is told about the app, so it can answer questions about it. */
export function describeState(world: VoiceWorld, runner: Pick<VoiceRunner, "pillState">, pills: readonly PillDefinition[]) {
  const name = (id: string) => pills.find((p) => p.id === id)?.name ?? id;
  const { active, main } = runner.pillState();
  const timer = world.timer();
  return {
    active_pills: active.map(name),
    main_pill: name(main),
    agents: world.agents().map(({ name: agent, state, doing }) => ({ name: agent, state, doing })),
    permission_waiting: world.permission(),
    now_playing: world.nowPlaying(),
    timer: timer ? `${timer.minutesLeft} min left${timer.label ? `: ${timer.label}` : ""}` : null,
    reports: world.reports(),
  };
}

/**
 * `near`: the installed apps a misheard name in the sentence may be
 * (`misheardApps`), so it can be asked about. Never the whole list of what is
 * installed.
 */
export function systemPrompt(state: unknown, near: readonly string[] = []): string {
  return [
    "You are Mochi, the voice of Coucou, a small desktop app that shows AI coding agents and a few services as pills.",
    "The user spoke one sentence. A speech recogniser wrote it down and may have misheard words: 'get hub' is GitHub.",
    "Decide what they want.",
    "Rules:",
    "1. Something to do: call the tool that does it, with exactly what was asked. One tool per thing asked.",
    "2. A question: call no tool. Answer in one short sentence, from the state below when it is about the app.",
    "3. Adding is add_pills, never keep_only_pills. keep_only_pills is only for 'only', 'just', 'nothing but'.",
    "4. The pill named 'VS Code' is Claude Code: 'Claude' means 'VS Code', unless they say 'Claude Desktop'.",
    "5. 'switch to', 'use', 'main' with a workspace tool is set_main_pill. open_session is for seeing an agent's session or terminal.",
    "6. decline_permission only when they clearly say decline, deny, refuse or reject. You cannot approve or allow a request: say it takes a click.",
    "7. Opening or launching an application is open_app, even when a pill has the same name.",
    "8. Changed their mind, or not a request: call nothing.",
    "9. Earlier messages are the conversation so far. A follow-up with no verb ('what about X', 'and X', 'no, X') means the last action again, with X.",
    ...(near.length
      ? [`10. Part of the sentence may be the misheard name of an application. Installed applications that sound like it: ${JSON.stringify(near)}. When they ask to open, launch, pull up or show something that is not a pill, call ask_which_app with these.`]
      : []),
    `State: ${JSON.stringify(state)}`,
  ].join("\n");
}

/**
 * What the model is told once its tools have run, on top of what it was told
 * first: to go on if something is still to do, else to say what happened. The
 * first round's prompt is left exactly as it was — it is what the checks and
 * the evaluation were tuned on.
 */
export const AFTER_TOOLS = [
  "The tools you called have run. Their results follow: status 'done' with verified true was seen to work; verified false was asked for but not seen;",
  "'failed', 'not_found' and 'refused' did not happen.",
  "If what the user asked still needs another tool, call it. Otherwise call no tool and say what happened in one short sentence, as Mochi, in plain words:",
  "only what the results show — never say something worked when its result says otherwise, and say so when it did not.",
].join(" ");

// ── Checking what the model proposes ──────────────────────────────────────────

const DECLINE_WORDS = /\b(decline|declined|deny|denied|refuse|reject|block|don t allow|do not allow|dont allow)\b/;
const APPROVE_WORDS = /\b(allow|approve|accept|grant|authori[sz]e|permit|let it|go ahead)\b/;
const ONLY_WORDS = /\b(only|just|nothing but|except|everything but|all but)\b/;
const OPEN_WORDS = /\b(open|launch|start|run|bring up|fire up|go to|show me)\b/;

const UNITS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * The minutes a sentence asks for — "five minutes", "20 min", "an hour and a
 * half", "twenty five minutes" — or null. What was said wins over what a
 * model made of it: models write "five" where a number is asked.
 */
export function minutesSaid(said: string): number | null {
  const words = normalise(said).split(" ");
  if (words.join(" ").includes("half an hour")) return 30;
  let total = 0;
  let found = false;
  for (let i = 0; i < words.length; i++) {
    const unit = /^(minute|minutes|min|mins)$/.test(words[i]) ? 1 : /^(hour|hours)$/.test(words[i]) ? 60 : 0;
    if (!unit) continue;
    // The number is the one or two words before the unit.
    const before = words[i - 1] ?? "";
    const earlier = words[i - 2] ?? "";
    let n: number | null = null;
    if (/^\d+$/.test(before)) n = Number(before);
    else if (before in TENS) n = TENS[before];
    else if (before in UNITS) n = UNITS[before] + (earlier in TENS ? TENS[earlier] : 0);
    if (n == null) continue;
    total += n * unit;
    found = true;
    if (unit === 60 && words.slice(i + 1, i + 4).join(" ") === "and a half") total += 30;
  }
  return found ? total : null;
}

/** What comes after "open" in a sentence: the app as the user named it. */
function openedThing(said: string): string {
  const words = normalise(said).split(" ");
  const at = words.findIndex((w) => /^(open|launch|start|run)$/.test(w));
  const rest = (at >= 0 ? words.slice(at + 1) : words).filter((w) => !/^(the|my|a|an|up|app|application|program|please)$/.test(w));
  return rest.join(" ");
}

/** The sentence asks for a permission to be approved: never done by voice. */
export function asksToApprove(said: string): boolean {
  const s = normalise(said);
  return APPROVE_WORDS.test(s) && !DECLINE_WORDS.test(s);
}

/**
 * Whether the sentence itself names this pill: one of the ways it is said, or
 * one to three words in a row that can only mean it ("get hub"). A model that
 * brings up a pill nobody mentioned does not get to touch it.
 */
export function names(said: string, id: string, pills: readonly PillDefinition[]): boolean {
  const def = pills.find((p) => p.id === id);
  if (!def) return false;
  const words = normalise(said).split(" ").filter(Boolean);
  const text = ` ${words.join(" ")} `;
  if ([...spokenForms(def), normalise(def.name)].some((form) => text.includes(` ${form} `))) return true;
  // One to three words in a row that can only mean it — and are not part of
  // another pill's name: "claude code" does not name Codex (voice/resolve.ts).
  return howNamed(said, id, pills) != null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);

/** The pills a call names, each one checked against the catalog and the sentence; null when any fails. */
function pillIds(values: string[], said: string, pills: readonly PillDefinition[], category?: "workspace"): string[] | null {
  if (!values.length) return null;
  const ids: string[] = [];
  for (const value of values) {
    const id = resolvePill(value, pills, category);
    if (!id || !names(said, id, pills)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** An http(s) address from what the model wrote, or null. "github.com" gets https. */
export function webAddress(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A pill or music call as the intent the runner already knows how to do, or
 * null when the call is not one, or fails its checks.
 */
export function intentOf(call: BrainCall, said: string, pills: readonly PillDefinition[]): VoiceIntent | null {
  const a = call.arguments ?? {};
  switch (call.name) {
    case "music":
      switch (str(a.action)) {
        case "play": return { kind: "musicPlay", target: null };
        case "pause": return { kind: "musicPause" };
        case "next": return { kind: "musicNext" };
        case "previous": return { kind: "musicPrevious" };
        case "shuffle_on": return { kind: "musicShuffle", on: true };
        case "shuffle_off": return { kind: "musicShuffle", on: false };
        case "repeat_on": return { kind: "musicRepeat", on: true };
        case "repeat_off": return { kind: "musicRepeat", on: false };
        default: return null;
      }
    case "add_pills": {
      const ids = pillIds(strs(a.pills), said, pills);
      return ids ? (ids.length === 1 ? { kind: "pillAdd", id: ids[0] } : { kind: "pillAddMultiple", ids }) : null;
    }
    case "remove_pills": {
      const ids = pillIds(strs(a.pills), said, pills);
      return ids ? (ids.length === 1 ? { kind: "pillRemove", id: ids[0] } : { kind: "pillRemoveMultiple", ids }) : null;
    }
    case "replace_pill": {
      const ids = pillIds([str(a.remove), str(a.add)].filter(Boolean), said, pills);
      return ids?.length === 2 ? { kind: "pillReplace", old: ids[0], new: ids[1] } : null;
    }
    case "keep_only_pills": {
      if (!ONLY_WORDS.test(normalise(said))) return null;
      const ids = pillIds(strs(a.pills), said, pills);
      return ids ? { kind: "pillOnly", ids } : null;
    }
    case "set_main_pill": {
      const ids = pillIds(strs(a.pill), said, pills, "workspace");
      return ids ? { kind: "pillSetMain", id: ids[0] } : null;
    }
    default:
      return null;
  }
}

// ── Doing it ──────────────────────────────────────────────────────────────────

const notUnderstood = (said: string) =>
  fail(said ? t("Not recognised: « {0} »", { 0: said }) : t("Command not recognised"));

/** One of the user's own folders, said as nothing else: "downloads", "the pictures folder". */
const FOLDER = /^(downloads?|desktop|documents?|pictures?|videos?|\w+ folder)$/;

/**
 * Opens what a name means — one of the user's folders when it is said as one,
 * else the installed app it was heard as — and says which. Null: nothing by
 * that name. The one way in for "open …", from the parser and from a model.
 */
export async function openNamed(name: string, world: VoiceWorld): Promise<VoiceResult | null> {
  const app = await openedName(name, world);
  return app ? opened(app, world) : null;
}

/** The same, as the name of what was opened. */
export async function openedName(name: string, world: VoiceWorld): Promise<string | null> {
  const wanted = name.slice(0, 80);
  if (!wanted) return null;
  return (FOLDER.test(wanted) ? await world.openFolder(wanted) : null) ?? (await world.openApp(wanted));
}

/**
 * What opening came to. "Opened" is for what was seen to come; an app that
 * was started and not seen yet is said to have been asked for, no more.
 */
export const opened = (name: string, world?: Pick<VoiceWorld, "appSeen">) =>
  ok(world?.appSeen?.() ?? true ? t("{0} opened", { 0: name }) : t("Asked Windows to open {0}", { 0: name }));

export const notFound = (name: string) => fail(t("Not found: {0}", { 0: name.slice(0, 40) }));

/**
 * No app by that name: Mochi asks about the nearest — "Open Spotify?", or
 * "Spotify or Steam?" — and the answer decides (voice/ask.ts). Null when
 * nothing is near. Nothing is opened here.
 */
export async function didYouMean(
  heard: string,
  said: string,
  runner: VoiceRunner,
  world: VoiceWorld,
  rounds = 1,
): Promise<VoiceResult | null> {
  // The name, then the name without what trails it: "spy flight for me" is asked about as "spy flight".
  const words = heard.slice(0, 80).split(/\s+/).filter(Boolean);
  for (let length = Math.min(words.length, 5); length >= 1; length--) {
    if (length < words.length && length > 3) continue;
    const near = await world.appsNear(words.slice(0, length).join(" "));
    if (near.names.length) return runner.askOpen(near.clear ? near.names.slice(0, 1) : near.names, said, rounds);
    if (words.length === 1) break;
  }
  return null;
}

/**
 * The tool calls a model wrote out as text instead of making them — `remove_pills
 * {"pills": ["Stripe"]}`, `{"name": "open_app", "arguments": {…}}`, with or
 * without a code fence. A small model does this now and then, and what it wrote
 * was shown as its answer, with a tick, while nothing had been done. Only the
 * names of tools that exist are taken; anything else is not a call.
 */
export function callsWritten(text: string, known: ReadonlySet<string>): BrainCall[] {
  const body = text.replace(/```[a-z]*\n?|```|<\/?tool_call>/gi, " ").trim();
  if (!body) return [];
  const calls: BrainCall[] = [];
  const take = (name: unknown, args: unknown) => {
    if (typeof name !== "string" || !known.has(name.trim())) return;
    const parsed = typeof args === "string" ? safeJson(args) : args;
    calls.push({ name: name.trim(), arguments: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} });
  };
  // JSON: one call or a list of them.
  const whole = safeJson(body);
  for (const item of Array.isArray(whole) ? whole : whole ? [whole] : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = (o.function && typeof o.function === "object" ? o.function : o) as Record<string, unknown>;
    take(fn.name ?? o.tool, fn.arguments ?? fn.parameters ?? o.args ?? {});
  }
  if (calls.length) return calls;
  // name {json} or name({json}), one or several.
  for (const m of body.matchAll(/([a-z_]{3,40})\s*\(?\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})?\s*\)?/g)) {
    if (known.has(m[1])) take(m[1], m[2] ?? {});
  }
  // Only when the text is nothing but calls: a sentence that mentions a tool's name is a sentence.
  const rest = body.replace(/([a-z_]{3,40})\s*\(?\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})?\s*\)?/g, (all, name) => (known.has(name) ? "" : all)).replace(/[\s,;.]+/g, "");
  return rest ? [] : calls;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Text that is a model's plumbing showing through, not a sentence for a person: never shown, never said. */
export function looksLikeCall(text: string): boolean {
  const body = text.trim();
  return /^[\[{]/.test(body) || /^```/.test(body) || /<tool_call>/.test(body) || /^[a-z_]{3,40}\s*[({]/.test(body);
}

/** The names of the tools a list offers. */
export const toolNames = (tools: readonly unknown[]): Set<string> =>
  new Set(tools.map((tool) => (tool as { function?: { name?: string } }).function?.name).filter((name): name is string => typeof name === "string"));

/**
 * Of the apps near a sentence, the ones it does not already name outright: a
 * name that is in the sentence as it is written needs no hint, and a hint
 * changes what a small model makes of the rest ("what is Claude doing?").
 */
export function misheardApps(said: string, near: readonly string[]): string[] {
  const spoken = ` ${normalise(said)} `;
  return near.filter((name) => !spoken.includes(` ${normalise(name)} `));
}

/** Said as something other than an app: a session, a web address. A model may know. */
export const notAnApp = (name: string) => /\b(session|terminal|website|site|page|dot (com|org|net|io|dev|app|ai))\b/.test(normalise(name));

/** Whether the model made anything of the sentence: false for "not recognised". */
export const understood = (result: VoiceResult, said: string) => result.message !== notUnderstood(said).message;

/** What a proposal is checked against, besides the sentence itself. */
export interface Heard {
  /**
   * What was done last, if still remembered: a sentence with no word for
   * opening may open again after it ("what about Steam?"). Only that — a
   * permission is never declined, and pills are never kept "only", on the
   * strength of an earlier sentence.
   */
  last?: VoiceAction | null;
  /**
   * The sentence with its "that one" said as the pill the last command was
   * about (voice/memory.ts `withPronoun`): what a name is checked against.
   */
  meant?: string;
  /** Nobody said the wake phrase: Mochi asks nothing back. */
  quiet?: boolean;
  /** The apps the model was told sound like the sentence. */
  near?: readonly string[];
  /** Told of each call that was done, and as which intent when it was one. */
  ran?: (call: BrainCall, intent: VoiceIntent | null) => void;
  /** Told of every call and what came of it, done or not: what a model is given back. */
  each?: (call: BrainCall, result: VoiceResult | null) => void;
  /**
   * Puts a question on screen and waits for its answer. Given only once the
   * model has seen a tool's result: a model that may ask from the start asks
   * instead of doing (measured — doc/voice.md D19).
   */
  ask?: (ask: Ask) => Promise<Answer>;
}

/**
 * The tool a model asks the user with, once its tools have run: a list to
 * pick from, yes or no, or something to say or type. Offered only then.
 */
export const ASK_USER = fn(
  "ask_user",
  "Ask the user one short question when a tool's result leaves a choice only they can make (which account, which one of several, what exactly). "
    + "Give 'options' (2 to 9 short labels) for a choice; kind 'yes_no' for a yes or no; kind 'text' for something they must say or type. "
    + "Never ask what a tool can find out, and never to confirm what they already said.",
  {
    question: { type: "string" },
    kind: { type: "string", enum: ["choice", "yes_no", "text"] },
    options: { type: "array", items: { type: "string" } },
  },
  ["question"],
);

/** The question a model's `ask_user` call means, or null when it is none. */
export function askOf(a: Record<string, unknown>): Ask | null {
  const question = str(a.question);
  const options = Array.isArray(a.options) ? a.options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
  if (options.length >= 2) return usable({ kind: "choice", question, options: options.map((label, i) => ({ id: String(i + 1), label })) });
  return usable(a.kind === "yes_no" ? { kind: "yes_no", question } : { kind: "text", question });
}

/** One call, checked and done. `null`: the user changed their mind — nothing to show. */
async function runCall(
  call: BrainCall,
  said: string,
  runner: VoiceRunner,
  world: VoiceWorld,
  pills: readonly PillDefinition[],
  heard: Heard,
): Promise<VoiceResult | null> {
  const a = call.arguments ?? {};
  const spoken = normalise(said);
  // What names are read from: the user's words, a pronoun resolved (hook: memory.ts).
  const named = heard.meant ?? said;
  const intent = intentOf(call, named, pills);
  if (intent) {
    // A pill the sentence only nearly names is asked about first (hook: ask.ts).
    const unsure = askNearlyNamed(intent, named, runner, pills);
    if (unsure) return heard.quiet ? notUnderstood(said) : unsure();
    const result = runner.run(intent, said);
    if (result.outcome === "success") heard.ran?.(call, intent);
    return result;
  }
  const done = (result: VoiceResult) => {
    heard.ran?.(call, null);
    return result;
  };
  // A word for opening in the sentence — or an app was just opened, and this
  // sentence is not about a permission.
  const opening = OPEN_WORDS.test(spoken);
  const again = !opening && heard.last?.kind === "open" && !DECLINE_WORDS.test(spoken) && !APPROVE_WORDS.test(spoken);

  switch (call.name) {
    case "nothing":
      return null;
    case "open_session": {
      const ids = pillIds(strs(a.agent), named, pills);
      if (!ids) return notUnderstood(said);
      const name = pills.find((p) => p.id === ids[0])?.name ?? ids[0];
      // An agent the sentence only nearly names: nothing is brought forward on a guess.
      if (nearlyNamed(named, ids, pills).length) return notUnderstood(said);
      return world.openSession(ids[0]) ? done(ok(name)) : fail(t("Nothing running right now."));
    }
    case "show_permission_request":
      if (!world.permission()) return fail(t("No request is waiting"));
      world.showPermission();
      return null;
    case "decline_permission":
      // This sentence must say so itself: models have declined on "yeah allow it".
      if (!DECLINE_WORDS.test(normalise(said))) return notUnderstood(said);
      if (!world.permission()) return fail(t("No request is waiting"));
      world.declinePermission();
      return ok(t("Denied"));
    case "set_timer": {
      const minutes = minutesSaid(said) ?? (typeof a.minutes === "number" ? a.minutes : Number(str(a.minutes)));
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return notUnderstood(said);
      world.setTimer(minutes, str(a.label).slice(0, 80));
      return done(ok(t("Timer set: {0} min", { 0: Math.round(minutes * 10) / 10 })));
    }
    case "cancel_timer":
      return world.cancelTimer() ? done(ok(t("Timer cancelled"))) : fail(t("No timer is running"));
    case "open_app": {
      const named = str(a.name);
      if (opening) {
        // The app as the user named it first: a model turns "visual studio code" into a pill's name.
        const wanted = [openedThing(said), named].filter(Boolean);
        for (const name of wanted) {
          const result = await openNamed(name, world);
          if (result) return done(result);
        }
        // Nothing by that name: the nearest is asked about, never opened as a guess.
        const asked = heard.quiet ? null : await didYouMean(wanted[0] ?? "", said, runner, world);
        return asked ?? notFound(wanted[0] ?? "");
      }
      if (!named) return notUnderstood(said);
      // "What about Steam?" after an app was opened: the name is in the sentence.
      if (again && ` ${spoken} `.includes(` ${normalise(named)} `)) {
        const result = await openNamed(named, world);
        if (result) return done(result);
      }
      // No word for opening: what the model made of it is a guess. It is asked
      // about when it is an app near what was said, and opened only on a yes.
      if (heard.quiet) return notUnderstood(said);
      const near = heard.near ?? (await world.appsNear(said)).names;
      const app = near.find((name) => normalise(name) === normalise(named));
      return app ? runner.askOpen([app], said) : notUnderstood(said);
    }
    case "open_folder": {
      if (!opening && !again) return notUnderstood(said);
      const name = await world.openFolder(str(a.name).slice(0, 80));
      return name ? done(opened(name)) : fail(t("Not found: {0}", { 0: str(a.name).slice(0, 40) }));
    }
    case "open_url": {
      if (!opening && !again) return notUnderstood(said);
      const url = webAddress(str(a.url));
      if (!url) return notUnderstood(said);
      world.openUrl(url);
      return done(opened(new URL(url).hostname));
    }
    case "ask_user": {
      // Nothing is asked of someone who was not talking to Mochi, or before a tool has run.
      const ask = heard.ask && !heard.quiet ? askOf(a) : null;
      if (!ask || !heard.ask) return notUnderstood(said);
      const answer = await heard.ask(ask);
      heard.ran?.(call, null);
      // For the model, which goes on from the answer; a card shows it only if the model then says nothing.
      return answer.kind === "dropped" ? fail(t("OK, leaving it as is")) : ok(answerLine(ask, answer));
    }
    case "ask_which_app": {
      // Nothing is asked of someone who was not talking to Mochi.
      if (heard.quiet) return notUnderstood(said);
      // Only apps near what was said, and in Mochi's own words.
      const near = heard.near ?? [];
      const apps = strs(a.apps)
        .map((name) => near.find((known) => normalise(known) === normalise(name)))
        .filter((name): name is string => name != null);
      return apps.length ? runner.askOpen([...new Set(apps)], said) : notUnderstood(said);
    }
    default: {
      // A sample tool opens its own card: nothing is left for the voice card to say.
      if (isPreviewTool(call.name)) return openPreview(call, said, heard.quiet ? undefined : heard.ask);
      // The app's own tools: its views, its settings, a toast (voice/tools-app.ts).
      const result = await runAppCall(call, said, world.app, {
        quiet: heard.quiet,
        pillId: (name) => pillIds([name], name, pills)?.[0] ?? null,
      });
      if (result === undefined) return notUnderstood(said);
      if (result === null || result.outcome === "success") heard.ran?.(call, null);
      return result;
    }
  }
}

/** At most this many things are done for one sentence. */
const MAX_ACTIONS = 3;
/** An answer is a few sentences at most; it is shown whole, the card grows for it. */
const MAX_ANSWER = 600;

/**
 * Does what the model proposed, after the checks, and says what happened.
 * `null`: nothing to show (the user changed their mind, or a card opened).
 * Several things asked: each is done, and the first that failed is shown, else
 * the last.
 */
export async function runProposal(
  proposal: { calls: BrainCall[]; text: string },
  said: string,
  runner: VoiceRunner,
  world: VoiceWorld,
  pills: readonly PillDefinition[],
  heard: Heard = {},
): Promise<VoiceResult | null> {
  // Asked to approve: whatever the model made of it, a click decides.
  if (asksToApprove(said) && world.permission()) {
    world.showPermission();
    return null;
  }
  // A model that wrote its calls out instead of making them: they are calls all the same.
  const made = proposal.calls.length ? proposal.calls : callsWritten(proposal.text, toolNames(toolSchemas(pills, heard.near ?? [], said)));
  const calls = made.slice(0, MAX_ACTIONS);
  if (!calls.length) {
    // What is left of its plumbing is not an answer.
    if (looksLikeCall(proposal.text)) return notUnderstood(said);
    const answer = proposal.text.replace(/\s+/g, " ").trim();
    return answer ? ok(answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER - 1)}…` : answer) : notUnderstood(said);
  }
  const results: VoiceResult[] = [];
  for (const call of calls) {
    const result = await runCall(call, said, runner, world, pills, heard);
    heard.each?.(call, result);
    if (result) results.push(result);
    // A question from Mochi ("which one do I remove?") stops the rest.
    if (result?.outcome === "question") return result;
  }
  if (!results.length) return null;
  return results.find((r) => r.outcome === "failure") ?? results[results.length - 1];
}
