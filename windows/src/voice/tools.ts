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
import type { VoiceIntent } from "./intent";
import type { VoiceResult, VoiceRunner } from "./runner";

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
  openFolder(name: string): Promise<string | null>;
  openUrl(url: string): void;
  /** What is playing, for questions about it. */
  nowPlaying(): string | null;
  /** One line per service about what it last reported (CI, plan usage…). */
  reports(): Record<string, string>;
}

const ok = (message: string): VoiceResult => ({ outcome: "success", message });
const fail = (message: string): VoiceResult => ({ outcome: "failure", message });

// ── What the model is given ───────────────────────────────────────────────────

const MUSIC_ACTIONS = ["play", "pause", "next", "previous", "shuffle_on", "shuffle_off", "repeat_on", "repeat_off"] as const;

function fn(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

/** The tools, in the OpenAI format every local server speaks. Pill names are the catalog's. */
export function toolSchemas(pills: readonly PillDefinition[]): unknown[] {
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
    fn("nothing", "The user changed their mind, or what was heard is not a request."),
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

export function systemPrompt(state: unknown): string {
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
    `State: ${JSON.stringify(state)}`,
  ].join("\n");
}

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
  for (let size = 1; size <= 3; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const window = words.slice(i, i + size);
      if (resolvePill(window.join(" "), pills) === id || resolvePill(window.join(""), pills) === id) return true;
    }
  }
  return false;
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

/** Whether the model made anything of the sentence: false for "not recognised". */
export const understood = (result: VoiceResult, said: string) => result.message !== notUnderstood(said).message;

/** One call, checked and done. `null`: the user changed their mind — nothing to show. */
async function runCall(
  call: BrainCall,
  said: string,
  runner: VoiceRunner,
  world: VoiceWorld,
  pills: readonly PillDefinition[],
): Promise<VoiceResult | null> {
  const a = call.arguments ?? {};
  const intent = intentOf(call, said, pills);
  if (intent) return runner.run(intent, said);

  switch (call.name) {
    case "nothing":
      return null;
    case "open_session": {
      const ids = pillIds(strs(a.agent), said, pills);
      if (!ids) return notUnderstood(said);
      const name = pills.find((p) => p.id === ids[0])?.name ?? ids[0];
      return world.openSession(ids[0]) ? ok(name) : fail(t("Nothing running right now."));
    }
    case "show_permission_request":
      if (!world.permission()) return fail(t("No request is waiting"));
      world.showPermission();
      return null;
    case "decline_permission":
      // The sentence must say so itself: models have declined on "yeah allow it".
      if (!DECLINE_WORDS.test(normalise(said))) return notUnderstood(said);
      if (!world.permission()) return fail(t("No request is waiting"));
      world.declinePermission();
      return ok(t("Denied"));
    case "set_timer": {
      const minutes = minutesSaid(said) ?? (typeof a.minutes === "number" ? a.minutes : Number(str(a.minutes)));
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return notUnderstood(said);
      world.setTimer(minutes, str(a.label).slice(0, 80));
      return ok(t("Timer set: {0} min", { 0: Math.round(minutes * 10) / 10 }));
    }
    case "cancel_timer":
      return world.cancelTimer() ? ok(t("Timer cancelled")) : fail(t("No timer is running"));
    case "open_app": {
      if (!OPEN_WORDS.test(normalise(said))) return notUnderstood(said);
      // The app as the user named it first: a model turns "visual studio code" into a pill's name.
      const wanted = [openedThing(said), str(a.name)].map((n) => n.slice(0, 80)).filter(Boolean);
      for (const name of wanted) {
        const opened = await world.openApp(name);
        if (opened) return ok(t("{0} opened", { 0: opened }));
      }
      return fail(t("Not found: {0}", { 0: (wanted[0] ?? "").slice(0, 40) }));
    }
    case "open_folder": {
      if (!OPEN_WORDS.test(normalise(said))) return notUnderstood(said);
      const opened = await world.openFolder(str(a.name).slice(0, 80));
      return opened ? ok(t("{0} opened", { 0: opened })) : fail(t("Not found: {0}", { 0: str(a.name).slice(0, 40) }));
    }
    case "open_url": {
      if (!OPEN_WORDS.test(normalise(said))) return notUnderstood(said);
      const url = webAddress(str(a.url));
      if (!url) return notUnderstood(said);
      world.openUrl(url);
      return ok(t("{0} opened", { 0: new URL(url).hostname }));
    }
    default:
      return notUnderstood(said);
  }
}

/** At most this many things are done for one sentence. */
const MAX_ACTIONS = 3;
/** A spoken answer is a sentence, not a page. */
const MAX_ANSWER = 160;

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
): Promise<VoiceResult | null> {
  // Asked to approve: whatever the model made of it, a click decides.
  if (asksToApprove(said) && world.permission()) {
    world.showPermission();
    return null;
  }
  const calls = proposal.calls.slice(0, MAX_ACTIONS);
  if (!calls.length) {
    const answer = proposal.text.replace(/\s+/g, " ").trim();
    return answer ? ok(answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER - 1)}…` : answer) : notUnderstood(said);
  }
  const results: VoiceResult[] = [];
  for (const call of calls) {
    const result = await runCall(call, said, runner, world, pills);
    if (result) results.push(result);
    // A question from Mochi ("which one do I remove?") stops the rest.
    if (result?.outcome === "question") return result;
  }
  if (!results.length) return null;
  return results.find((r) => r.outcome === "failure") ?? results[results.length - 1];
}
