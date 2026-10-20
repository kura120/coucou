// How often does voice do the right thing for a sentence said freely? Runs the
// real turn (src/voice/turn.ts) over the app's real declarations
// (src/capabilities) and the real executor, against a model server on this
// machine and a fake of the app. A manual check, not a test: it needs a model
// and its answers vary.
//
//   node --import ./tests/setup.mjs scripts/voice-eval.mjs [models] [server] [--words] [--path=areas|ranked|both] [--embed=model] [--only=text] [--trace] [--context=full|lean]
//
// `models`: one, or several separated by commas, each run on the whole table.
// Default: qwen2.5:7b-instruct on http://127.0.0.1:11434 (Ollama). Nothing is
// pulled: a model the server does not have is skipped.
//
// The ranked path (an embedding model ranks the capabilities: a clear command
// runs with no model, and the local model is shown the nearest few). Voice
// requires an embedding model since 2026-10-18; "areas" (none) now only shows
// that it says so. The ranked path runs only
// when the server has an embedding model; `--embed` names it. `--only` runs
// the cases with that text in a step (several: a|b); `--trace` prints each call to the
// model: the tools it was shown, and what it called or said.
//
// A case is steps and what must have happened. A step is a sentence said
// after the wake phrase; `{ said, sure }`, with how sure the speech model was
// of each word; `{ again }`, a sentence said without the wake phrase;
// `{ click }`, an answer clicked on the question on screen; or
// `{ confirm: true }`, which clicks yes on the next confirmation toast — with
// none, every toast is left unclicked. A sentence said while a question is up
// is its answer, read as the island reads it.
//
// "Dangerous" counts what a `confirm` capability did without its click. It
// must be zero whatever the model said: that is the executor's doing.
//
// Nothing said here is written anywhere but this terminal.

import { registerApp } from "../src/capabilities/index.ts";
import { createRegistry } from "../src/core/capabilities/registry.ts";
import { availablePills } from "../src/core/pills.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { heardWith, sureOf, UNSURE_WORD } from "../src/voice/resolve.ts";
import { VoiceTurns } from "../src/voice/turn.ts";

// Names learned from the user's answers (core/capabilities/names.ts), when this build has them.
const { createLearnedNames } = await import("../src/core/capabilities/names.ts").catch(() => ({}));

const FLAGS = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const flag = (name) => FLAGS.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const MODELS = (ARGS[0] ?? "qwen2.5:7b-instruct").split(",").map((m) => m.trim()).filter(Boolean);
let MODEL = MODELS[0];
const SERVER = (ARGS[1] ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const WORDS = FLAGS.includes("--words");
// Voice requires an embedding model now: "areas" measures only that it says so.
const PATH = flag("path") ?? "ranked";
// "full": the app's state is told every time; "lean": only the screen and the last change, the rest looked up (find).
const CONTEXT = flag("context") === "lean" ? "lean" : "full";
const ONLY = flag("only");
const TRACE = FLAGS.includes("--trace");

// ── A fake of the app ─────────────────────────────────────────────────────────

const PILLS = availablePills("windows");
const short = (id) => id.replace(/^(integration|agent|ai)_/, "");
/** What is installed, as Rust's lookup would find it by name. */
const APPS = ["Figma", "Visual Studio Code", "Discord", "Spotify", "Steam", "Slack", "Notepad", "Calculator", "Google Chrome", "Terminal", "Claude"];
const FOLDERS = ["Downloads", "Desktop", "Documents", "Pictures"];
/** What a speech model wrote for a name, and the apps Rust's `near` ranks for it (voice/apps.rs has the real one, and its tests). */
const HEARD_AS = {
  "spy flight": ["Spotify"], "this squad": ["Discord"], "the squad": ["Discord"], "steem": ["Steam"], "visual studio": ["Visual Studio Code"],
  "st": ["Spotify", "Steam", "Slack"], "this cord": ["Discord"],
};
/** What Rust's `find` takes for an app by its sound alone. */
const FOUND_AS = { "this cord": "Discord" };
const plain = (said) => said.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** What only a click may do: seen in the log without one, it is the executor that failed. */
const CLICKED_ONLY = (entry) => ["DECLINE", "ANSWER", "SEND", "QUIT"].includes(entry) || /^set:(language|autostart|screen|claudeCodeMode|searchEngine|voice\.(wake|hearingModel|brain|embedModel|cloud|webAnswers|webSearch))=/.test(entry);

const read = (object, key) => key.split(".").reduce((at, part) => at?.[part], object);
function write(object, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  parts.reduce((at, part) => at[part], object)[last] = value;
}

function setup() {
  const log = [];
  const s = {
    playing: true, shuffle: true, repeat: true, volume: 40,
    active: ["integration_github", "integration_vercel", "integration_stripe", "integration_n8n"], main: "integration_claude",
    permission: { agent: "Codex", request: "Bash: rm -rf dist" },
    timer: null, view: { view: "overview", open: false },
    settings: structuredClone(DEFAULT_SETTINGS),
    chat: { provider: "claudecode", model: "claude-sonnet-5-5", busy: false, draft: "", conversationId: null, messages: 0 },
    outfit: "auto", paused: false,
    /** Confirmation toasts to click yes on; any other is left unclicked. */
    yes: 0, clicked: 0,
  };
  // What the user turned on for this run: a web question may be answered.
  s.settings.voice.webAnswers = true;
  const host = {
    music: () => ({ enabled: true, running: true, playing: s.playing, shuffle: s.shuffle, repeat: s.repeat, volume: s.volume, position: 42, track: { title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", duration: 248 } }),
    musicControl: async (action, value) => {
      if (action === "playPause") {
        s.playing = !s.playing;
        log.push(s.playing ? "play" : "pause");
      } else if (action === "shuffle" || action === "repeat") {
        s[action] = value === 1;
        log.push(`${action}:${value === 1}`);
      } else if (action === "volume") {
        s.volume = value;
        log.push(`volume:${value}`);
      } else log.push(action === "seek" ? `seek:${value}` : action);
      return true;
    },
    openMusic: async () => (log.push("open-spotify"), true),

    pillCatalog: () => PILLS.map(({ id, name, category }) => ({ id, name, category })),
    pills: () => ({ active: [...s.active], main: s.main }),
    pillFits: () => s.active.length < 6,
    pillLimit: () => 6,
    togglePill(id) {
      const on = !s.active.includes(id);
      s.active = on ? [...s.active, id] : s.active.filter((x) => x !== id);
      log.push(`${on ? "+" : "-"}${short(id)}`);
    },
    setMainPill(id) {
      s.main = id;
      s.active = s.active.filter((x) => x !== id);
      log.push(`main:${short(id)}`);
    },

    sessions: () => [
      { id: "integration_claude", name: "VS Code", state: "working", doing: "running the test suite in coucou" },
      { id: "agent_codex", name: "Codex", state: "approval", doing: "wants to run: rm -rf dist" },
    ],
    openSession: (id) => (log.push(`session:${short(id)}`), true),
    sessionOutput: () => ["Read src/main.ts", "Ran npm test", "41 tests pass, 2 fail in voice.test.mjs"],

    permission: () => s.permission,
    agentQuestion: () => null,
    showWaitingCard: () => (log.push("card"), true),
    declinePermission: () => (log.push("DECLINE"), (s.permission = null), true),
    answerAgentQuestion: () => (log.push("ANSWER"), true),

    timer: () => s.timer,
    setTimer: (minutes, label) => (log.push(`timer:${minutes}`), void (s.timer = { label, minutesLeft: minutes })),
    cancelTimer: () => (s.timer ? (log.push("timer:cancel"), (s.timer = null), true) : false),

    apps: async () => [],
    // As Rust's `voice_apps_near` through the island's host: the app the name is, then the ones near it.
    appsNear: async (said) => {
      const words = ` ${plain(said)} `;
      const found = APPS.find((a) => ` ${a.toLowerCase()} ` === words) ?? FOUND_AS[words.trim()] ?? null;
      const near = APPS.filter((a) => words.includes(` ${a.toLowerCase()} `)).map((name) => ({ name, score: 1 }));
      for (const [heard, apps] of Object.entries(HEARD_AS)) {
        if (!words.includes(` ${heard} `)) continue;
        for (const name of apps) if (!near.some((n) => n.name === name)) near.push({ name, score: 0.8 });
      }
      return found ? [{ name: found, score: 1 }, ...near.filter((n) => n.name !== found)].slice(0, 3) : near.slice(0, 3);
    },
    openApp: async (name) => {
      const app = APPS.find((a) => a.toLowerCase() === plain(name));
      if (app) log.push(`app:${app.toLowerCase()}`);
      return app ? { name: app, seen: true } : null;
    },
    folders: () => FOLDERS.map((name) => ({ id: name, label: name })),
    openFolder: async (id) => (log.push(`folder:${id.toLowerCase()}`), id),
    openUrl: (url) => (log.push(`url:${new URL(url).hostname.replace(/^www\./, "")}`), true),

    currentView: () => ({ ...s.view }),
    showView: (view) => (log.push(`view:${view}`), (s.view = { view, open: true }), true),

    setting: (key) => read(s.settings, key),
    setSetting: async (key, value) => (log.push(`set:${key}=${value}`), write(s.settings, key, value), true),
    languages: () => [{ value: "", label: "System" }, { value: "en", label: "English" }, { value: "fr", label: "Français" }, { value: "es", label: "Español" }],
    monitors: async () => [{ value: "primary", label: "Main display" }, { value: "cursor", label: "Display under the cursor" }],
    hearingModels: async () => [{ value: "moonshine-tiny", label: "Moonshine Tiny" }, { value: "parakeet-0.6b", label: "Parakeet 0.6B" }],
    embedModels: async () => [{ value: "", label: "None" }, { value: "nomic-embed-text", label: "nomic-embed-text" }],

    chat: () => ({ ...s.chat }),
    prepareChat: (message) => (log.push("chat:prepare"), (s.chat.draft = message), true),
    sendChat: async () => (log.push("SEND"), (s.chat.draft = ""), true),
    stopChat: () => false,
    resetChat: async () => (log.push("chat:new"), true),
    chatModels: async () => [
      { provider: "claudecode", providerName: "Claude Code", id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { provider: "ollama", providerName: "Ollama", id: "qwen2.5:7b-instruct", label: "qwen2.5:7b-instruct" },
    ],
    setChatModel: async (provider, model) => (log.push(`chat:model:${model}`), Object.assign(s.chat, { provider, model }), true),
    conversations: async () => [{ id: "c1", title: "Fix the build", dir: "C:/dev/coucou", updated: 1_790_000_000 }],
    openConversation: async (id) => (log.push(`chat:open:${id}`), true),

    outfits: () => [{ id: "auto", label: "Auto (seasons)" }, { id: "none", label: "None" }, { id: "crown", label: "Crown" }, { id: "partyHat", label: "Party hat" }, { id: "sunglasses", label: "Sunglasses" }],
    outfit: () => s.outfit,
    wearOutfit: (id) => (log.push(`wear:${id}`), (s.outfit = id), true),

    recapOptions: () => ({ enabled: true, hideProjects: false }),
    recapLines: async () => ["12 sessions", "9 h 20 coding", "busiest day: Tuesday", "top agent: Claude Code"],
    setRecapOption: async (option, on) => (log.push(`recap:${option}=${on}`), true),

    mochi: () => ({ supported: true, onDesktop: false, asleep: false }),
    mochiFlyOut: async () => (log.push("mochi:out"), true),
    mochiFlyHome: async () => (log.push("mochi:home"), true),
    setMochiAsleep: () => false,

    services: () => [{ id: "integration_github", name: "GitHub", line: "main: passing, 2 open pull requests" }, { id: "integration_vercel", name: "Vercel", line: "last deploy 4 minutes ago" }],
    serviceInfo: (id) => (id === "integration_github" ? ["main: passing", "2 open pull requests"] : ["last deploy 4 minutes ago"]),
    refreshService: async (id) => (log.push(`refresh:${short(id)}`), true),

    webSearch: async () => (log.push("search"), { results: [{ title: "Centering in CSS", url: "https://example.org/center", snippet: "Use display: grid and place-items: center on the parent." }] }),
    openWebSearch: () => (log.push("browse"), true),

    listening: () => s.settings.voice.enabled,
    stopListening: () => void (log.push("voice-off"), (s.settings.voice.enabled = false)),
    paused: () => s.paused,
    setPaused: (on) => void (log.push(on ? "paused" : "resumed"), (s.paused = on)),
    quit: () => void log.push("QUIT"),
    notify: () => void log.push("note"),
  };
  const registry = createRegistry({
    // A click on the toast: only when the case says there is one.
    guard: {
      confirm: async (confirm) => {
        log.push(`confirm:${confirm.title}`);
        if (s.yes <= 0) return false;
        s.yes -= 1;
        s.clicked += 1;
        return true;
      },
    },
    words: {
      refused: () => "I can't do that", unavailable: () => "That isn't possible right now", failed: () => "That did not work",
      notFound: (said) => `Not found: ${said}`, unchanged: () => "OK, leaving it as is", nothingToUndo: () => "There is nothing to put back",
      one: (label) => `Did you mean ${label}?`, which: (labels) => `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}?`,
    },
    doubted: (said) => (sureOf(said) ?? 1) < UNSURE_WORD,
    // Learned for this case only: each case starts with nothing learned.
    ...(createLearnedNames ? { names: createLearnedNames() } : {}),
  });
  registerApp(registry, host);
  registry.screen(() => ({ view: "overview", subjects: [{ kind: "session", id: "integration_claude", label: "VS Code" }], summary: "VS Code (working): running the test suite in coucou" }));
  return { log, s, registry };
}

// ── The model server ──────────────────────────────────────────────────────────

/** The limits of src-tauri/src/voice/brain.rs: what goes past them is refused there, so it is here. */
const MAX_SYSTEM = 16 * 1024;
const MAX_TOOLS = 48 * 1024;
const MAX_CALLS = 6;
const MAX_STEP_RESULT = 1200;

/** The earlier turns as messages: what brain.rs `messages` and `with_steps` build. */
function messages(system, history, said, steps = []) {
  const list = [{ role: "system", content: system }];
  history.slice(-6).forEach((turn, t) => {
    list.push({ role: "user", content: turn.said });
    if (!turn.calls.length) {
      if (turn.result) list.push({ role: "assistant", content: turn.result.slice(0, 240) });
      return;
    }
    const calls = turn.calls.slice(0, 3);
    list.push({
      role: "assistant", content: "",
      tool_calls: calls.map((c, i) => ({ id: `call_${t}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
    });
    calls.forEach((_, i) => list.push({ role: "tool", tool_call_id: `call_${t}_${i}`, content: turn.result.slice(0, 240) || "Done." }));
  });
  list.push({ role: "user", content: said });
  steps.slice(0, 5).forEach((step, s) => {
    if (!step.calls.length) return;
    const calls = step.calls.slice(0, MAX_CALLS);
    list.push({
      role: "assistant", content: "",
      tool_calls: calls.map((c, i) => ({ id: `step_${s}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
    });
    calls.forEach((_, i) => list.push({ role: "tool", tool_call_id: `step_${s}_${i}`, content: (step.results[i] || "No result.").slice(0, MAX_STEP_RESULT) }));
  });
  return list;
}

/** For each turn where something ran and a model worded it: whether the words held up (voice/turn.ts `grounded`). */
const worded = [];
/** How many times the model was asked, and how long each took. */
const rounds = [];
/** How many tokens each request to the model weighed, as the server counted them: against its context. */
const prompts = [];
let refusedBySize = 0;

async function local(system, said, tools, history = [], steps = []) {
  if (system.length > MAX_SYSTEM || JSON.stringify(tools).length > MAX_TOOLS || said.length > 600) {
    refusedBySize += 1;
    return null;
  }
  if (process.env.VOICE_EVAL_DUMP) {
    const { writeFileSync } = await import("node:fs");
    // Each call to the model in its own pair of files, numbered: what one round was given can be sent again by hand.
    writeFileSync(`${process.env.VOICE_EVAL_DUMP}/system-${rounds.length}.txt`, system);
    writeFileSync(`${process.env.VOICE_EVAL_DUMP}/tools-${rounds.length}.json`, JSON.stringify(tools));
    writeFileSync(`${process.env.VOICE_EVAL_DUMP}/messages-${rounds.length}.json`, JSON.stringify(messages(system, history, said, steps)));
  }
  const began = performance.now();
  // On Ollama, its own chat API: the OpenAI one ignores the context size, and a prompt cut at 4096 loses the instructions.
  // 8192 is brain.rs's VOICE_CONTEXT. That API takes a tool call's arguments as an object, not a string.
  const ollama = tags.length > 0;
  const request = () =>
    fetch(`${SERVER}/${ollama ? "api/chat" : "v1/chat/completions"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No thinking, as the app asks (src-tauri/src/voice/brain.rs).
      body: JSON.stringify(
        ollama
          ? {
              model: MODEL, stream: false, think: false, tools,
              messages: messages(system, history, said, steps).map((m) =>
                m.tool_calls ? { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, function: { ...c.function, arguments: JSON.parse(c.function.arguments) } })) } : m),
              options: { temperature: 0, num_ctx: 8192 },
            }
          : { model: MODEL, temperature: 0, stream: false, reasoning_effort: "none", tools, messages: messages(system, history, said, steps) },
      ),
    });
  // A server that is being restarted, or is busy with another session's model: once more, a little later.
  const reply = await request().catch(() => new Promise((resolve) => setTimeout(resolve, 5000)).then(request));
  rounds.push(performance.now() - began);
  const answer = await reply.json();
  const weighed = answer.usage?.prompt_tokens ?? answer.prompt_eval_count;
  if (typeof weighed === "number") prompts.push(weighed);
  const message = answer.choices?.[0]?.message ?? answer.message ?? {};
  const calls = (message.tool_calls ?? []).slice(0, MAX_CALLS).map((c) => {
    let args = c.function?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { name: c.function?.name ?? "", arguments: args };
  });
  const text = (message.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (TRACE) {
    const answered = calls.length ? calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(" ") : JSON.stringify(text);
    console.log(`    model <- ${JSON.stringify(said)} [${tools.map((t) => t.function.name).join(",")}]\n          -> ${answered}`);
  }
  return { calls, text };
}

let EMBED = "";
/** The server's embedding model, or nothing: the "areas" path. */
async function embed(texts) {
  if (!EMBED) return null;
  const reply = await fetch(`${SERVER}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED, input: texts }),
  }).catch(() => null);
  const data = reply?.ok ? (await reply.json()).data : null;
  return Array.isArray(data) && data.length === texts.length ? data.map((d) => d.embedding) : null;
}

// ── A case, driven as the island drives a turn ────────────────────────────────

const TURN_WORDS = {
  noModel: () => "Voice needs a model server.", silent: () => "The model did not answer.",
  noEmbedding: () => "Voice needs an embedding model.", embedSilent: () => "The embedding model did not answer.",
  notUnderstood: () => "Command not recognised", beyond: () => "That is more than I can do here.", askingCloud: () => "Asking a bigger model…",
  pardon: () => "Sorry, I didn't catch that. Say it again?",
};

async function run(steps) {
  const { log, s, registry } = setup();
  // The model server here is this computer: a sentence without the wake phrase may be given to it.
  const turns = new VoiceTurns({ registry, embed, local: () => local, cloud: () => null, followUp: () => true, words: TURN_WORDS, context: () => CONTEXT });
  /** The turn that waits on a question, and who is told when one goes up. */
  let turn = null;
  let up = () => {};
  /** Once the steps are over, a question that still goes up is for nobody: dropped, as when the island closes. */
  let over = false;
  turns.onAsk = (ask) => {
    if (TRACE) console.log(`    asks ${ask ? JSON.stringify(ask.question) : "no more"}`);
    if (ask && over) queueMicrotask(() => turns.answer({ kind: "dropped" }));
    else if (ask) up(ask);
  };
  /** The turn's end, or the question it stopped on. */
  const shown = async () => {
    const question = new Promise((resolve) => (up = resolve));
    if (turns.asked) up(turns.asked);
    const came = await Promise.race([turn.then((heard) => ({ heard })), question.then((ask) => ({ ask }))]);
    if ("ask" in came) return { asks: came.ask.question };
    turn = null;
    // Whether the model's words for what ran held up against the results.
    if (came.heard.worded != null) worded.push(came.heard.worded || came.heard.unworded || "empty");
    // Said in place of an answer, and a request of its own: heard at once, as the island does.
    if (came.heard.next) {
      turn = turns.hear(came.heard.next);
      return shown();
    }
    return came.heard;
  };
  const taken = [];
  let last = null;
  for (const step of steps) {
    if (step.confirm) {
      s.yes += 1;
      continue;
    }
    const before = rounds.length;
    const started = performance.now();
    if (step.click) {
      if (turn && turns.answer(step.click)) last = await shown();
    } else {
      const said = typeof step === "string" ? step : (step.said ?? step.again);
      heardWith(said, step.sure ?? null);
      if (turn && turns.asked) {
        // A question is up: this is its answer, read by the model — or words for its field.
        const heard = await turns.answerSaid(said);
        last = heard.is === "answer" ? await shown() : { asks: turns.asked?.question ?? "" };
      } else {
        turn = turns.hear(said, { wake: step.again == null, sure: step.sure });
        last = await shown();
      }
    }
    taken.push({ models: rounds.length - before, ms: performance.now() - started });
  }
  // A question nobody answered is dropped, as when the island closes.
  if (turn) {
    over = true;
    turns.answer({ kind: "dropped" });
    await turn;
  }
  const unclicked = log.filter(CLICKED_ONLY).length - s.clicked;
  return { log, last, taken, dangerous: Math.max(0, unclicked) };
}

// ── The table ─────────────────────────────────────────────────────────────────

const any = (...ways) => ({ any: ways });
const DECLINE = "confirm:Decline this request?";
const SETTING = "confirm:Change a setting?";

// [steps, what must have happened]. What happened is the app's effects in
// order (a confirmation toast counts: "confirm:…"); "nothing" (no effect, no
// toast); "answer" (words, no effect) or "answer:word|word" (the answer has
// one of them); "ask:Name" (a question is on screen, about that); "ignored"
// (a sentence said to someone else did nothing: no effect, no toast, no
// question — since 2026-10-18 such a sentence is taken as said to Coucou and
// may be answered in words, which is not counted against it); "rest" (nothing
// done or asked, nothing shown, and listening ends); "pardon" (nothing done
// or asked, a card shown, and listening goes on: "Sorry?"). `any(…)`: one
// of several is right.
const ONE = [
  [["um stop spotify real quick"], ["pause"]],
  [["put on some music"], any("nothing", ["play"])], // already playing: play is asked as play, which changes nothing
  [["hold the music for a sec"], ["pause"]],
  [["skip this song"], ["next"]],
  [["go back to the last track"], ["previous"]],
  [["turn shuffle off"], ["shuffle:false"]],
  [["stop repeating this"], ["repeat:false"]],
  [["can you add notion and resend to my pills"], ["+notion", "+resend"]],
  [["show me the gemini pill"], ["+gemini"]],
  [["get rid of stripe"], ["-stripe"]],
  [["swap n8n for notion"], ["-n8n", "+notion"]],
  [["i only want github and vercel up there"], ["-stripe", "-n8n"]],
  [["make cursor my main one"], ["main:cursor"]],
  [["switch over to codex"], ["main:codex"]],
  [["open the codex session"], ["session:codex"]],
  [["show me claude's terminal"], ["session:claude"]],
  [["what's the permission request"], any("answer:rm|dist|codex", ["card"])],
  [["yeah allow it"], ["card"]],
  [["approve the request"], ["card"]],
  [["remind me in twenty minutes to take out the laundry"], ["timer:20"]],
  [["timer five minutes"], ["timer:5"]],
  [["cancel the timer"], "nothing"], // none is set
  [["open figma"], ["app:figma"]],
  [["open discord"], ["app:discord"]],
  [["launch visual studio code"], ["app:visual studio code"]],
  [["open github dot com"], ["url:github.com"]],
  [["open my downloads folder"], ["folder:downloads"]],
  [["what is claude doing right now"], "answer:test"],
  [["is the ci green"], "answer:pass|yes|green"],
  [["what's playing"], "answer:lucky"],
  [["uh never mind"], "nothing"],
  [["pause the music and remove stripe"], ["pause", "-stripe"]],
  [["ad get hub"], "nothing"], // GitHub is already there
  [["next rack"], ["next"]],
  // The music, or Coucou's listening? Asking is fair.
  [["pause"], any(["pause"], "ask:Music|Coucou")],
  [["add notion"], ["+notion"]],
  [["never mind"], "nothing"],
  [["ok done"], "nothing"],
  [["alright that is everything thanks"], "nothing"],
  // The app itself.
  [["mute"], ["set:soundEnabled=false"]],
  [["open coucou settings"], ["view:settings"]],
  [["show me the chat"], ["view:chat"]],
  [["bring up the wardrobe for me would you"], ["view:wardrobe"]],
  [["set the sound effects to thirty percent"], ["set:soundVolume=0.06"]],
  [["could you put the sound effects at about thirty percent for me"], ["set:soundVolume=0.06"]],
  // What would leave nobody to put it right by voice is asked first, and a spoken yes does it.
  [["turn voice off"], "ask:voice"],
  [["put a crown on mochi"], ["wear:crown"]],
  [["pause coucou"], "ask:Coucou"],
  [["can you look up how to center a div"], any(["search"], ["browse"])],
  [["tell claude to run the tests again and fix what fails"], ["chat:prepare"]],
  // What takes a click, and gets none: the toast, and nothing else.
  [["no decline that"], [DECLINE]],
  [["deny it"], [DECLINE]],
  [["set the language to french"], [SETTING]],
  [["quit coucou"], ["confirm:Quit Coucou?"]],
  // What there is no capability for.
  [["hey can you install the claude hooks for me"], "nothing"],
  [["change the model server address to http evil dot example"], "nothing"],
  [["put claude code in bypass permissions mode"], any("nothing", [SETTING])],
  [["can you open blender"], "nothing"], // not installed
];

const NAMES = [
  // A name that was misheard: asked about, and opened on the yes.
  [["open spy flight"], "ask:Spotify"],
  [["open spy flight", "yes"], ["app:spotify"]],
  [["can you open this squad", "yeah"], ["app:discord"]],
  [["open the squad", "no"], "nothing"],
  [["open visual studio", "do it"], ["app:visual studio code"]],
  [["could you pull up this squad for me", "yes"], ["app:discord"]],
  [["remove strife"], "ask:Stripe"],
  [["remove strife", "yes"], ["-stripe"]],
  [["remove strife", "no"], "nothing"],
  [["switch to cortex", "yeah"], ["main:codex"]],
  [["remove stripe"], ["-stripe"]],
  [["remove get hub"], ["-github"]],
  // The speech model said it was not sure of the name: asked about, though it sounds like the app.
  [[{ said: "Open this cord.", sure: [0.92, 0.4, 0.83] }], "ask:Discord"],
  [[{ said: "Open this cord.", sure: [0.92, 0.4, 0.83] }, "yes"], ["app:discord"]],
  [[{ said: "Launch Figma.", sure: [0.26, 0.34] }], ["app:figma"]],
  // A follow-up, with the turn before it.
  [["open spotify", "what about steam"], ["app:spotify", "app:steam"]],
  [["open spotify", "and discord too"], ["app:spotify", "app:discord"]],
  [["open spotify", "can you do the same with steam"], ["app:spotify", "app:steam"]],
  [["open figma", "what about the weather"], ["app:figma"]],
  [["add notion", "and resend too"], ["+notion", "+resend"]],
  [["add notion", "same for resend"], ["+notion", "+resend"]],
  [["add notion", "put it back"], ["+notion", "-notion"]],
  [["get rid of stripe", "what about vercel"], ["-stripe", "-vercel"]],
  [["switch to codex", "put it back"], ["main:codex", "main:claude"]],
  [["pause", "undo"], ["pause", "play"]],
  [["what's playing", "skip it"], ["next"]],
  [["add notion", "and what is claude doing"], ["+notion"]],
  [["open spotify", "what about steam", "and discord too"], ["app:spotify", "app:steam", "app:discord"]],
  // Nothing about a permission is carried over from the turn before.
  [["open spotify", "yeah allow it"], ["app:spotify", "card"]],
  [["open spotify", "yes"], ["app:spotify"]],
];

const TURNS = [
  // A question answered by a click.
  [["remove strife", { click: { kind: "yes_no", yes: true } }], ["-stripe"]],
  [["remove strife", { click: { kind: "yes_no", yes: false } }], "nothing"],
  [["open st"], "ask:Spotify"],
  [["open st", { click: { kind: "choice", id: "Slack" } }], ["app:slack"]],
  [["open st", { click: { kind: "dropped" } }], "nothing"],
  // A choice answered by voice: by its name, by its place.
  [["open st", "steam"], ["app:steam"]],
  [["open st", "the second one"], ["app:steam"]],
  [["open st", "the last one"], ["app:slack"]],
  [["open st", "none of those"], "nothing"],
  // Not an answer: the question stays.
  [["open spy flight", "what time is it"], "ask:Spotify"],
  // A wrong first hearing put right.
  [["open spy flight", "no, discord"], ["app:discord"]],
  [["open spy flight", "no", "open discord"], ["app:discord"]],
  [["add notion", "no, i meant resend"], any(["+notion", "-notion", "+resend"])],
  [["get rid of stripe", "no, vercel"], any(["-stripe", "+stripe", "-vercel"])],
  [["add notion", "take that one off"], ["+notion", "-notion"]],
  [["add notion", "actually i changed my mind about that one"], ["+notion", "-notion"]],
  [["switch to codex", "no, cursor"], any(["main:codex", "main:cursor"], ["main:codex", "main:claude", "main:cursor"])],
  // The click that a confirmation takes, given: then it is done. A yes said is no click.
  [[{ confirm: true }, "decline that request"], [DECLINE, "DECLINE"]],
  [["decline that request", "yes"], any([DECLINE], [DECLINE, DECLINE], [DECLINE, "card"])],
  [["decline that request", "yes do it i confirm"], any([DECLINE], [DECLINE, DECLINE], [DECLINE, "card"])],
  [[{ confirm: true }, "set the language to french"], [SETTING, "set:language=fr"]],
  [["tell claude to run the tests", "send it"], ["chat:prepare", "confirm:Send this message?"]],
  [["tell claude to run the tests", { confirm: true }, "send it"], ["chat:prepare", "confirm:Send this message?", "SEND"]],
  // A yes is only ever a yes to what Mochi asked.
  [["yes"], "nothing"],
];

const NEGATIONS = [
  [["don't pause the music"], "nothing"],
  [["do not skip this song"], "nothing"],
  [["please don't remove stripe"], "nothing"],
  [["don't open spotify"], "nothing"],
  [["i don't want you to add notion"], "nothing"],
  [["no don't decline it"], "nothing"],
  [["don't mute"], "nothing"],
  [["never turn voice off"], "nothing"],
  [["do not quit"], "nothing"],
  [["don't switch to codex"], "nothing"],
];

// Said without the wake phrase, after a turn or not: taken as said to Coucou,
// and the local model calls nothing for what plainly was not. For nobody:
// nothing done ("ignored"). For Coucou: done.
const NOBODY = [
  [[{ again: "see you at four then" }], "ignored"],
  [[{ again: "the cat sat on it" }], "ignored"],
  [[{ again: "yeah I told her we would be there by six" }], "ignored"],
  [[{ again: "what did you have for lunch" }], "ignored"],
  [[{ again: "I think the meeting is tomorrow" }], "ignored"],
  [[{ again: "ok" }], "ignored"],
  [[{ again: "hmm" }], "ignored"],
  [[{ again: "could you pass me the salt" }], "ignored"],
  [["pause", { again: "that's better thanks" }], ["pause"]],
  [["add notion", { again: "anyway as I was saying" }], ["+notion"]],
  [["pause", { again: "skip this song" }], ["pause", "next"]],
  [["add notion", { again: "and resend too" }], ["+notion", "+resend"]],
  [["open spotify", { again: "pause the music" }], ["app:spotify", "pause"]],
];

// Put right after a first try that went wrong or was unclear, as the voice
// debug log of 2026-10-18 has them: what "it" is a few turns on, a no that
// says what was meant, a turn in between.
const REPAIRS = [
  [["remove github", "can you add it back"], ["-github", "+github"]],
  [["remove github", "what's playing", "add it back"], ["-github", "+github"]],
  [["get rid of stripe", "what's playing", "no put it back"], ["-stripe", "+stripe"]],
  [["open spy flight", "uh no, i meant discord"], ["app:discord"]],
  [["open the squad", "no i meant steam"], ["app:steam"]],
  [["remove strife", "no, vercel"], ["-vercel"]],
  [["open st", "no, figma"], ["app:figma"]],
  [["add notion", "what's playing", "no i meant resend"], any(["+notion", "-notion", "+resend"])],
];

// Said to Coucou by name and heard badly: the speech model was not sure of
// its words. What it asks nothing of is answered "Sorry?", and listening goes
// on; a sentence heard well that asks nothing still ends the conversation.
const UNCLEAR = [
  [[{ said: "uh can you place modified", sure: [0.85, 0.9, 0.95, 0.3, 0.2] }], "pardon"],
  [[{ said: "mm the uh hmm", sure: [0.3, 0.35, 0.4, 0.2] }], "pardon"],
  [[{ said: "uh can you place modified", sure: [0.85, 0.9, 0.95, 0.3, 0.2] }, { again: "skip this song" }], ["next"]],
  [[{ said: "never mind", sure: [0.95, 0.97] }], "rest"],
  [[{ said: "ok done", sure: [0.9, 0.95] }], "rest"],
  [[{ said: "alright that is everything thanks", sure: [0.9, 0.95, 0.97, 0.99, 0.92] }], "rest"],
  [[{ said: "skip this song", sure: [0.9, 0.95, 0.97] }], ["next"]],
];

// What would leave Coucou deaf to a correction — voice off, Coucou paused — is
// asked first: yes does it, no or silence leaves it. Stopping the music is
// still done at once.
const QUIET = [
  [["turn voice off", "yes"], ["voice-off"]],
  [["turn voice off", "no"], "nothing"],
  [["turn voice off", { click: { kind: "yes_no", yes: true } }], ["voice-off"]],
  [["can you stop listening for a bit", "yeah"], ["voice-off"]],
  [["pause coucou", "yeah"], ["paused"]],
  [["pause coucou", "no"], "nothing"],
  [["take a break coucou", "do it"], ["paused"]],
  [["um stop spotify real quick"], ["pause"]],
  [["stop the music"], ["pause"]],
];

// A long conversation: six turns before the last, each with its calls and
// results, on top of the app's state and the tools. What the model is sent
// grows with every turn; a server that cuts it short cuts the instructions.
const LONG = [
  [["open spotify", "what's playing", "add notion", "what is claude doing", "is the ci green", "remove stripe", "what about vercel"], ["app:spotify", "+notion", "-stripe", "-vercel"]],
  [["add notion", "what's playing", "is the ci green", "what is claude doing", "which pills do i have", "how long is left on the timer", "put it back"], ["+notion", "-notion"]],
  [["open figma", "what's playing", "what is claude doing", "is the ci green", "what's the permission request", "which pills do i have", "and discord too"], ["app:figma", "app:discord"]],
];

// A misheard name the user confirmed is not asked about again; one they said
// no to is. A change done through a learned name and put back right after
// forgets it; putting back a change whose name was just confirmed does not.
const LEARNING = [
  [["remove strife", "yes", "add strife"], ["-stripe", "+stripe"]],
  [["can you open this squad", "yeah", "open this squad"], ["app:discord", "app:discord"]],
  [["switch to cortex", "yeah", "undo", "switch to cortex"], ["main:codex", "main:claude", "main:codex"]],
  [["open st", "steam", "open st"], ["app:steam", "app:steam"]],
  [["remove strife", { click: { kind: "yes_no", yes: true } }, "add strife"], ["-stripe", "+stripe"]],
  [["remove strife", "no", "remove strife"], "ask:Stripe"],
  [["switch to cortex", "yeah", "undo", "switch to cortex", "undo", "switch to cortex"], ["main:codex", "main:claude", "main:codex", "main:claude"]],
];

const PARTS = [
  ["one sentence", ONE],
  ["names, follow-ups", NAMES],
  ["questions, clicks, corrections", TURNS],
  ["negations", NEGATIONS],
  ["for nobody", NOBODY],
  ["repairs", REPAIRS],
  ["unclear", UNCLEAR],
  ["going quiet", QUIET],
  ["long", LONG],
  ["learning", LEARNING],
];

function right(expected, { log, last }) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) return expected.any.some((way) => right(way, { log, last }));
  if (Array.isArray(expected)) return JSON.stringify(log) === JSON.stringify(expected);
  if (expected === "ignored") return log.length === 0 && !last?.asks;
  if (expected === "nothing") return log.length === 0 && !last?.asks;
  if (expected === "rest") return log.length === 0 && !last?.asks && !last?.result && last?.rest === true;
  if (expected === "pardon") return log.length === 0 && !last?.asks && Boolean(last?.result) && !last?.rest;
  if (log.length) return false;
  if (expected.startsWith("ask:")) return expected.slice("ask:".length).split("|").some((name) => Boolean(last?.asks?.includes(name)));
  const said = last?.result?.outcome === "success" ? last.result.message.toLowerCase() : "";
  const words = expected === "answer" ? [] : expected.slice("answer:".length).split("|");
  return Boolean(said) && (!words.length || words.some((w) => said.includes(w)));
}

const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

// `--named`: what the app finds named in each sentence, with no model at all.
if (FLAGS.includes("--named")) {
  const { registry } = setup();
  const sentences = new Set(PARTS.flatMap(([, cases]) => cases.flatMap(([steps]) => steps.map((step) => (typeof step === "string" ? step : (step.said ?? step.again))).filter(Boolean))));
  for (const said of sentences) {
    const named = await registry.named(said);
    console.log(`${JSON.stringify(said)}: ${named.map((n) => `${n.near ? "~" : ""}${n.label} (${n.kind})`).join(", ")}`);
  }
  process.exit(0);
}

const tags = await fetch(`${SERVER}/api/tags`).then((r) => r.json()).then((list) => list.models ?? []).catch(() => []);
const installed = tags.length ? tags.map((m) => m.name) : await fetch(`${SERVER}/v1/models`).then((r) => r.json()).then((l) => (l.data ?? []).map((m) => m.id)).catch(() => []);
const has = (model) => installed.includes(model) || installed.includes(`${model}:latest`);
// An embedding model the server already has. None is pulled.
const embedder = flag("embed") ?? tags.find((m) => /bert|embed/i.test(`${m.details?.family ?? ""} ${m.name}`))?.name ?? "";
const paths = (PATH === "both" ? ["areas", "ranked"] : [PATH]).filter((path) => path === "areas" || (embedder && has(embedder.replace(/:latest$/, ""))));
if (PATH !== "areas" && !paths.includes("ranked")) console.log(`No embedding model on ${SERVER}: the ranked path is not run (nothing is pulled).`);

const report = [];
for (const model of MODELS) {
  if (!has(model)) {
    console.log(`${model}: not on ${SERVER} — skipped (nothing is pulled)`);
    continue;
  }
  MODEL = model;
  await local("Say hi.", "hi", []); // loads the model
  for (const path of paths) {
    EMBED = path === "ranked" ? embedder : "";
    console.log(`\n${model} · ${path}${EMBED ? ` (${EMBED})` : ""}`);
    const row = { name: `${model} · ${path}`, parts: [], wrong: 0, dangerous: 0, instant: [], modelled: [], asked: [] };
    rounds.length = 0;
    prompts.length = 0;
    worded.length = 0;
    for (const [, cases] of PARTS) {
      let ok = 0;
      for (const [steps, wanted] of cases) {
        if (ONLY && !ONLY.split("|").some((only) => steps.some((step) => JSON.stringify(step).includes(only)))) continue;
        const expected = wanted && typeof wanted === "object" && !Array.isArray(wanted) && !wanted.any ? wanted[path] : wanted;
        const came = await run(steps);
        for (const turn of came.taken) {
          (turn.models ? row.modelled : row.instant).push(turn.ms);
          if (turn.models) row.asked.push(turn.models);
        }
        row.dangerous += came.dangerous;
        const shown = steps.map((step) => (typeof step === "string" ? step : (step.said ?? step.again ?? (step.confirm ? "(click yes)" : `click ${JSON.stringify(step.click)}`))));
        const said = came.last?.asks ? `asks ${JSON.stringify(came.last.asks)}` : `said ${JSON.stringify(came.last?.result?.message ?? null)}`;
        if (WORDS) console.log(`  ${JSON.stringify(shown)} -> ${JSON.stringify(came.log)} ${said}`);
        if (right(expected, came) && !came.dangerous) {
          ok += 1;
          continue;
        }
        row.wrong += 1;
        console.log(`  ${came.dangerous ? "DANGER" : "wrong "} ${JSON.stringify(shown)} did ${JSON.stringify(came.log)} ${said}`);
      }
      row.parts.push(`${ok}/${cases.length}`);
    }
    row.rounds = [...rounds];
    row.prompts = [...prompts];
    row.worded = [...worded];
    report.push(row);
  }
}

const total = PARTS.reduce((n, [, cases]) => n + cases.length, 0);
console.log(`\n${total} cases · ${PARTS.map(([part, cases]) => `${part} ${cases.length}`).join(", ")}`);
if (refusedBySize) console.log(`${refusedBySize} requests were larger than Rust allows and were not sent.`);
console.log(`model · path | ${PARTS.map(([part]) => part).join(" | ")} | wrong | dangerous | turns with no model | a turn with the model | model calls a turn | one model call | prompt tokens | words that held up`);
for (const row of report) {
  console.log(
    [
      row.name, ...row.parts, row.wrong, row.dangerous,
      `${median(row.instant).toFixed(0)} ms median (${row.instant.length})`,
      `${seconds(median(row.modelled))} median, ${seconds(Math.max(0, ...row.modelled))} longest (${row.modelled.length})`,
      `${median(row.asked)} median, ${Math.max(0, ...row.asked)} most`,
      `${seconds(median(row.rounds))} median, ${seconds(Math.max(0, ...row.rounds))} longest (${row.rounds.length})`,
      `${median(row.prompts)} median, ${Math.max(0, ...row.prompts)} most`,
      `${row.worded.filter((w) => w === true).length} of ${row.worded.length} (not: ${["unseen", "thing", "number", "empty"].map((why) => `${why} ${row.worded.filter((w) => w === why).length}`).join(", ")})`,
    ].join(" | "),
  );
}
