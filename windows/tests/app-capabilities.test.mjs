// What the app declares for its assistant (src/capabilities): every capability
// runs against a fake of the app and says what really happened, when it worked
// and when the app refused; what is reversible is put back by its inverse;
// and nothing that must stay private is declared.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appAreas, registerApp } from "../src/capabilities/index.ts";
import { SETTINGS, settingSpec } from "../src/capabilities/settings.ts";
import { webAddress } from "../src/capabilities/apps.ts";

const SOURCES = join(dirname(fileURLToPath(import.meta.url)), "../src/capabilities");

// ── A fake of the app ─────────────────────────────────────────────────────────

const CATALOG = [
  { id: "integration_claude", name: "VS Code", category: "workspace" },
  { id: "agent_cursor", name: "Cursor", category: "workspace" },
  { id: "agent_codex", name: "Codex", category: "workspace" },
  { id: "integration_github", name: "GitHub", category: "service" },
  { id: "integration_vercel", name: "Vercel", category: "service" },
  { id: "integration_stripe", name: "Stripe", category: "service" },
  { id: "integration_notion", name: "Notion", category: "service" },
];
const SAVED = { c1: { title: "Fix the build", dir: "C:/dev/app", messages: 2 }, c2: { title: "Release notes", dir: "", messages: 6 } };
const MODELS = [
  { provider: "anthropic", providerName: "Anthropic", id: "claude-opus-5", label: "Claude Opus 5" },
  { provider: "ollama", providerName: "Ollama", id: "library/llama3", label: "llama3" },
];
const QUESTION = {
  agent: "VS Code",
  questions: [
    { question: "Which database?", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }], multiSelect: false },
    { question: "Which checks?", options: [{ label: "Lint", description: "" }, { label: "Tests", description: "" }], multiSelect: true },
  ],
};

const read = (object, key) => key.split(".").reduce((at, part) => at?.[part], object);
function write(object, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  parts.reduce((at, part) => at[part], object)[last] = value;
}

/**
 * The app, as plain data (`s`) behind the host's methods. `s.refuse`: the app
 * does nothing it is asked and says so where it can. `log`: what it was asked.
 */
function fake(change = {}) {
  const s = {
    refuse: false,
    music: { enabled: true, running: true, playing: false, shuffle: false, repeat: false, volume: 40, position: 10, track: { title: "Song", artist: "Band", album: "Album", duration: 200 } },
    pills: { active: ["integration_github", "integration_vercel"], main: "integration_claude" },
    limit: 3,
    sessions: [{ id: "integration_claude", name: "VS Code", state: "working", doing: "Editing main.ts" }],
    output: ["Read main.ts", "Edited main.ts", "All tests pass."],
    permission: { agent: "VS Code", request: "Bash: npm test" },
    question: null,
    answered: null,
    timer: null,
    view: { view: "overview", open: false },
    settings: {
      soundEnabled: true, soundVolume: 0.12, openOnHover: false, autoCloseInterval: 15, showPlanInNotch: false, showCodexPlanInNotch: false,
      language: "", autostart: false, screen: "primary", claudeCodeMode: "default", hooksInstalled: false, ollamaUrl: "",
      voice: { enabled: true, wake: true, brain: "", engine: "system", hearingModel: "parakeet-0.6b", followUp: 8, speak: false, speaker: "female" },
    },
    chat: { provider: "anthropic", model: "claude-opus-5", busy: false, draft: "", conversationId: "c1", messages: 2 },
    outfit: "auto",
    recap: { enabled: true, hideProjects: false },
    mochi: { supported: true, onDesktop: false, asleep: false },
    paused: false,
    quit: false,
    // A copy: the cases below are data, and stay as they are written.
    ...structuredClone(change),
  };
  const log = [];
  const act = (what, fn) => {
    log.push(what);
    if (s.refuse) return false;
    fn();
    return true;
  };
  const host = {
    music: () => ({ ...s.music }),
    musicControl: async (action, value) => act(`music:${action}`, () => {
      if (action === "playPause") s.music.playing = !s.music.playing;
      if (action === "play") s.music.playing = true;
      if (action === "pause") s.music.playing = false;
      if (action === "shuffle") s.music.shuffle = value === 1;
      if (action === "repeat") s.music.repeat = value === 1;
      if (action === "volume") s.music.volume = value;
      if (action === "seek") s.music.position = value;
    }),
    openMusic: async () => act("music:open", () => (s.music.running = true)),

    pillCatalog: () => CATALOG,
    pills: () => ({ active: [...s.pills.active], main: s.pills.main }),
    pillFits: () => s.pills.active.length < s.limit,
    pillLimit: () => s.limit,
    togglePill: (id) => void act(`toggle:${id}`, () => {
      if (s.pills.active.includes(id)) s.pills.active = s.pills.active.filter((x) => x !== id);
      else if (id !== s.pills.main && s.pills.active.length < s.limit) s.pills.active.push(id);
    }),
    setMainPill: (id) => void act(`main:${id}`, () => {
      s.pills.main = id;
      s.pills.active = s.pills.active.filter((x) => x !== id);
    }),

    sessions: () => s.sessions,
    openSession: (id) => s.sessions.some((x) => x.id === id) && act(`session:${id}`, () => {}),
    sessionOutput: (_id, lines) => s.output.slice(-lines),

    permission: () => s.permission,
    agentQuestion: () => s.question,
    showWaitingCard: () => act("card", () => (s.view = { view: s.question ? "question" : "approval", open: true })),
    declinePermission: () => act("deny", () => (s.permission = null)),
    answerAgentQuestion: (answers) => act("answer", () => {
      s.answered = answers;
      s.question = null;
    }),

    timer: () => s.timer,
    setTimer: (minutes, label) => void act("timer:set", () => (s.timer = { label, minutesLeft: minutes })),
    cancelTimer: () => s.timer != null && act("timer:cancel", () => (s.timer = null)),

    apps: async () => ["Spotify", "Steam"],
    appsNear: async (said) => (said.toLowerCase().startsWith("s") ? [{ name: "Spotify", score: 0.9 }, { name: "Steam", score: 0.6 }] : []),
    openApp: async (name) => (act(`app:${name}`, () => {}) ? { name, seen: name === "Spotify" } : null),
    folders: () => [{ id: "downloads", label: "Downloads", hint: "C:/Users/me/Downloads" }],
    openFolder: async (id) => (act(`folder:${id}`, () => {}) && id === "downloads" ? "Downloads" : null),
    openUrl: (url) => act(`url:${url}`, () => {}),

    currentView: () => ({ ...s.view }),
    showView: (view) => act(`view:${view}`, () => (s.view = { view, open: true })),

    setting: (key) => read(s.settings, key),
    setSetting: async (key, value) => act(`set:${key}=${value}`, () => write(s.settings, key, value)) && read(s.settings, key) === value,
    languages: () => [{ value: "", label: "System" }, { value: "en", label: "English" }, { value: "fr", label: "Français" }],
    monitors: async () => [{ value: "primary", label: "Primary display" }, { value: "cursor", label: "The display with the pointer" }],
    hearingModels: async () => [{ value: "moonshine-tiny", label: "Moonshine Tiny" }, { value: "parakeet-0.6b", label: "Parakeet 0.6B" }],
    embedModels: async () => [{ value: "", label: "None" }, { value: "nomic-embed-text", label: "nomic-embed-text" }],

    chat: () => ({ ...s.chat }),
    prepareChat: (message) => act("chat:prepare", () => {
      s.chat.draft = message;
      s.view = { view: "chat", open: true };
    }),
    sendChat: async () => act(`chat:send:${s.chat.draft}`, () => {
      s.chat.draft = "";
      s.chat.messages += 1;
    }),
    stopChat: () => s.chat.busy && act("chat:stop", () => (s.chat.busy = false)),
    resetChat: async () => act("chat:reset", () => Object.assign(s.chat, { conversationId: null, messages: 0 })),
    chatModels: async () => MODELS,
    setChatModel: async (provider, model) => act(`chat:model:${provider}/${model}`, () => Object.assign(s.chat, { provider, model })),
    conversations: async () => Object.entries(SAVED).map(([id, c]) => ({ id, title: c.title, dir: c.dir, updated: 1_790_000_000 })),
    openConversation: async (id) => id in SAVED && act(`chat:open:${id}`, () => Object.assign(s.chat, { conversationId: id, messages: SAVED[id].messages })),

    outfits: () => [{ id: "auto", label: "Auto (seasons)" }, { id: "none", label: "None" }, { id: "crown", label: "Crown" }],
    outfit: () => s.outfit,
    wearOutfit: (id) => act(`wear:${id}`, () => (s.outfit = id)),

    recapOptions: () => ({ ...s.recap }),
    recapLines: async () => (s.refuse ? null : ["12 sessions", "Busiest day: Tuesday"]),
    setRecapOption: async (option, on) => act(`recap:${option}=${on}`, () => (s.recap[option] = on)),

    mochi: () => ({ ...s.mochi }),
    mochiFlyOut: async () => act("mochi:out", () => (s.mochi.onDesktop = true)),
    mochiFlyHome: async () => act("mochi:home", () => (s.mochi.onDesktop = false)),
    setMochiAsleep: (asleep) => act(`mochi:asleep=${asleep}`, () => (s.mochi.asleep = asleep)),

    services: () => [{ id: "integration_github", name: "GitHub", line: "main: passing" }, { id: "integration_vercel", name: "Vercel", line: "" }],
    serviceInfo: (id) => (id === "integration_github" ? ["main: passing", "2 open pull requests"] : []),
    refreshService: async (id) => act(`refresh:${id}`, () => {}),

    webSearch: async (query) => (act(`search:${query}`, () => {})
      ? { results: [{ title: "Mochi", url: "https://example.org/mochi", snippet: "A rice cake." }] }
      : { error: "No search key is stored." }),
    openWebSearch: (query) => act(`browse:${query}`, () => {}),

    listening: () => s.settings.voice.enabled,
    stopListening: () => void act("voice:off", () => (s.settings.voice.enabled = false)),
    paused: () => s.paused,
    setPaused: (on) => void act(`paused=${on}`, () => (s.paused = on)),
    quit: () => void act("quit", () => (s.quit = true)),
    notify: (title) => void log.push(`note:${title}`),
  };
  return { s, log, host };
}

/** The least of a registry the capabilities need: what is declared, by name and by area, and an `undo` that says it ran. */
function registry() {
  const all = [];
  const sources = [];
  const self = {
    declare: (...capabilities) => void all.push(...capabilities),
    entities: (source) => void sources.push(source),
    screen: () => {},
    all: () => all,
    get: (name) => all.find((c) => c.name === name),
    areas: () => [...new Set(all.map((c) => c.area))].map((area) => ({ area, names: all.filter((c) => c.area === area).map((c) => c.name) })),
    schema: () => null,
    snapshot: async () => ({}),
    execute: async () => ({ status: "refused", verified: false, line: "", detail: "not in this test" }),
    undo: async () => ({ status: "done", verified: true, line: "Put back" }),
    sources,
  };
  return self;
}

function app(change) {
  const made = fake(change);
  const reg = registry();
  registerApp(reg, made.host);
  return { ...made, registry: reg, get: (name) => reg.get(name) };
}

/** What a capability is given besides its arguments. `answer`: what the user says to a question on screen. */
const context = (answer = { kind: "yes_no", yes: true }, asked = []) => ({
  origin: "local",
  ask: async (ask) => (asked.push(ask), answer),
  working: () => {},
});

const tierOf = (capability, args = {}) => (typeof capability.tier === "function" ? capability.tier(args) : capability.tier);

// ── Every capability, once: what it is run with, and what the app must be like ──

/**
 * `with`: how the fake differs. `args`: resolved, as the executor gives them.
 * `refused`: the status when the app does nothing (absent: a read, or
 * something the app cannot refuse). `unverified`: done, and not seen.
 */
const CASES = [
  { name: "now_playing" },
  { name: "play_music", refused: "failed" },
  { name: "pause_music", with: { music: { enabled: true, running: true, playing: true, shuffle: false, repeat: false, volume: 40, position: 10, track: null } }, refused: "failed" },
  { name: "next_track", refused: "failed", unverified: true },
  { name: "previous_track", refused: "failed", unverified: true },
  { name: "set_shuffle", args: { on: true }, refused: "failed" },
  { name: "set_repeat", args: { on: true }, refused: "failed" },
  { name: "set_music_volume", args: { percent: 70 }, refused: "failed" },
  { name: "seek_music", args: { seconds: 30 }, refused: "failed" },

  { name: "list_pills" },
  { name: "add_pills", args: { pills: ["integration_stripe"] }, refused: "failed" },
  { name: "remove_pills", args: { pills: ["integration_github"] }, refused: "failed" },
  { name: "replace_pill", args: { remove: "integration_github", add: "integration_stripe" }, refused: "failed" },
  { name: "keep_only_pills", args: { pills: ["integration_github"] }, refused: "failed" },
  { name: "set_main_pill", args: { pill: "agent_cursor" }, refused: "failed" },

  { name: "list_sessions" },
  { name: "read_session_output", args: { session: "integration_claude" } },
  { name: "open_session", args: { session: "integration_claude" }, refused: "failed", unverified: true },

  { name: "read_permission_request" },
  { name: "show_waiting_card", refused: "failed", unverified: true },
  { name: "decline_permission", refused: "failed" },
  { name: "read_agent_question", with: { question: QUESTION, permission: null } },
  { name: "answer_agent_question", with: { question: QUESTION, permission: null }, args: { options: ["1.2", "2.1", "2.2"] }, refused: "failed" },

  { name: "read_timer" },
  { name: "set_timer", args: { minutes: 5, label: "tea" }, refused: "failed" },
  { name: "cancel_timer", with: { timer: { label: "tea", minutesLeft: 4 } }, refused: "failed" },

  { name: "open_app", args: { app: "Spotify" }, refused: "not_found" },
  { name: "open_folder", args: { folder: "downloads" }, refused: "not_found", unverified: true },
  { name: "open_url", args: { url: "github.com/kura120" }, refused: "failed", unverified: true },

  { name: "current_view" },
  { name: "show_view", args: { view: "chat" }, refused: "failed" },

  { name: "get_setting", args: { setting: "voice.followUp" } },
  { name: "set_setting", args: { setting: "soundEnabled", on: false }, refused: "failed" },

  { name: "read_chat" },
  { name: "prepare_chat_message", args: { message: "Run the tests again" }, refused: "failed" },
  { name: "send_chat_message", with: { chat: { provider: "claudecode", model: "claude-sonnet-5-5", busy: false, draft: "Run the tests again", conversationId: "c1", messages: 2 } }, refused: "failed" },
  { name: "stop_chat", with: { chat: { provider: "anthropic", model: "claude-opus-5", busy: true, draft: "", conversationId: "c1", messages: 2 } }, refused: "failed" },
  { name: "new_chat", refused: "failed" },
  { name: "pick_chat_model", args: { model: "ollama/library/llama3" }, refused: "failed" },
  { name: "list_conversations" },
  { name: "open_conversation", args: { conversation: "c2" }, refused: "failed" },

  { name: "list_outfits" },
  { name: "wear_outfit", args: { outfit: "crown" }, refused: "failed" },

  { name: "read_recap", refused: "failed" },
  { name: "set_recap_enabled", args: { on: false }, refused: "failed" },
  { name: "set_recap_hide_projects", args: { on: true }, refused: "failed" },

  { name: "read_mochi" },
  { name: "mochi_to_desktop", refused: "failed" },
  { name: "mochi_come_home", with: { mochi: { supported: true, onDesktop: true, asleep: false } }, refused: "failed" },
  { name: "set_mochi_asleep", with: { mochi: { supported: true, onDesktop: true, asleep: false } }, args: { asleep: true }, refused: "failed" },

  { name: "list_services" },
  { name: "service_report", args: { service: "integration_github" } },
  { name: "refresh_service", args: { service: "integration_github" }, refused: "failed", unverified: true },

  { name: "web_search", args: { query: "what is mochi" }, refused: "failed" },
  { name: "open_web_search", args: { query: "what is mochi" }, refused: "failed", unverified: true },

  { name: "stop_listening", refused: "failed" },
  { name: "pause_coucou", refused: "failed" },
  { name: "resume_coucou", with: { paused: true }, refused: "failed" },
  { name: "quit_coucou", unverified: true },
  { name: "notify", args: { text: "Stand up" }, unverified: true },
  { name: "undo" },
  { name: "nothing" },
  { name: "ask_user", args: { question: "Open Discord?", option_1: "Discord", option_2: "Steam" } },
  { name: "escalate", args: { reason: "needs a plan" }, unverified: true },
  { name: "more_tools" },
];

// ── The declarations ──────────────────────────────────────────────────────────

test("names are unique and snake_case, and each capability says what it is", () => {
  const { registry: reg } = app();
  const names = reg.all().map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "a name is declared twice");
  for (const c of reg.all()) {
    assert.match(c.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, c.name);
    assert.match(c.area, /^[a-z]+$/, `${c.name}: area`);
    assert.ok(c.description.length >= 20 && c.description.trim().endsWith("."), `${c.name}: a description in sentences`);
    for (const [name, arg] of Object.entries(c.args)) assert.ok(arg.description.length > 5, `${c.name}.${name}: described`);
  }
  // The three a model is always shown (doc/voice-brain.md, 3.2), and undo.
  for (const name of ["nothing", "escalate", "more_tools", "undo"]) assert.ok(reg.get(name), name);
});

test("every capability has a case here, and every case a capability", () => {
  const { registry: reg } = app();
  assert.deepEqual(CASES.map((c) => c.name).sort(), reg.all().map((c) => c.name).sort());
});

test("an argument that names a thing names a kind some source lists; kinds are unique", async () => {
  const { registry: reg } = app();
  const kinds = reg.sources.map((s) => s.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const c of reg.all()) {
    for (const [name, arg] of Object.entries(c.args)) {
      if (arg.type === "entity" || arg.type === "entities") assert.ok(kinds.includes(arg.kind), `${c.name}.${name}: no source for '${arg.kind}'`);
    }
  }
  for (const source of reg.sources) {
    assert.ok(source.description.length > 20, source.kind);
    const list = await source.list();
    const ids = list.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${source.kind}: an id is listed twice`);
    for (const e of list) assert.ok(typeof e.id === "string" && e.label, `${source.kind}: ${JSON.stringify(e)}`);
  }
});

test("the tiers: a click for what cannot be put back, an inverse for what can", () => {
  const { registry: reg } = app();
  const tiers = Object.fromEntries(reg.all().filter((c) => typeof c.tier === "string").map((c) => [c.name, c.tier]));
  const of = (tier) => Object.keys(tiers).filter((name) => tiers[name] === tier).sort();
  assert.deepEqual(of("confirm"), ["answer_agent_question", "decline_permission", "quit_coucou", "send_chat_message"]);
  assert.deepEqual(of("reversible"), [
    "add_pills", "cancel_timer", "keep_only_pills", "mochi_come_home", "mochi_to_desktop", "new_chat", "pause_coucou", "pause_music",
    "pick_chat_model", "play_music", "remove_pills", "replace_pill", "resume_coucou", "set_main_pill", "set_mochi_asleep", "set_music_volume",
    "set_recap_enabled", "set_recap_hide_projects", "set_repeat", "set_shuffle", "set_timer", "wear_outfit",
  ]);
  assert.deepEqual(of("read"), [
    "current_view", "get_setting", "list_conversations", "list_outfits", "list_pills", "list_services", "list_sessions", "more_tools",
    "now_playing", "read_agent_question", "read_chat", "read_mochi", "read_permission_request", "read_recap", "read_session_output",
    "read_timer", "service_report", "web_search",
  ]);
  // The one whose tier depends on its arguments: a setting's own.
  assert.deepEqual(reg.all().filter((c) => typeof c.tier === "function").map((c) => c.name), ["set_setting"]);
  for (const c of reg.all()) {
    const tier = typeof c.tier === "string" ? c.tier : null;
    if (tier === "confirm" || !tier) assert.equal(typeof c.describe, "function", `${c.name}: confirm without describe`);
    if (tier === "reversible" || !tier) assert.equal(typeof c.inverse, "function", `${c.name}: reversible without inverse`);
    if (c.inSnapshot) assert.equal(tier, "read", `${c.name}: only a read is in the snapshot`);
  }
  assert.deepEqual(reg.all().filter((c) => c.inSnapshot).map((c) => c.name).sort(), [
    "current_view", "list_pills", "list_sessions", "now_playing", "read_agent_question", "read_permission_request", "read_timer",
  ]);
});

test("a confirmation says exactly what would change", async () => {
  const sending = app({ chat: { provider: "claudecode", model: "claude-sonnet-5-5", busy: false, draft: "Delete the old branch", conversationId: null, messages: 0 } });
  assert.match((await sending.get("send_chat_message").describe({})).change, /Delete the old branch/);
  const declining = app();
  assert.match((await declining.get("decline_permission").describe({})).change, /Bash: npm test/);
  const answering = app({ question: QUESTION, permission: null });
  assert.match((await answering.get("answer_agent_question").describe({ options: ["1.2", "2.1"] })).change, /SQLite · Lint/);
  const setting = app();
  assert.equal((await setting.get("set_setting").describe({ setting: "language", option: "fr" })).change, "Language: System → Français");
  for (const made of [sending, declining, answering, setting]) assert.deepEqual(made.log, [], "describing does nothing");
});

// ── Running them ──────────────────────────────────────────────────────────────

for (const c of CASES) {
  test(`${c.name}: done, and said as it was seen`, async () => {
    const { get } = app(c.with);
    const result = await get(c.name).run(c.args ?? {}, context());
    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(typeof result.line, "string");
    assert.equal(result.verified, !c.unverified, `${c.name}: verified`);
  });

  if (!c.refused) continue;
  test(`${c.name}: the app refuses, and it says so`, async () => {
    const { get, s } = app({ ...c.with, refuse: true });
    const before = JSON.stringify(s);
    const result = await get(c.name).run(c.args ?? {}, context());
    assert.equal(result.status, c.refused, JSON.stringify(result));
    assert.equal(result.verified, false);
    assert.ok(result.line, "a line for the card");
    assert.equal(JSON.stringify(s), before, "nothing changed");
  });
}

test("a capability never throws: what breaks in the app is a failure", async () => {
  const { registry: reg, host } = app();
  for (const key of Object.keys(host)) {
    host[key] = () => {
      throw new Error(`${key} broke`);
    };
  }
  for (const c of CASES) {
    // These three do not touch the app.
    if (["undo", "nothing", "escalate", "more_tools", "ask_user"].includes(c.name)) continue;
    const result = await reg.get(c.name).run(c.args ?? {}, context());
    assert.equal(result.status, "failed", c.name);
    assert.equal(result.verified, false, c.name);
    assert.match(result.detail, / broke$/, c.name);
  }
});

// ── Putting things back ───────────────────────────────────────────────────────

for (const c of CASES.filter((c) => tierOf(app().get(c.name), c.args ?? {}) === "reversible")) {
  test(`${c.name}: its inverse puts the app back`, async () => {
    const { get, s } = app(c.with);
    const capability = get(c.name);
    const args = c.args ?? {};
    // A pill that comes back comes back last: which pills are shown is what is put back, not their order.
    const state = () => JSON.stringify({ ...s, pills: { active: [...s.pills.active].sort(), main: s.pills.main } });
    const before = state();
    const inverse = capability.inverse(args);
    assert.ok(inverse, "there is something to put back");
    assert.equal((await capability.run(args, context())).status, "done");
    assert.notEqual(state(), before, "it changed something");
    const back = await get(inverse.name).run(inverse.arguments, context());
    assert.equal(back.status, "done", JSON.stringify(back));
    assert.equal(state(), before);
  });
}

test("nothing to put back: no inverse", () => {
  const { get } = app({ music: { enabled: true, running: true, playing: true, shuffle: true, repeat: false, volume: null, position: 0, track: null } });
  assert.equal(get("play_music").inverse({}), null);
  assert.equal(get("set_shuffle").inverse({ on: true }), null);
  // Windows cannot read Spotify's volume: there is none to go back to.
  assert.equal(get("set_music_volume").inverse({ percent: 10 }), null);
  assert.equal(get("add_pills").inverse({ pills: ["integration_github"] }), null);
  assert.equal(get("remove_pills").inverse({ pills: ["integration_stripe"] }), null);
  assert.equal(get("set_main_pill").inverse({ pill: "integration_claude" }), null);
  assert.equal(get("cancel_timer").inverse({}), null);
  assert.equal(get("wear_outfit").inverse({ outfit: "auto" }), null);
  assert.equal(get("resume_coucou").inverse({}), null);
  // A chat that is not saved cannot be opened again.
  assert.equal(app({ chat: { provider: "anthropic", model: "m", busy: false, draft: "", conversationId: null, messages: 3 } }).get("new_chat").inverse({}), null);
});

// ── Music ─────────────────────────────────────────────────────────────────────

test("music the user switched off is not touched, and not started either", async () => {
  const { get, log } = app({ music: { enabled: false, running: false, playing: false, shuffle: false, repeat: false, volume: 40, position: 0, track: null } });
  for (const name of ["play_music", "pause_music", "next_track", "set_shuffle", "set_music_volume", "seek_music"]) {
    assert.equal(typeof get(name).available(), "string", name);
    assert.equal((await get(name).run({ on: true, percent: 10, seconds: 1 }, context())).status, "failed", name);
  }
  assert.deepEqual(log, []);
});

test("play starts Spotify when it is not running, and says only that it was asked", async () => {
  const { get, log } = app({ music: { enabled: true, running: false, playing: false, shuffle: false, repeat: false, volume: 40, position: 0, track: null } });
  assert.equal(get("play_music").available(), true);
  assert.equal(typeof get("pause_music").available(), "string");
  const result = await get("play_music").run({}, context());
  assert.deepEqual([result.status, result.verified], ["done", false]);
  assert.deepEqual(log, ["music:open"]);
});

// ── Pills ─────────────────────────────────────────────────────────────────────

test("a full island: adding says there is no room, replacing makes it", async () => {
  const { get, s } = app({ pills: { active: ["integration_github", "integration_vercel", "integration_notion"], main: "integration_claude" } });
  const full = await get("add_pills").run({ pills: ["integration_stripe"] }, context());
  assert.equal(full.status, "failed");
  assert.match(full.detail, /No room for Stripe: 3 pills/);
  const replaced = await get("replace_pill").run({ remove: "integration_notion", add: "integration_stripe" }, context());
  assert.deepEqual([replaced.status, replaced.verified], ["done", true]);
  assert.deepEqual(s.pills.active, ["integration_github", "integration_vercel", "integration_stripe"]);
});

test("pills: what is already so is said, the main pill is never one to hide", async () => {
  const { get, s, log } = app();
  assert.equal((await get("add_pills").run({ pills: ["integration_github", "integration_claude"] }, context())).status, "done");
  assert.equal((await get("remove_pills").run({ pills: ["integration_claude"] }, context())).status, "failed");
  assert.equal((await get("remove_pills").run({ pills: ["integration_stripe"] }, context())).status, "failed");
  assert.deepEqual(log, []);
  // The main pill among those to keep is kept, and takes no slot.
  assert.equal((await get("keep_only_pills").run({ pills: ["integration_claude", "integration_vercel"] }, context())).status, "done");
  assert.deepEqual(s.pills, { active: ["integration_vercel"], main: "integration_claude" });
  // Only a workspace tool is the main pill.
  assert.equal((await get("set_main_pill").run({ pill: "integration_github" }, context())).status, "failed");
  assert.equal(s.pills.main, "integration_claude");
});

// ── The card that waits ───────────────────────────────────────────────────────

test("an agent's question: one option for each question, several only where it allows", async () => {
  const answer = (options) => {
    const made = app({ question: QUESTION, permission: null });
    return made.get("answer_agent_question").run({ options }, context()).then((result) => ({ result, ...made }));
  };
  const good = await answer(["1.1", "2.2"]);
  assert.equal(good.result.status, "done");
  assert.deepEqual(good.s.answered, { "Which database?": "Postgres", "Which checks?": ["Tests"] });
  for (const options of [["1.1"], ["1.1", "1.2", "2.1"], ["3.1"], []]) {
    const bad = await answer(options);
    assert.equal(bad.result.status, "failed", JSON.stringify(options));
    assert.equal(bad.s.answered, null);
    assert.deepEqual(bad.log, []);
  }
});

test("no card waits: nothing to show, decline or answer", async () => {
  const { get, log } = app({ permission: null });
  for (const name of ["show_waiting_card", "decline_permission", "answer_agent_question"]) {
    assert.equal(typeof get(name).available(), "string", name);
    assert.equal((await get(name).run({ options: ["1.1"] }, context())).status, "failed", name);
  }
  assert.equal((await get("read_permission_request").run({}, context())).data, null);
  assert.deepEqual(log, []);
});

// ── Settings ──────────────────────────────────────────────────────────────────

test("the schema: each setting with its tier, and none of those left to the user alone", () => {
  const done = ["soundEnabled", "soundVolume", "openOnHover", "autoCloseInterval", "showPlanInNotch", "showCodexPlanInNotch", "voice.speak", "voice.speaker", "voice.followUp"];
  // A click first — and always for where what was said may go.
  const clicked = ["language", "autostart", "screen", "voice.wake", "voice.hearingModel", "voice.brain", "claudeCodeMode", "voice.embedModel", "voice.cloud", "voice.webAnswers", "voice.webSearch", "searchEngine"];
  assert.deepEqual(SETTINGS.map((s) => [s.key, s.tier]), [...done.map((key) => [key, "reversible"]), ...clicked.map((key) => [key, "confirm"])]);
  for (const key of ["voice.enabled", "voice.engine", "voice.brainModel", "hooksInstalled", "ollamaUrl", "lmstudioUrl", "customUrl", "claudeCodeDir", "shortcuts", "phoneLink", "phoneRelay", "phoneRelayUrl"]) assert.equal(settingSpec(key), undefined, key);
  for (const spec of SETTINGS) {
    // A plain name and what it is; never the ways it is said.
    assert.deepEqual(Object.keys(spec).filter((key) => !["key", "label", "about", "tier", "kind", "min", "max", "step", "percent", "unit", "options"].includes(key)), []);
    assert.ok(spec.label && spec.about, spec.key);
  }
});

test("set_setting: its tier is the setting's, and one it does not know takes a click and is refused", async () => {
  const { get, log } = app();
  const set = get("set_setting");
  assert.equal(set.tier({ setting: "soundEnabled", on: false }), "reversible");
  for (const key of ["language", "autostart", "screen", "voice.wake", "voice.hearingModel", "voice.brain", "claudeCodeMode", "voice.embedModel", "voice.cloud", "voice.webAnswers", "voice.webSearch", "searchEngine"]) {
    assert.equal(set.tier({ setting: key }), "confirm", key);
  }
  for (const key of ["hooksInstalled", "ollamaUrl", "voice.enabled", "voice.brainModel", "shortcuts", "phoneLink", "nonsense"]) {
    assert.equal(set.tier({ setting: key, on: true }), "confirm", key);
    assert.equal(set.inverse({ setting: key, on: true }), null, key);
    assert.equal((await set.run({ setting: key, on: true, option: "http://elsewhere" }, context())).status, "failed", key);
    assert.equal((await get("get_setting").run({ setting: key }, context())).status, "failed", key);
  }
  assert.deepEqual(log, []);
});

test("set_setting: a switch, a level in percent, a delay, a choice by value or by label", async () => {
  const { get, s } = app();
  const set = (args) => get("set_setting").run(args, context());
  assert.equal((await set({ setting: "soundVolume", number: 50 })).line, "Sound effects volume: 50 %");
  assert.equal(s.settings.soundVolume, 0.1);
  assert.equal((await set({ setting: "voice.followUp", number: 12 })).line, "Follow-up time: 12 seconds");
  assert.equal(s.settings.voice.followUp, 12);
  assert.equal((await set({ setting: "language", option: "Français" })).line, "Language: Français");
  assert.equal(s.settings.language, "fr");
  // A language by its name in English too, as the platform writes it.
  assert.equal((await set({ setting: "language", option: "english" })).line, "Language: English");
  assert.equal(s.settings.language, "en");
  await set({ setting: "language", option: "french" });
  assert.equal(s.settings.language, "fr");
  assert.equal((await set({ setting: "voice.hearingModel", option: "moonshine-tiny" })).status, "done");
  assert.equal((await set({ setting: "screen", option: "cursor" })).status, "done");
  // Already so: said, and nothing is saved again.
  const same = await set({ setting: "voice.speak", on: false });
  assert.deepEqual([same.status, same.verified], ["done", true]);
  assert.match(same.detail, /already/);
});

test("set_setting: a value the setting does not take changes nothing, and says what it takes", async () => {
  const { get, log } = app();
  const set = (args) => get("set_setting").run(args, context());
  for (const args of [
    { setting: "soundEnabled" }, { setting: "soundEnabled", number: 30 }, { setting: "soundVolume", number: 140 },
    { setting: "autoCloseInterval", number: 2 }, { setting: "voice.followUp", on: true }, { setting: "language", option: "Klingon" },
    { setting: "voice.speaker", option: "" },
  ]) {
    assert.equal((await set(args)).status, "failed", JSON.stringify(args));
  }
  assert.deepEqual((await set({ setting: "language", option: "Klingon" })).near, ["System", "English", "Français"]);
  // The same is said by check, before the click a setting may take: none is asked for what cannot be done.
  const check = (args) => get("set_setting").check(args);
  assert.deepEqual((await check({ setting: "language", option: "Klingon" })).near, ["System", "English", "Français"]);
  assert.equal(await check({ setting: "language", option: "Français" }), null);
  assert.equal((await check({ setting: "nonsense", on: true })).status, "failed");
  // A level asked of a switch: the settings that take one are named.
  assert.match((await check({ setting: "soundEnabled", number: 30 })).detail, /A level is one of: Sound effects volume/);
  assert.deepEqual(log, []);
});

test("a session is known by its agent's name too, as its card shows it", async () => {
  const { registry } = app();
  const sessions = await registry.sources.find((source) => source.kind === "session").list();
  const claude = sessions.find((session) => session.id === "integration_claude");
  assert.deepEqual(claude.spoken, ["Claude Code"]);
  const listed = await registry.get("list_sessions").run({}, context());
  for (const session of listed.data) if (session.agent) assert.notEqual(session.agent, session.name);
});

test("get_setting reads a value as a person reads it, with a choice's values", async () => {
  const { get } = app();
  const read = async (setting) => (await get("get_setting").run({ setting }, context())).data;
  assert.deepEqual(await read("soundVolume"), { setting: "Sound effects volume", value: "60 %" });
  assert.deepEqual(await read("soundEnabled"), { setting: "Sound effects", value: "on" });
  assert.deepEqual(await read("language"), { setting: "Language", value: "System", options: ["System", "English", "Français"] });
});

// ── Chat ──────────────────────────────────────────────────────────────────────

test("a chat that is not saved is asked about before it is started over", async () => {
  const unsaved = { chat: { provider: "anthropic", model: "m", busy: false, draft: "", conversationId: null, messages: 4 } };
  const kept = app(unsaved);
  const asked = [];
  const no = await kept.get("new_chat").run({}, context({ kind: "yes_no", yes: false }, asked));
  assert.equal(no.status, "done");
  assert.equal(asked[0].kind, "yes_no");
  assert.deepEqual(kept.log, []);
  assert.equal(kept.s.chat.messages, 4);
  const dropped = app(unsaved);
  await dropped.get("new_chat").run({}, context({ kind: "dropped" }));
  assert.deepEqual(dropped.log, []);
  const gone = app(unsaved);
  assert.equal((await gone.get("new_chat").run({}, context({ kind: "yes_no", yes: true }))).status, "done");
  assert.equal(gone.s.chat.messages, 0);
});

test("the chat: nothing to send, or still answering, sends nothing", async () => {
  const empty = app();
  assert.equal(typeof empty.get("send_chat_message").available(), "string");
  assert.equal((await empty.get("send_chat_message").run({}, context())).status, "failed");
  assert.equal(typeof empty.get("stop_chat").available(), "string");
  const busy = app({ chat: { provider: "anthropic", model: "m", busy: true, draft: "more", conversationId: "c1", messages: 2 } });
  for (const [name, args] of [["send_chat_message", {}], ["new_chat", {}], ["open_conversation", { conversation: "c2" }]]) {
    assert.equal((await busy.get(name).run(args, context())).status, "failed", name);
  }
  assert.deepEqual([...empty.log, ...busy.log], []);
  // A model the picker does not offer is not picked.
  assert.equal((await empty.get("pick_chat_model").run({ model: "openai/gpt-9" }, context())).status, "failed");
});

// ── The rest ──────────────────────────────────────────────────────────────────

test("apps are looked up, not run: a window that was not seen is only asked for", async () => {
  const { get, registry: reg } = app();
  const steam = await get("open_app").run({ app: "Steam" }, context());
  assert.deepEqual([steam.status, steam.verified], ["done", false]);
  const source = reg.sources.find((s) => s.kind === "app");
  assert.deepEqual((await source.near("spotfy")).map((e) => [e.id, e.score]), [["Spotify", 0.9], ["Steam", 0.6]]);
  assert.deepEqual(await source.near("zzz"), []);
});

test("only an http(s) address is opened", async () => {
  assert.equal(webAddress("github.com"), "https://github.com/");
  assert.equal(webAddress("http://localhost.test/a?b=1"), "http://localhost.test/a?b=1");
  for (const bad of ["", "file:///C:/Windows/system32", "javascript:alert(1)", "ms-settings:privacy", "calc", "two words.com", "https://user:pw@example.org"]) {
    assert.equal(webAddress(bad), null, bad);
  }
  const { get, log } = app();
  assert.equal((await get("open_url").run({ url: "file:///C:/secret.txt" }, context())).status, "failed");
  assert.deepEqual(log, []);
});

test("Mochi: where the desktop cannot have him, and asleep only out there", async () => {
  const stuck = app({ mochi: { supported: false, onDesktop: false, asleep: false } });
  for (const name of ["mochi_to_desktop", "mochi_come_home", "set_mochi_asleep"]) {
    assert.equal(typeof stuck.get(name).available(), "string", name);
    assert.equal((await stuck.get(name).run({ asleep: true }, context())).status, "failed", name);
  }
  const home = app();
  assert.equal((await home.get("set_mochi_asleep").run({ asleep: true }, context())).status, "failed");
  assert.deepEqual([...stuck.log, ...home.log], []);
});

test("more_tools lists the areas, then one area's capabilities with what each does", async () => {
  const { get, registry: reg } = app();
  const areas = (await get("more_tools").run({}, context())).data.areas;
  assert.deepEqual(areas.map((a) => a.area), [
    "music", "pills", "sessions", "permissions", "timer", "apps", "views", "settings", "chat", "wardrobe", "recap", "mochi", "services", "web", "coucou",
  ]);
  assert.deepEqual(get("more_tools").args.area.enum, areas.map((a) => a.area));
  assert.equal(areas.flatMap((a) => a.capabilities).length, reg.all().length);
  const music = (await get("more_tools").run({ area: "music" }, context())).data;
  assert.equal(music.capabilities.find((c) => c.name === "pause_music").description, get("pause_music").description);
  assert.equal((await get("more_tools").run({ area: "secrets" }, context())).status, "failed");
});

test("undo is the registry's own, and escalate only says so", async () => {
  const { get, log } = app();
  assert.equal((await get("undo").run({}, context())).line, "Put back");
  assert.deepEqual((await get("escalate").run({ reason: "a long plan" }, context())).data, { escalate: true, reason: "a long plan" });
  assert.deepEqual(log, []);
});

// ── What stays private ────────────────────────────────────────────────────────

const source = (name) => readFileSync(join(SOURCES, name), "utf8");
const FILES = readdirSync(SOURCES).filter((name) => name.endsWith(".ts"));

/** The bridge's commands the assistant must have no path to (src/core/bridge.ts). */
const PRIVATE_COMMANDS = [
  "approvalDecision", "approval_decision", "approvalAck", "approval_ack", "hooksApply", "hooks_apply", "hooksPreview", "hooks_preview",
  "agentHooksApply", "agent_hooks_apply", "agentHooksPreview", "statusLineApply", "status_line_apply", "statusLinePreview",
  "secretSet", "secret_set", "secretClear", "secret_clear", "secretPresent", "secret_present", "localSetKey", "local_set_key",
  "localConnect", "local_connect", "phoneLink", "phone_link", "phoneRelay", "phone_relay", "phoneChat", "phone_chat", "phoneDetails",
  "phoneAnswers", "phoneDiffs", "phoneServices", "phoneUsage", "shortcutsSuspend", "shortcuts_suspend", "pickFolder", "pick_folder",
  "recapClear", "recap_clear", "conversationDelete", "conversation_delete", "voiceEngineInstall", "voiceEngineRemove",
];

test("nothing private is declared: by name", () => {
  const { registry: reg } = app();
  const names = reg.all().map((c) => c.name);
  for (const name of [
    "approve_permission", "allow_permission", "accept_permission", "answer_permission", "install_hooks", "remove_hooks", "uninstall_hooks",
    "install_status_line", "remove_status_line", "set_key", "set_secret", "read_secret", "clear_secret", "set_phone_link", "pair_phone",
    "set_shortcut", "set_server_address", "set_folder", "confirm", "set_guard",
  ]) {
    assert.ok(!names.includes(name), name);
  }
  // No name speaks of them either, whatever it is called.
  for (const name of names) {
    for (const part of ["approve", "allow", "hook", "status_line", "secret", "key", "token", "phone", "shortcut", "guard", "password"]) {
      assert.ok(!name.split("_").includes(part), `${name}: ${part}`);
    }
  }
});

test("nothing private is declared: no capability, argument or entity speaks of a private command", async () => {
  const { registry: reg } = app();
  const told = [
    ...reg.all().flatMap((c) => [c.name, c.description, ...Object.entries(c.args).flatMap(([name, arg]) => [name, arg.description, ...(arg.enum ?? [])])]),
    ...reg.sources.flatMap((s) => [s.kind, s.description]),
    ...(await Promise.all(reg.sources.map(async (s) => (await s.list()).flatMap((e) => [e.id, e.label, e.hint ?? ""])))).flat(),
  ];
  for (const text of told) {
    for (const command of PRIVATE_COMMANDS) assert.ok(!text.includes(command), `${JSON.stringify(text)} names ${command}`);
  }
  // The settings that are entities are the schema's, and no other.
  const settings = await reg.sources.find((s) => s.kind === "setting").list();
  assert.deepEqual(settings.map((e) => e.id), SETTINGS.map((s) => s.key));
});

test("nothing private is reachable: the capabilities touch the app through the host alone", () => {
  for (const name of FILES) {
    const text = source(name);
    assert.ok(!/from "\.\.\/core\/(bridge|state)"/.test(text), `${name} imports the bridge or the state`);
    assert.ok(!/@tauri-apps/.test(text), `${name} imports Tauri`);
    assert.ok(!/\b(Bridge|State|invoke)\b\s*[.(]/.test(text), `${name} reaches past the host`);
    // Comments say what is left out; code has no such call.
    const code = text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    for (const command of PRIVATE_COMMANDS) assert.ok(!code.includes(command), `${name} names ${command}`);
  }
  // The host itself has no method for them: what the island implements is this list.
  const methods = [...source("host.ts").split("export interface AppHost")[1].matchAll(/^  (\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(methods.sort(), Object.keys(fake().host).sort());
  for (const method of methods) {
    assert.ok(!/approv|allow|hook|statusLine|secret|key|token|phone|shortcut|confirm|guard/i.test(method), method);
  }
});

test("no words decide what a sentence means: no pattern is matched against anything said", () => {
  for (const name of FILES) {
    const code = source(name).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    assert.ok(!/\.(test|match|matchAll|exec|search)\(/.test(code), `${name} matches a pattern`);
    assert.ok(!/RegExp/.test(code), `${name} builds a pattern`);
    assert.ok(!/from "\.\.\/voice\/(?!result")/.test(code), `${name} imports the old voice files`);
    // The only patterns are white space, to cut a text to one line.
    for (const literal of code.match(/\/(?![/*\s])(?:\\.|[^/\\\n])+\/[a-z]*(?=[),.;])/g) ?? []) {
      assert.ok(["/\\s+/", "/\\s/"].includes(literal), `${name}: ${literal}`);
    }
    for (const word of ["aliases", "synonyms", "SPOKEN", "_WORDS", "_NAMES", "names:"]) assert.ok(!code.includes(word), `${name}: ${word}`);
  }
});

test("appAreas gives each area's capabilities under one area name", () => {
  const made = fake();
  const areas = appAreas(made.host, registry());
  assert.equal(areas.length, 15);
  for (const area of areas) assert.equal(new Set(area.capabilities.map((c) => c.area)).size, 1);
});

test("replacing a pill that is not shown by one that already is changes nothing, and says so", async () => {
  const { get, s, log } = app();
  const shown = s.pills.active.find((id) => id !== s.pills.main);
  const hidden = "integration_notion" === shown ? "integration_resend" : "integration_notion";
  const result = await get("replace_pill").run({ remove: hidden, add: shown }, context());
  assert.equal(result.status, "failed");
  assert.match(result.detail, /is not shown, and .* already is/);
  assert.deepEqual(log, []);
});

test("pause and play are said as such, never as a toggle: a late reading of the player does not start the music", async () => {
  // The app last read the player as paused while it plays: a toggle would have started nothing — or the opposite.
  const { get, s, log } = app();
  s.music.running = true;
  s.music.playing = false;
  const paused = await get("pause_music").run({}, context());
  assert.equal(paused.status, "done");
  assert.ok(log.includes("music:pause") && !log.includes("music:playPause"));
  assert.equal(s.music.playing, false);
  const played = await get("play_music").run({}, context());
  assert.ok(log.includes("music:play"));
  assert.equal(played.verified, true);
  assert.equal(s.music.playing, true);
});
