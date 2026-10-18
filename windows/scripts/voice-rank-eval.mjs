// Does an embedding model rank the right capability first, and where should
// the thresholds of src/voice/rank.ts sit for it? Runs the real index and the
// real `instant`, `directed` and `shortlist` against a model server on this
// machine, with a table of capabilities described the way the app's are and
// sentences said freely. A manual check, not a test: it needs a model.
//
//   node --import ./tests/setup.mjs scripts/voice-rank-eval.mjs [model] [server] [--all] [--query=…] [--text=…] [--app]
//
// `server`: http://127.0.0.1:11434 by default (Ollama; LM Studio answers the
// same on its own port). `model`: by default the first embedding model the
// server says it has. Nothing is pulled: with no embedding model installed
// the script says so and stops. `--all` prints every sentence with its three
// best. `--query=` and `--text=` are put before each sentence and each
// description: some models were trained with such a prefix ("search_query: "
// and "search_document: " for nomic-embed-text) and rank worse without.
//
// `--app`: the app's own capabilities (src/capabilities, on a fake of the
// app that lists its things), not the table below; each sentence is ranked as
// the turn ranks it, with the names the registry finds in it taken out and
// what takes their kind counted nearer (rank.ts `NAMED_BOOST`). It also
// prints the ranking at several boosts, to set that one by.
//
// The table has four kinds of sentence:
//   plain     a command or a question, with the capability that should be first
//   follow    said after another sentence, and meaning nothing without it
//   negation  says not to do something: `nothing` should be first, and what
//             matters is that tier 1 does not run what was negated
//   nobody    said to someone else in the room: for `directed` to ignore
//
// What it prints: top-1 and top-3 hit rates, the margins between the best and
// the second, how many sentences tier 1 would run rightly and wrongly at each
// margin, the best scores of sentences meant for Coucou and for nobody, and
// from those where each threshold would sit.

import {
  CapabilityIndex, CONTEXT_SHARE, DIRECTED_ACT, DIRECTED_ASK, FOLLOWS_TURN_EASE, INSTANT_MARGIN, INSTANT_SCORE, NAMED_BOOST, SHORTLIST,
  directed, indexText, instant, shortlist,
} from "../src/voice/rank.ts";
import { registerApp } from "../src/capabilities/index.ts";
import { createRegistry } from "../src/core/capabilities/registry.ts";
import { availablePills } from "../src/core/pills.ts";
import { kindsOf } from "../src/voice/turn.ts";

const FLAGS = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flag = (name) => FLAGS.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const SERVER = (ARGS[1] ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const QUERY = flag("query");
const TEXT = flag("text");
const ALL = FLAGS.includes("--all");
const APP = FLAGS.includes("--app");

// ── The capabilities ──────────────────────────────────────────────────────────

const run = async () => ({ status: "done" });
const one = (kind, description) => ({ type: "entity", kind, description });
const many = (kind, description) => ({ type: "entities", kind, description });
const text = (description) => ({ type: "string", description });
const number = (description) => ({ type: "number", description });
const cap = (name, area, tier, description, args = {}) => ({ name, area, tier, description, args, run });

/** Written the way the app's own are to be: what it does, and when it is the wrong one. */
const INVENTED = [
  cap("play_music", "music", "reversible", "Starts or resumes the music in the music app. Not for choosing a particular song."),
  cap("pause_music", "music", "reversible", "Pauses the music that is playing. Not for pausing Coucou itself."),
  cap("next_track", "music", "reversible", "Skips to the next track."),
  cap("previous_track", "music", "reversible", "Goes back to the previous track."),
  cap("now_playing", "music", "read", "Says which song is playing now and by whom. Changes nothing."),
  cap("set_music_volume", "music", "reversible", "Sets how loud the music is, from 0 to 100.", { level: number("The volume, 0 to 100.") }),
  cap("seek_music", "music", "reversible", "Moves forward or back inside the track that is playing.", { seconds: number("How far, negative to go back.") }),
  cap("add_pill", "pills", "reversible", "Adds one or more pills to the island: an agent, a service such as GitHub or Vercel, or a workspace tool.", { pills: many("pill", "The pills to add.") }),
  cap("remove_pill", "pills", "reversible", "Removes one or more pills from the island.", { pills: many("pill", "The pills to remove.") }),
  cap("set_main_pill", "pills", "reversible", "Makes one pill the main one, shown first in the island.", { pill: one("pill", "The pill.") }),
  cap("list_pills", "pills", "read", "Lists the pills the island shows now."),
  cap("service_report", "pills", "read", "Says what a service's pill reports: failed deployments, open pull requests, unread mail.", { pill: one("pill", "The service.") }),
  cap("refresh_service", "pills", "free", "Asks a service for its latest numbers now instead of waiting.", { pill: one("pill", "The service.") }),
  cap("show_view", "views", "free", "Brings one of the island's views up: chat, sessions, settings, the wardrobe, the recap.", { view: one("view", "The view.") }),
  cap("close_view", "views", "free", "Closes the view that is open and folds the island back."),
  cap("get_setting", "settings", "read", "Says what one of Coucou's settings is set to.", { setting: one("setting", "The setting.") }),
  cap("set_setting", "settings", (args) => (args.setting === "language" ? "confirm" : "reversible"), "Changes one of Coucou's settings: sounds, language, the monitor, how long it keeps listening.", { setting: one("setting", "The setting."), value: text("What to set it to.") }),
  cap("prefill_chat", "chat", "free", "Writes a message in the chat's field without sending it.", { text: text("The message.") }),
  cap("send_chat", "chat", "confirm", "Sends the message written in the chat to the agent."),
  cap("stop_chat", "chat", "free", "Stops the answer the chat's agent is writing."),
  cap("reset_chat", "chat", "confirm", "Starts a new, empty conversation in the chat."),
  cap("pick_chat_model", "chat", "reversible", "Chooses which model answers in the chat.", { model: one("model", "The model.") }),
  cap("open_conversation", "chat", "free", "Opens a past conversation of the chat.", { conversation: one("conversation", "The conversation.") }),
  cap("list_sessions", "sessions", "read", "Lists the coding agents' sessions and what each is doing: working, waiting, done."),
  cap("session_output", "sessions", "read", "Reads the last thing an agent's session wrote.", { session: one("session", "The session.") }),
  cap("show_permission", "sessions", "free", "Brings up the permission an agent is waiting for, to be allowed or declined with a click."),
  cap("decline_permission", "sessions", "confirm", "Declines the permission an agent is waiting for."),
  cap("answer_question", "sessions", "confirm", "Answers the question an agent asked on its card.", { answer: text("The answer.") }),
  cap("start_timer", "timer", "reversible", "Starts a countdown timer for some minutes.", { minutes: number("How many minutes.") }),
  cap("cancel_timer", "timer", "reversible", "Cancels the timer that is running."),
  cap("timer_left", "timer", "read", "Says how much time is left on the timer."),
  cap("open_app", "apps", "free", "Opens an application installed on this computer.", { app: one("app", "The application.") }),
  cap("open_folder", "apps", "free", "Opens a folder in the file explorer: Downloads, Documents, a project's folder.", { folder: one("folder", "The folder.") }),
  cap("web_search", "web", "free", "Searches the web for something and shows what it found.", { query: text("What to search for.") }),
  cap("pause_coucou", "app", "reversible", "Pauses Coucou itself: no sounds, no notifications, until it is resumed. Not for music."),
  cap("resume_coucou", "app", "reversible", "Resumes Coucou after it was paused."),
  cap("stop_listening", "app", "reversible", "Turns the microphone off: Coucou stops listening for its name."),
  cap("quit_coucou", "app", "confirm", "Quits the Coucou app."),
  cap("undo", "app", "free", "Puts the last thing Coucou changed back the way it was."),
  cap("show_recap", "app", "free", "Shows the recap of what the agents did today."),
  cap("change_outfit", "wardrobe", "reversible", "Dresses Mochi in another outfit.", { outfit: one("outfit", "The outfit.") }),
  cap("toggle_desktop_mochi", "wardrobe", "reversible", "Lets Mochi out to walk on the desktop, or calls it back in."),
  cap("notify", "app", "free", "Shows a short note in the island.", { text: text("The note.") }),
  cap("nothing", "app", "free", "Does nothing. For a sentence that asks for nothing, says not to do something, takes back what was just said, or was said to someone else."),
  cap("escalate", "app", "free", "Hands the sentence to a larger model. For what needs several steps, writing, or knowledge these tools do not have."),
  cap("more_tools", "app", "read", "Lists the other tools of one area of the app, when none of those shown fits.", { area: text("The area.") }),
];

// ── The app's own (--app) ─────────────────────────────────────────────────────

/** A fake of the app that only lists its things: a name the registry finds is a name the app has. */
function appRegistry() {
  const registry = createRegistry({ guard: { confirm: async () => false }, words: {} });
  const APPS = ["Spotify", "Figma", "Visual Studio Code", "Discord", "Steam", "Slack", "Google Chrome"];
  const listed = {
    pillCatalog: () => availablePills("windows").map(({ id, name, category }) => ({ id, name, category })),
    pills: () => ({ active: ["integration_github", "integration_vercel", "integration_stripe"], main: "integration_claude" }),
    sessions: () => [{ id: "integration_claude", name: "VS Code", state: "working", doing: "" }, { id: "agent_codex", name: "Codex", state: "approval", doing: "" }],
    appsNear: async (said) => APPS.filter((a) => ` ${said.toLowerCase()} `.includes(` ${a.toLowerCase()} `)).map((name) => ({ name, score: 1 })),
    folders: () => ["Downloads", "Desktop", "Documents", "Pictures"].map((name) => ({ id: name, label: name })),
    outfits: () => ["Auto (seasons)", "None", "Crown", "Party hat", "Witch hat", "Sunglasses"].map((label) => ({ id: label, label })),
    services: () => [{ id: "integration_github", name: "GitHub", line: "" }, { id: "integration_vercel", name: "Vercel", line: "" }, { id: "integration_stripe", name: "Stripe", line: "" }],
    chatModels: async () => [{ provider: "claudecode", providerName: "Claude Code", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
    conversations: async () => [{ id: "c1", title: "The relay", dir: "", updated: 0 }],
    music: () => ({ enabled: true, running: true, playing: true, shuffle: false, repeat: false, volume: 40, position: 0, track: null }),
    chat: () => ({ provider: "claudecode", model: "claude-sonnet-5-5", busy: false, draft: "", conversationId: null, messages: 0 }),
    currentView: () => ({ view: "overview", open: false }),
    mochi: () => ({ supported: true, onDesktop: false, asleep: false }),
    recapOptions: () => ({ enabled: true, hideProjects: false }),
  };
  registerApp(registry, new Proxy(listed, { get: (target, key) => target[key] ?? (() => []) }));
  return registry;
}

/** The invented table's capabilities, as the app names them; several when more than one is right. */
const AS_APP = {
  add_pill: ["add_pills"], remove_pill: ["remove_pills"], prefill_chat: ["prepare_chat_message"], send_chat: ["send_chat_message"],
  reset_chat: ["new_chat"], session_output: ["read_session_output"], show_permission: ["show_waiting_card", "read_permission_request"],
  answer_question: ["answer_agent_question"], start_timer: ["set_timer"], timer_left: ["read_timer"], web_search: ["web_search", "open_web_search"],
  show_recap: ["read_recap", "show_view"], change_outfit: ["wear_outfit"], toggle_desktop_mochi: ["mochi_to_desktop", "mochi_come_home"],
  // The app has no such capability: the sentence is left out.
  close_view: [],
};
const REGISTRY = APP ? appRegistry() : null;
const CAPABILITIES = REGISTRY ? REGISTRY.all() : INVENTED;

// ── The sentences ─────────────────────────────────────────────────────────────

const wants = (want) => (APP ? (AS_APP[want] ?? [want]) : [want]);
const plain = (want, ...says) => says.map((say) => ({ kind: "plain", say, want, wants: wants(want) }));
const follow = (want, after, say) => ({ kind: "follow", say, after, want, wants: wants(want) });
const negation = (...says) => says.map((say) => ({ kind: "negation", say, want: "nothing", wants: ["nothing"] }));
const nobody = (say, after) => ({ kind: "nobody", say, after, want: "nothing", wants: ["nothing"] });

const TABLE = [
  ...plain("pause_music", "pause", "pause the music", "hold the song for a second", "can you stop the music"),
  ...plain("play_music", "play", "resume the music", "put the music back on"),
  ...plain("next_track", "next song", "skip this one", "I don't like this track, next"),
  ...plain("previous_track", "go back one song", "play the last one again"),
  ...plain("now_playing", "what's playing", "what song is this", "who sings this"),
  ...plain("set_music_volume", "turn the music down a bit", "music volume to thirty"),
  ...plain("seek_music", "skip ahead thirty seconds"),
  ...plain("add_pill", "add GitHub", "add the Vercel pill", "put Notion and Resend in the island", "I want to see Stripe up there"),
  ...plain("remove_pill", "remove Stripe", "get rid of the Linear pill", "take Sentry off"),
  ...plain("set_main_pill", "make Codex the main one", "put Claude first"),
  ...plain("list_pills", "which pills do I have", "what's in the island right now"),
  ...plain("service_report", "any failed deployments on Vercel", "how many pull requests are open", "do I have unread mail"),
  ...plain("refresh_service", "refresh GitHub", "check Vercel again now"),
  ...plain("show_view", "show me the chat", "open settings", "bring up the sessions", "let me see the wardrobe"),
  ...plain("close_view", "close this", "fold the island back"),
  ...plain("get_setting", "is the sound on", "what language are you set to"),
  ...plain("set_setting", "mute the sounds", "set the language to French", "keep listening for fifteen seconds after a command"),
  ...plain("prefill_chat", "write fix the failing test in the chat", "draft a message asking Claude to rebase"),
  ...plain("send_chat", "send it", "send that message to the agent"),
  ...plain("stop_chat", "stop answering", "stop generating"),
  ...plain("reset_chat", "start a new chat", "clear the conversation"),
  ...plain("pick_chat_model", "use the bigger model in the chat", "switch the chat to Gemini"),
  ...plain("open_conversation", "open yesterday's conversation about the relay"),
  ...plain("list_sessions", "what are my agents doing", "is Claude done yet", "which sessions are waiting"),
  ...plain("session_output", "what did Codex just say", "read me the last output of the relay session"),
  ...plain("show_permission", "what is Claude asking for", "show me the permission", "allow it"),
  ...plain("decline_permission", "decline it", "deny that permission", "refuse what Codex wants"),
  ...plain("answer_question", "tell it the second option", "answer yes to its question"),
  ...plain("start_timer", "set a timer for ten minutes", "count down five minutes"),
  ...plain("cancel_timer", "cancel the timer", "stop the countdown"),
  ...plain("timer_left", "how long is left on the timer"),
  ...plain("open_app", "open Spotify", "launch Figma", "start Visual Studio Code"),
  ...plain("open_folder", "open my downloads", "show me the documents folder"),
  ...plain("web_search", "search the web for tauri tray icons", "look up the weather in Lyon"),
  ...plain("pause_coucou", "pause Coucou", "be quiet for a while", "do not disturb"),
  ...plain("resume_coucou", "resume Coucou", "you can come back now"),
  ...plain("stop_listening", "stop listening", "turn the microphone off"),
  ...plain("quit_coucou", "quit Coucou", "close the app"),
  ...plain("undo", "undo that", "put it back the way it was"),
  ...plain("show_recap", "what happened today", "show me the recap"),
  ...plain("change_outfit", "put the wizard hat on", "dress Mochi as a pirate"),
  ...plain("toggle_desktop_mochi", "let Mochi out on the desktop", "call Mochi back in"),
  ...plain("escalate", "look at the three failing sessions, work out what they have in common and write me a plan"),

  follow("add_pill", "add GitHub", "and Vercel too"),
  follow("remove_pill", "remove Stripe", "Linear as well"),
  follow("next_track", "next song", "again"),
  follow("open_app", "open Spotify", "and Discord"),
  follow("set_music_volume", "turn the music down a bit", "a little more"),
  follow("show_view", "show me the chat", "now the sessions"),
  follow("start_timer", "set a timer for ten minutes", "make it fifteen"),
  follow("undo", "remove Stripe", "no wait, put it back"),

  ...negation(
    "don't pause", "don't pause the music", "never mind the music", "do not skip this song", "don't remove Stripe",
    "leave GitHub where it is", "no need to open Spotify", "don't stop listening", "never mind", "forget it",
    "I wasn't talking about the timer", "please don't quit", "not the chat", "don't decline it",
  ),

  nobody("did you call the dentist back"),
  nobody("I'll have the pasta, thanks"),
  nobody("yeah give me a second I'm in the middle of something"),
  nobody("the meeting got moved to Thursday"),
  nobody("can you pass me that cable"),
  nobody("honestly I think we should rewrite the whole thing"),
  nobody("what time does the train leave"),
  nobody("that song was on the radio all summer", "pause the music"),
  nobody("did you see the pull request he opened", "add GitHub"),
  nobody("he said the timer on the oven is broken", "set a timer for ten minutes"),
  nobody("no I mean the other Stripe, the clothes shop", "remove Stripe"),
  nobody("hang on, someone's at the door", "open Spotify"),
];

/** Those the app can answer: with --app, a sentence for a capability it has no twin of is left out. */
const CASES = TABLE.filter((c) => c.wants.length > 0);

// ── The model server ──────────────────────────────────────────────────────────

async function json(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * The models the server has, each with whether it is an embedding model when
 * the server says. Ollama says it in `capabilities`, LM Studio in `type`; the
 * plain OpenAI list says nothing, and there a model is taken for one only by
 * its id.
 */
async function installed() {
  const ollama = await json(`${SERVER}/api/tags`);
  if (Array.isArray(ollama?.models)) {
    return ollama.models.map((m) => ({ id: m.name, embeds: Array.isArray(m.capabilities) ? m.capabilities.includes("embedding") : /embed/i.test(m.name) }));
  }
  const studio = await json(`${SERVER}/api/v0/models`);
  if (Array.isArray(studio?.data)) return studio.data.map((m) => ({ id: m.id, embeds: m.type === "embeddings" }));
  const openai = await json(`${SERVER}/v1/models`);
  if (Array.isArray(openai?.data)) return openai.data.map((m) => ({ id: m.id, embeds: /embed/i.test(m.id) }));
  return null;
}

const models = await installed();
if (!models) {
  console.log(`No model server answered at ${SERVER}.`);
  process.exit(1);
}
const MODEL = ARGS[0] ?? models.find((m) => m.embeds)?.id;
if (!MODEL) {
  console.log(`${SERVER} has no embedding model installed (it has: ${models.map((m) => m.id).join(", ") || "none"}).`);
  console.log("Nothing is pulled from here: install one with the user's yes, then run this again. The thresholds in src/voice/rank.ts stay provisional.");
  process.exit(1);
}
if (!models.some((m) => m.id === MODEL || m.id === `${MODEL}:latest`)) {
  console.log(`${SERVER} does not have ${MODEL} (it has: ${models.map((m) => m.id).join(", ")}). Nothing is pulled.`);
  process.exit(1);
}
if (!models.find((m) => m.id === MODEL || m.id === `${MODEL}:latest`).embeds) {
  console.log(`Note: the server does not list ${MODEL} as an embedding model. Numbers from a chat model are not ones to set thresholds by.`);
}

const took = [];
/** What Rust's `voice_embed` will do: POST v1/embeddings, vectors back in order. */
async function embed(texts) {
  const started = performance.now();
  const body = await json(`${SERVER}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, input: texts }) });
  took.push(performance.now() - started);
  if (!Array.isArray(body?.data)) return null;
  return [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ── The run ───────────────────────────────────────────────────────────────────

/** What the index is given for a capability: its area and its description. */
const textOf = (capability) => (FLAGS.includes("--whole") ? `${capability.area}: ${capability.description}` : indexText(capability));
const DESCRIPTIONS = new Set(CAPABILITIES.map(textOf));
const index = new CapabilityIndex((texts) => embed(texts.map((t) => (DESCRIPTIONS.has(t) ? TEXT : QUERY) + t)));

if (!(await index.sync(CAPABILITIES.map((c) => ({ name: c.name, text: textOf(c), kinds: APP ? kindsOf(c) : [] }))))) {
  console.log(`${MODEL} did not answer POST ${SERVER}/v1/embeddings with vectors.`);
  process.exit(1);
}
const syncMs = took.splice(0).reduce((a, b) => a + b, 0);

/** Whether the capability's own rules let tier 1 run it, whatever the scores: the real `instant` on a ranking nothing can beat. */
const allowed = (name) => instant([{ name, score: 2 }, { name: "", score: -2 }], CAPABILITIES) === name;

/** What the registry finds named in a sentence, as the turn gives it to the ranking. */
async function namedIn(sentence) {
  if (!REGISTRY) return undefined;
  const named = await REGISTRY.named(sentence);
  return { kinds: [...new Set(named.map((n) => n.kind))], labels: named.map((n) => n.label) };
}
/** A ranking with another boost for what is named: the turn's scores, with the difference added. */
function boosted(ranked, named, boost) {
  if (!named?.kinds.length) return ranked;
  const takes = (name) => kindsOf(CAPABILITIES.find((c) => c.name === name) ?? { args: {} }).some((k) => named.kinds.includes(k));
  return ranked.map((r) => ({ name: r.name, score: r.score + (takes(r.name) ? boost - NAMED_BOOST : 0) })).sort((a, b) => b.score - a.score);
}

const rows = [];
const sweeps = [];
for (const c of CASES) {
  const named = await namedIn(c.say);
  const ranked = await index.rank(c.say, c.after, named);
  if (APP) sweeps.push({ c, named, ranked });
  if (!ranked) {
    console.log(`No ranking for "${c.say}": the model stopped answering.`);
    process.exit(1);
  }
  const alone = c.after ? await index.rank(c.say) : ranked;
  rows.push({
    ...c, ranked, alone,
    place: ranked.findIndex((r) => c.wants.includes(r.name)) + 1,
    best: ranked[0], margin: ranked[0].score - ranked[1].score,
    instant: instant(ranked, CAPABILITIES),
    directed: directed(ranked, { followsTurn: Boolean(c.after) }),
    shown: shortlist(ranked, CAPABILITIES).some((name) => c.wants.includes(name)),
  });
}
// The second `rank` of a follow-up is this script's own, for comparison.
const rankMs = [...took].sort((a, b) => a - b);

// ── What it prints ────────────────────────────────────────────────────────────

const f = (x) => (x === undefined || Number.isNaN(x) ? "  –  " : x.toFixed(3));
const pct = (n, of) => (of === 0 ? "–" : `${n}/${of} (${Math.round((100 * n) / of)} %)`);
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const at = (xs, q) => (xs.length === 0 ? undefined : sorted(xs)[Math.min(xs.length - 1, Math.floor(q * xs.length))]);
const spread = (xs) => `least ${f(sorted(xs)[0])}  a tenth under ${f(at(xs, 0.1))}  median ${f(at(xs, 0.5))}  most ${f(sorted(xs).at(-1))}  (${xs.length})`;
const of = (kind) => rows.filter((r) => r.kind === kind);
const line = (r) => `  ${r.place === 1 ? "✓" : "✗"} ${r.after ? `[${r.after}] ` : ""}"${r.say}" → ${r.ranked.slice(0, 3).map((x) => `${x.name} ${f(x.score)}`).join(", ")}${r.place === 1 ? "" : `   (wanted ${r.wants.join(" or ")}, placed ${r.place})`}`;

console.log(`\n${MODEL} on ${SERVER} — ${CAPABILITIES.length} capabilities, ${CASES.length} sentences`);
if (QUERY || TEXT) console.log(`prefixes: sentence "${QUERY}", description "${TEXT}"`);
console.log(`index: ${Math.round(syncMs)} ms for all descriptions; a sentence: median ${Math.round(at(rankMs, 0.5))} ms, slowest ${Math.round(rankMs.at(-1))} ms`);

console.log("\n── Ranking ──");
for (const kind of ["plain", "follow", "negation", "nobody"]) {
  const these = of(kind);
  console.log(`${kind.padEnd(9)} top-1 ${pct(these.filter((r) => r.place === 1).length, these.length).padEnd(14)} top-3 ${pct(these.filter((r) => r.place >= 1 && r.place <= 3).length, these.length).padEnd(14)} in the shortlist of ${SHORTLIST} ${pct(these.filter((r) => r.shown).length, these.length)}`);
}
const follows = of("follow");
if (APP) {
  console.log(`\nWith what is named counted nearer by (NAMED_BOOST is ${NAMED_BOOST}; 0 and no names taken out is the plain ranking below it):`);
  const plainRanked = [];
  for (const { c } of sweeps) plainRanked.push({ c, ranked: await index.rank(c.say, c.after) });
  const rate = (list, n) => list.filter(({ c, ranked }) => ranked.slice(0, n).some((r) => c.wants.includes(r.name))).length;
  const meant = (list) => list.filter(({ c }) => c.kind === "plain" || c.kind === "follow");
  const row = (label, list) => {
    const m = meant(list);
    console.log(`  ${label.padEnd(22)} top-1 ${pct(rate(m, 1), m.length).padEnd(14)} top-3 ${pct(rate(m, 3), m.length).padEnd(14)} shortlist ${pct(m.filter(({ c, ranked }) => shortlist(ranked, CAPABILITIES).some((n) => c.wants.includes(n))).length, m.length)}`);
  };
  row("names left in", plainRanked);
  for (const boost of [0, 0.03, 0.05, 0.08, 0.1, 0.15]) row(`names out, boost ${boost}`, sweeps.map(({ c, named, ranked }) => ({ c, ranked: boosted(ranked, named, boost) })));
}
console.log(`follow-ups scored alone: top-1 ${pct(follows.filter((r) => r.alone[0].name === r.want).length, follows.length)} — with their turn (a share of ${CONTEXT_SHARE}): ${pct(follows.filter((r) => r.place === 1).length, follows.length)}`);
console.log(ALL ? "\nEvery sentence:" : "\nNot first (plain and follow-ups):");
for (const r of rows) if (ALL || (r.place !== 1 && (r.kind === "plain" || r.kind === "follow"))) console.log(line(r));

// Tier 1 is right when it runs what was wanted; wrong when it runs anything
// else — and for a negation or a sentence for nobody, anything but `nothing`.
const right = (r) => r.place === 1 && (r.kind === "plain" || r.kind === "follow" || r.best.name === "nothing");
const candidates = rows.filter((r) => allowed(r.best.name));
console.log("\n── Tier 1 (instant) ──");
console.log(`margins, best over second — right and first: ${spread(rows.filter((r) => right(r)).map((r) => r.margin))}`);
console.log(`                            wrong one first: ${spread(rows.filter((r) => !right(r)).map((r) => r.margin))}`);
console.log(`                            negations:       ${spread(of("negation").map((r) => r.margin))}`);
console.log(`best scores — right and first: ${spread(rows.filter((r) => right(r)).map((r) => r.best.score))}`);
console.log(`              wrong one first: ${spread(rows.filter((r) => !right(r)).map((r) => r.best.score))}`);
console.log(`\n${candidates.length} of ${rows.length} sentences have a best that tier 1 may run at all (not confirm, nothing a model must write).`);
console.log("At each margin, with no floor on the score: run rightly / run wrongly (of which negations)");
for (let margin = 0.02; margin < 0.305; margin += 0.02) {
  const fired = candidates.filter((r) => r.margin >= margin);
  const wrong = fired.filter((r) => !right(r));
  console.log(`  ${margin.toFixed(2)}  ${String(fired.length - wrong.length).padStart(3)} / ${String(wrong.length).padStart(2)} (${wrong.filter((r) => r.kind === "negation").length})`);
}
const wrongRuns = candidates.filter((r) => !right(r));
const safeMargin = wrongRuns.length ? Math.max(...wrongRuns.map((r) => r.margin)) : 0;
const wrongAbove = wrongRuns.filter((r) => r.margin >= INSTANT_MARGIN);
console.log(`The widest margin a wrong one had: ${f(safeMargin)}. INSTANT_MARGIN is ${INSTANT_MARGIN}: it would sit above that, with room.`);
console.log(`The highest score a wrong one had among those past INSTANT_MARGIN: ${f(wrongAbove.length ? Math.max(...wrongAbove.map((r) => r.best.score)) : undefined)}. INSTANT_SCORE is ${INSTANT_SCORE}.`);
const ran = rows.filter((r) => r.instant);
console.log(`As rank.ts is now: tier 1 runs ${ran.length} sentences, ${ran.filter((r) => right(r)).length} rightly, ${ran.filter((r) => !right(r)).length} wrongly.`);
for (const r of ran.filter((r) => !right(r))) console.log(`  ✗ ran ${r.instant}: ${r.after ? `[${r.after}] ` : ""}"${r.say}" (${r.kind}, margin ${f(r.margin)})`);

console.log("\n── Without the wake phrase (directed) ──");
const meant = rows.filter((r) => r.kind === "plain" || r.kind === "follow");
const stray = of("nobody");
console.log(`best scores — meant for Coucou:        ${spread(meant.map((r) => r.best.score))}`);
console.log(`              follow-ups, with a turn: ${spread(follows.map((r) => r.best.score))}`);
console.log(`              for nobody:              ${spread(stray.filter((r) => !r.after).map((r) => r.best.score))}`);
console.log(`              for nobody, after a turn: ${spread(stray.filter((r) => r.after).map((r) => r.best.score))}`);
console.log(`              negations:               ${spread(of("negation").map((r) => r.best.score))}`);
const highestStray = Math.max(...stray.map((r) => r.best.score));
console.log(`DIRECTED_ASK is ${DIRECTED_ASK}: to ignore every sentence for nobody it would sit just above ${f(highestStray)}, which would also ignore ${pct(meant.filter((r) => r.best.score <= highestStray).length, meant.length)} of those meant for Coucou.`);
console.log(`DIRECTED_ACT is ${DIRECTED_ACT}: a tenth of those meant for Coucou score under ${f(at(meant.map((r) => r.best.score), 0.1))}, half under ${f(at(meant.map((r) => r.best.score), 0.5))}.`);
console.log(`FOLLOWS_TURN_EASE is ${FOLLOWS_TURN_EASE}; CONTEXT_SHARE is ${CONTEXT_SHARE}: compare the two "for nobody" lines with the follow-ups' to see whether a turn before helps the right ones more than the strays.`);
console.log("As rank.ts is now (plain sentences are judged as if no turn came before):");
for (const kind of ["plain", "follow", "negation", "nobody"]) {
  const these = of(kind);
  const count = (band) => these.filter((r) => r.directed === band).length;
  console.log(`  ${kind.padEnd(9)} act ${String(count("act")).padStart(3)}   ask ${String(count("ask")).padStart(3)}   ignore ${String(count("ignore")).padStart(3)}`);
}
console.log("");
