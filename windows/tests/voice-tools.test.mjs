// What a model may ask Coucou to do (src/voice/tools.ts): every proposal is
// checked against what was said before anything happens. The proposals below
// are ones small local models really made (doc/voice-v2-plan.md), and worse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { availablePills } from "../src/core/pills.ts";
import { VoiceRunner } from "../src/voice/runner.ts";
import {
  asksToApprove, describeState, intentOf, minutesSaid, names, runProposal, systemPrompt, toolSchemas, webAddress,
} from "../src/voice/tools.ts";

const PILLS = availablePills("windows");
const call = (name, args = {}) => ({ name, arguments: args });

function setup({ active = ["integration_github", "integration_vercel", "integration_stripe"], permission = null, timer = null, apps = ["Figma"] } = {}) {
  const log = [];
  const pills = { active: [...active], main: "integration_claude" };
  const runner = new VoiceRunner(
    {
      enabled: () => true, running: () => true, playing: () => true, shuffle: () => false, repeat: () => false,
      playPause: () => log.push("playPause"), next: () => log.push("next"), previous: () => log.push("previous"),
      setShuffle: (on) => log.push(`shuffle:${on}`), setRepeat: (on) => log.push(`repeat:${on}`), open: () => log.push("openSpotify"),
    },
    {
      active: () => [...pills.active],
      main: () => pills.main,
      hasRoomFor: () => pills.active.length < 6,
      limit: () => 6,
      toggle: (id) => {
        log.push(`toggle:${id}`);
        pills.active = pills.active.includes(id) ? pills.active.filter((x) => x !== id) : [...pills.active, id];
      },
      setMain: (id) => {
        log.push(`main:${id}`);
        pills.main = id;
      },
    },
    () => PILLS,
  );
  const state = { permission, timer };
  const world = {
    agents: () => [{ id: "agent_codex", name: "Codex", state: "working", doing: "running the tests" }],
    openSession: (id) => (log.push(`session:${id}`), id === "agent_codex"),
    permission: () => state.permission,
    showPermission: () => log.push("showPermission"),
    declinePermission: () => {
      log.push("DECLINE");
      state.permission = null;
    },
    timer: () => state.timer,
    setTimer: (minutes, label) => {
      log.push(`timer:${minutes}:${label}`);
      state.timer = { label, minutesLeft: minutes };
    },
    cancelTimer: () => {
      const had = state.timer != null;
      state.timer = null;
      return had;
    },
    openApp: async (name) => (log.push(`app:${name}`), apps.find((a) => a.toLowerCase() === name.toLowerCase()) ?? null),
    openFolder: async (name) => (log.push(`folder:${name}`), /download/i.test(name) ? "Downloads" : null),
    openUrl: (url) => log.push(`url:${url}`),
    nowPlaying: () => "Get Lucky — Daft Punk",
    reports: () => ({ GitHub: "main: passing" }),
  };
  const propose = (said, calls, text = "") => runProposal({ calls, text }, said, runner, world, PILLS);
  return { log, pills, propose, world, runner, state };
}

const WAITING = { agent: "Codex", request: "Bash: rm -rf dist" };

// ── The permission: the one thing a model must never get wrong ────────────────

test("no tool approves a permission, and none sends anything", () => {
  const names = toolSchemas(PILLS).map((tool) => tool.function.name);
  for (const name of names) assert.doesNotMatch(name, /allow|approve|accept|grant|send|mail|run|exec|shell|command/, name);
  assert.ok(names.includes("decline_permission") && names.includes("show_permission_request"));
});

test("a model that declines when asked to allow does not decline", async () => {
  // What two local models did with "yeah allow it" and "approve the request".
  for (const said of ["yeah allow it", "approve the request", "ok go ahead and accept that", "allow"]) {
    const s = setup({ permission: WAITING });
    assert.equal(await s.propose(said, [call("decline_permission")]), null, said);
    assert.deepEqual(s.log, ["showPermission"], said); // the card comes up: a click decides
    assert.deepEqual(s.state.permission, WAITING);
  }
});

test("a model that declines on anything but a word for declining does not decline", async () => {
  // "uh never mind" → decline_permission, from a real run.
  for (const said of ["uh never mind", "stop repeating this", "what is the request", "no", "next track"]) {
    const s = setup({ permission: WAITING });
    const result = await s.propose(said, [call("decline_permission")]);
    assert.equal(result.outcome, "failure", said);
    assert.ok(!s.log.includes("DECLINE"), said);
  }
});

test("declining works when the sentence says so, and only while a request waits", async () => {
  for (const said of ["decline that", "no, deny it", "refuse the request", "reject it", "don't allow that"]) {
    const s = setup({ permission: WAITING });
    assert.deepEqual(await s.propose(said, [call("decline_permission")]), { outcome: "success", message: "Denied" }, said);
    assert.deepEqual(s.log, ["DECLINE"], said);
  }
  const s = setup();
  assert.deepEqual(await s.propose("decline it", [call("decline_permission")]), { outcome: "failure", message: "No request is waiting" });
  assert.deepEqual(s.log, []);
});

test("asking what the request is shows its card and answers nothing", async () => {
  const s = setup({ permission: WAITING });
  assert.equal(await s.propose("what's the permission request", [call("show_permission_request")]), null);
  assert.deepEqual(s.log, ["showPermission"]);
  const none = setup();
  assert.equal((await none.propose("what's the request", [call("show_permission_request")])).outcome, "failure");
});

test("approval words are only that without a word for declining", () => {
  for (const said of ["allow it", "yes approve", "accept the request", "go ahead"]) assert.equal(asksToApprove(said), true, said);
  for (const said of ["don't allow that", "do not allow it", "deny", "next track", "allowance"]) assert.equal(asksToApprove(said), false, said);
});

// ── Pills: only the ones the sentence names ───────────────────────────────────

test("a pill the sentence does not name is not touched", async () => {
  // "show me the gemini pill" → replace_pill(Codex → Gemini CLI), from a real run.
  const s = setup();
  const result = await s.propose("show me the gemini pill", [call("replace_pill", { remove: "Codex", add: "Gemini CLI" })]);
  assert.equal(result.outcome, "failure");
  // "i only want github and vercel" → remove_pills([Stripe, n8n]): pills nobody named.
  assert.equal((await s.propose("i only want github and vercel", [call("remove_pills", { pills: ["Stripe", "n8n"] })])).outcome, "failure");
  assert.deepEqual(s.log, []);
});

test("keep only needs the word for it", async () => {
  // "add notion and resend" → keep_only_pills([... six pills]), from a real run.
  const s = setup();
  const wrong = await s.propose("can you add notion and resend to my pills", [
    call("keep_only_pills", { pills: ["GitHub", "Vercel", "Stripe", "Notion", "Resend"] }),
  ]);
  assert.equal(wrong.outcome, "failure");
  assert.deepEqual(s.log, []);
  const right = await s.propose("i only want github and vercel up there", [call("keep_only_pills", { pills: ["GitHub", "Vercel"] })]);
  assert.deepEqual(right, { outcome: "success", message: "Only: GitHub, Vercel" });
  assert.deepEqual(s.pills.active, ["integration_github", "integration_vercel"]);
});

test("pills named in the sentence are added, removed, swapped, even misheard", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("can you add notion and resend to my pills", [call("add_pills", { pills: ["Notion", "Resend"] })]),
    { outcome: "success", message: "Notion, Resend added" });
  assert.deepEqual(await s.propose("get rid of stripe", [call("remove_pills", { pills: ["Stripe"] })]), { outcome: "success", message: "Stripe removed" });
  assert.deepEqual(await s.propose("swap vercel for n eight n", [call("replace_pill", { remove: "Vercel", add: "n8n" })]),
    { outcome: "success", message: "Vercel → n8n" });
  // The recogniser wrote "get hub".
  const again = setup({ active: [] });
  assert.deepEqual(await again.propose("ad get hub", [call("add_pills", { pills: ["GitHub"] })]), { outcome: "success", message: "GitHub added" });
});

test("the main pill is a workspace tool the sentence names", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("make cursor my main one", [call("set_main_pill", { pill: "Cursor" })]), { outcome: "success", message: "Main: Cursor" });
  assert.equal((await s.propose("make it the main one", [call("set_main_pill", { pill: "Codex" })])).outcome, "failure");
  assert.equal((await s.propose("make github my main one", [call("set_main_pill", { pill: "GitHub" })])).outcome, "failure");
  assert.deepEqual(s.log, ["main:agent_cursor"]);
});

test("names: a way of saying the pill, or words that can only be it", () => {
  assert.ok(names("show me claude's terminal", "integration_claude", PILLS));
  assert.ok(names("add get hub please", "integration_github", PILLS));
  assert.ok(names("the gemini pill", "agent_gemini", PILLS));
  assert.ok(!names("show me the gemini pill", "agent_codex", PILLS));
  assert.ok(!names("add something", "integration_github", PILLS));
  assert.ok(!names("add github", "not_a_pill", PILLS));
});

test("arguments that are not what the tool takes are refused, not guessed", async () => {
  const s = setup();
  for (const bad of [
    call("add_pills", {}), call("add_pills", { pills: [] }), call("add_pills", { pills: [42, null] }),
    call("add_pills", { pills: ["Banana"] }), call("music", { action: "explode" }), call("music"),
    call("replace_pill", { remove: "GitHub" }), call("set_timer", { minutes: -3 }), call("set_timer", { minutes: "soon" }),
    call("set_timer", { minutes: 99999 }), call("open_url", { url: "javascript:alert(1)" }), call("open_url", {}),
    call("format_disk", { drive: "C" }), call("", {}),
  ]) {
    const result = await s.propose("add github and banana at github dot com", [bad]);
    assert.equal(result.outcome, "failure", JSON.stringify(bad));
  }
  assert.deepEqual(s.log, []);
  // The arguments of the shape some servers send: a string where a list is asked.
  assert.deepEqual(intentOf(call("add_pills", { pills: "GitHub" }), "add github", PILLS), { kind: "pillAdd", id: "integration_github" });
});

// ── Music, timers, opening things ─────────────────────────────────────────────

test("music goes through the same runner as a spoken command", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("hold the music for a sec", [call("music", { action: "pause" })]), { outcome: "success", message: "Paused" });
  assert.deepEqual(await s.propose("skip this song", [call("music", { action: "next" })]), { outcome: "success", message: "Next track" });
  assert.deepEqual(await s.propose("stop repeating this", [call("music", { action: "repeat_off" })]), { outcome: "success", message: "Repeat off" });
  assert.deepEqual(s.log, ["playPause", "next", "repeat:false"]);
});

test("timers: set, said back, cancelled", async () => {
  const s = setup();
  assert.deepEqual(
    await s.propose("remind me in twenty minutes to take out the laundry", [call("set_timer", { minutes: 20, label: "take out the laundry" })]),
    { outcome: "success", message: "Timer set: 20 min" },
  );
  assert.deepEqual(s.log, ["timer:20:take out the laundry"]);
  assert.deepEqual(await s.propose("cancel the timer", [call("cancel_timer")]), { outcome: "success", message: "Timer cancelled" });
  assert.deepEqual(await s.propose("cancel the timer", [call("cancel_timer")]), { outcome: "failure", message: "No timer is running" });
  // Minutes as a string, as some models write numbers.
  assert.equal((await s.propose("timer five minutes", [call("set_timer", { minutes: "5" })])).message, "Timer set: 5 min");
});

test("the minutes are the ones that were said, whatever the model wrote", async () => {
  assert.equal(minutesSaid("timer five minutes"), 5);
  assert.equal(minutesSaid("remind me in twenty five minutes to stretch"), 25);
  assert.equal(minutesSaid("set a timer for 90 min"), 90);
  assert.equal(minutesSaid("in an hour"), 60);
  assert.equal(minutesSaid("two hours and a half"), 150);
  assert.equal(minutesSaid("one hour and ten minutes"), 70);
  assert.equal(minutesSaid("half an hour"), 30);
  assert.equal(minutesSaid("a timer please"), null);
  assert.equal(minutesSaid("the last five tracks"), null);
  const s = setup();
  // Models write "five", or a number nobody said.
  assert.equal((await s.propose("timer five minutes", [call("set_timer", { minutes: "five" })])).message, "Timer set: 5 min");
  assert.equal((await s.propose("timer five minutes", [call("set_timer", { minutes: 50 })])).message, "Timer set: 5 min");
});

test("opening needs a word for opening, and the app is the one the user named", async () => {
  // "ad get hub" → open_app(GitHub), from a real run: nobody asked to open anything.
  const s = setup({ apps: ["GitHub Desktop", "Visual Studio Code"] });
  assert.equal((await s.propose("ad get hub", [call("open_app", { name: "GitHub Desktop" })])).outcome, "failure");
  assert.equal((await s.propose("github dot com", [call("open_url", { url: "github.com" })])).outcome, "failure");
  assert.equal((await s.propose("downloads", [call("open_folder", { name: "downloads" })])).outcome, "failure");
  assert.deepEqual(s.log, []);
  // "launch visual studio code" → open_app("VS Code"): a pill's name, not the app's.
  assert.deepEqual(
    await s.propose("launch visual studio code", [call("open_app", { name: "VS Code" })]),
    { outcome: "success", message: "Visual Studio Code opened" },
  );
  assert.deepEqual(s.log, ["app:visual studio code"]);
});

test("a model asked to open Spotify goes through Spotify's own way in, not the Start menu", async () => {
  // The Store's Spotify has no shortcut to find: "Not found" was the first answer.
  const s = setup({ apps: [] });
  assert.deepEqual(await s.propose("could you bring up spotify for me", [call("open_app", { name: "Spotify" })]), { outcome: "success", message: "Spotify opened" });
  assert.deepEqual(s.log, ["openSpotify"]);
});

test("opening: an app by name, a folder of the user's, an http address — or not found", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("open figma", [call("open_app", { name: "figma" })]), { outcome: "success", message: "Figma opened" });
  assert.deepEqual(await s.propose("open photoshop", [call("open_app", { name: "photoshop" })]), { outcome: "failure", message: "Not found: photoshop" });
  assert.deepEqual(await s.propose("open my downloads folder", [call("open_folder", { name: "downloads" })]), { outcome: "success", message: "Downloads opened" });
  assert.equal((await s.propose("open the system folder", [call("open_folder", { name: "C:\\Windows" })])).outcome, "failure");
  assert.deepEqual(await s.propose("open github dot com", [call("open_url", { url: "github.com" })]), { outcome: "success", message: "github.com opened" });
  assert.ok(s.log.includes("url:https://github.com/"));
});

test("a web address is http or https, with a real host and no credentials", () => {
  assert.equal(webAddress("github.com"), "https://github.com/");
  assert.equal(webAddress("http://example.org/a?b=1"), "http://example.org/a?b=1");
  for (const bad of ["", "localhost", "file:///c:/windows", "javascript:alert(1)", "ftp://x.org", "https://user:pw@x.org", "two words.com", "calc.exe && x"]) {
    assert.equal(webAddress(bad), null, bad);
  }
});

test("an agent's session is opened when the sentence names it and it has one", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("open the codex session", [call("open_session", { agent: "Codex" })]), { outcome: "success", message: "Codex" });
  assert.equal((await s.propose("show me claude's terminal", [call("open_session", { agent: "VS Code" })])).outcome, "failure"); // no session in the fake
  assert.equal((await s.propose("show me the terminal", [call("open_session", { agent: "Codex" })])).outcome, "failure"); // not named
  assert.deepEqual(s.log, ["session:agent_codex", "session:integration_claude"]);
});

// ── Answers, several things, nothing ──────────────────────────────────────────

test("an answer in words is shown, cut to a sentence", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("is the ci green", [], "  Yes, main is\npassing. "), { outcome: "success", message: "Yes, main is passing." });
  const long = await s.propose("tell me everything", [], "word ".repeat(100));
  assert.ok(long.message.length <= 160 && long.message.endsWith("…"));
});

test("no call and no answer is not recognised; changing one's mind shows nothing", async () => {
  const s = setup();
  assert.deepEqual(await s.propose("blah blah", [], ""), { outcome: "failure", message: "Not recognised: « blah blah »" });
  assert.equal(await s.propose("uh never mind", [call("nothing")]), null);
  assert.deepEqual(s.log, []);
});

test("several things asked are each done, at most three, and a failure is the one shown", async () => {
  const s = setup();
  assert.deepEqual(
    await s.propose("pause the music and remove stripe", [call("music", { action: "pause" }), call("remove_pills", { pills: ["Stripe"] })]),
    { outcome: "success", message: "Stripe removed" },
  );
  const mixed = await s.propose("pause and remove banana", [call("music", { action: "pause" }), call("remove_pills", { pills: ["Banana"] })]);
  assert.equal(mixed.outcome, "failure");
  const many = setup();
  await many.propose("next next next next next", Array.from({ length: 6 }, () => call("music", { action: "next" })));
  assert.deepEqual(many.log, ["next", "next", "next"]);
});

test("a full island still asks which pill to remove, and nothing after the question runs", async () => {
  const six = ["integration_github", "integration_vercel", "integration_stripe", "integration_notion", "integration_resend", "integration_n8n"];
  const s = setup({ active: six });
  const result = await s.propose("add gemini and pause", [call("add_pills", { pills: ["Gemini CLI"] }), call("music", { action: "pause" })]);
  assert.deepEqual(result, { outcome: "question", message: "6 active — remove which?" });
  assert.deepEqual(s.log, []);
  assert.equal(s.runner.asking, true);
});

// ── What the model is given ───────────────────────────────────────────────────

test("the tools are valid function schemas, with the catalog's pill names", () => {
  const tools = toolSchemas(PILLS);
  assert.ok(tools.length >= 12);
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.match(tool.function.name, /^[a-z_]+$/);
    assert.ok(tool.function.description.length > 10);
    assert.equal(tool.function.parameters.type, "object");
    for (const required of tool.function.parameters.required) assert.ok(required in tool.function.parameters.properties);
  }
  const add = tools.find((tool) => tool.function.name === "add_pills").function.parameters.properties.pills;
  assert.deepEqual(add.items.enum, PILLS.map((p) => p.name));
  const main = tools.find((tool) => tool.function.name === "set_main_pill").function.parameters.properties.pill;
  assert.deepEqual(main.enum, ["VS Code", "Cursor", "Antigravity", "Codex"]);
  assert.ok(JSON.stringify(tools).length < 48 * 1024); // what Rust accepts
});

test("the model is told about the app by name, never by pill ID, and the prompt fits", () => {
  const s = setup({ permission: WAITING, timer: { label: "tea", minutesLeft: 4 } });
  const state = describeState(s.world, s.runner, PILLS);
  assert.deepEqual(state.active_pills, ["GitHub", "Vercel", "Stripe"]);
  assert.equal(state.main_pill, "VS Code");
  assert.deepEqual(state.permission_waiting, WAITING);
  assert.equal(state.timer, "4 min left: tea");
  assert.equal(state.now_playing, "Get Lucky — Daft Punk");
  const prompt = systemPrompt(state);
  assert.doesNotMatch(prompt, /integration_|agent_/);
  assert.match(prompt, /cannot approve or allow/);
  assert.ok(prompt.length < 16 * 1024); // what Rust accepts
});
