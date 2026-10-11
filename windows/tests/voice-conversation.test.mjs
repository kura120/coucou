// A sentence, then the next (src/voice/conversation.ts): the question Mochi
// asks when a name is no app (src/voice/ask.ts), the short memory of the last
// turns (src/voice/memory.ts, a port of the Mac's ConversationContext and its
// tests), and what a model is given of them. The apps "near" a name come from
// Rust (src-tauri/src/voice/apps.rs, tested there); here they are a table.

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { availablePills } from "../src/core/pills.ts";
import { readAnswer } from "../src/voice/ask.ts";
import { MOST_MODEL_ROUNDS, VoiceConversation, WORDING_MS } from "../src/voice/conversation.ts";
import { FORGOTTEN_AFTER_MS, MOST_TURNS, VoiceMemory, resolveRelative } from "../src/voice/memory.ts";
import { VoiceRunner } from "../src/voice/runner.ts";
import { misheardApps, systemPrompt, toolSchemas } from "../src/voice/tools.ts";
import { followUpKind } from "../src/island/voice.ts";

const PILLS = availablePills("windows");
const APPS = ["Spotify", "Steam", "Discord", "Figma", "Visual Studio Code", "Visual Studio 2022"];
/** What Rust's `near` ranks for a name that is no app: [names, the first is clearly the one]. */
const NEAR = {
  "spy flight": [["Spotify"], true],
  "this squad": [["Discord"], true],
  "the squad": [["Discord"], true],
  "steem": [["Steam"], true],
  "st": [["Spotify", "Steam"], false],
  "visual studio": [["Visual Studio 2022", "Visual Studio Code"], false],
};

/**
 * A conversation over fakes. `brain`: what the model proposes for a sentence
 * (a function of the sentence), or null for no model chosen.
 */
function setup({ brain = null, after = null, active = ["integration_github"], permission = null } = {}) {
  const log = [];
  const asked = [];
  const pills = { active: [...active], main: "integration_claude" };
  const state = { permission, playing: true, now: 1_000_000 };
  const runner = new VoiceRunner(
    {
      enabled: () => true, running: () => true, playing: () => state.playing, shuffle: () => false, repeat: () => false,
      playPause: () => {
        state.playing = !state.playing;
        log.push(state.playing ? "play" : "pause");
      },
      next: () => log.push("next"), previous: () => log.push("previous"),
      setShuffle: (on) => log.push(`shuffle:${on}`), setRepeat: (on) => log.push(`repeat:${on}`), open: () => log.push("openSpotify"),
    },
    {
      active: () => [...pills.active],
      main: () => pills.main,
      hasRoomFor: () => pills.active.length < 6,
      limit: () => 6,
      toggle: (id) => {
        const on = !pills.active.includes(id);
        pills.active = on ? [...pills.active, id] : pills.active.filter((x) => x !== id);
        log.push(`${on ? "+" : "-"}${id}`);
      },
      setMain: (id) => {
        log.push(`main:${id}`);
        pills.main = id;
      },
    },
    () => PILLS,
  );
  const world = {
    agents: () => [],
    openSession: () => false,
    permission: () => state.permission,
    showPermission: () => log.push("showPermission"),
    declinePermission: () => {
      log.push("DECLINE");
      state.permission = null;
    },
    timer: () => null,
    setTimer: () => {},
    cancelTimer: () => false,
    // As Rust's `find`: only a name that is an app's opens anything.
    openApp: async (name) => {
      const app = APPS.find((a) => a.toLowerCase() === name.toLowerCase());
      if (app) log.push(`app:${app}`);
      return app ?? null;
    },
    // As Rust's `voice_apps_near`: the app the name is (`found`), and the ones near it.
    appsNear: async (said) => {
      const text = ` ${said.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()} `;
      const found = APPS.find((a) => ` ${a.toLowerCase()} ` === text) ?? null;
      const named = APPS.filter((a) => text.includes(` ${a.toLowerCase()} `));
      if (named.length) return { found, names: named.slice(0, 3), scores: named.slice(0, 3).map(() => 1), clear: named.length === 1 };
      const heard = Object.keys(NEAR).find((key) => text.includes(` ${key} `));
      if (!heard) return { found, names: [], scores: [], clear: false };
      return { found, names: NEAR[heard][0], scores: NEAR[heard][0].map(() => 0.8), clear: NEAR[heard][1] };
    },
    openFolder: async () => null,
    openUrl: (url) => log.push(`url:${url}`),
    nowPlaying: () => null,
    reports: () => ({}),
  };
  // `after`: what the model does once its tools have run (the rounds after
  // the first); without one it has nothing to add.
  const rounds = [];
  const ask = brain
    ? async (system, said, tools, history, steps = []) => {
        if (steps.length) {
          rounds.push({ system, steps: structuredClone(steps) });
          return after ? after(steps, said) : { calls: [], text: "" };
        }
        asked.push({ system, said, tools, history });
        return brain(said, history);
      }
    : null;
  const conversation = new VoiceConversation(runner, world, () => PILLS, () => ask, () => state.now);
  // The card's side of a result: what is asked, as the island's ask component gets it, is looked at apart.
  const card = (result) => (result ? { outcome: result.outcome, message: result.message } : result);
  const hear = async (said, how) => card(await conversation.hear(said, how));
  return { log, asked, rounds, hear, conversation, runner, state, pills };
}

const call = (name, args = {}) => ({ name, arguments: args });
const question = (message) => ({ outcome: "question", message });
const done = (message) => ({ outcome: "success", message });

// ── Did you mean ──────────────────────────────────────────────────────────────

test("a name that is no app is asked about at once, and opened only on the yes", async () => {
  // "Hey Coucou, can you open Spotify?", as it was written down on 2026-10-11.
  for (const yes of ["yes", "Yeah.", "do it", "Yes please", "okay", "sure", "open it", "go ahead"]) {
    const s = setup({ brain: () => assert.fail("no model is waited for") });
    assert.deepEqual(await s.hear("can you open spy-flight?"), question("Open Spotify?"));
    assert.deepEqual(s.log, [], "nothing is opened on a guess");
    assert.ok(s.runner.asking);
    assert.deepEqual(await s.hear(yes), done("Spotify opened"), yes);
    assert.deepEqual(s.log, ["app:Spotify"]);
    assert.ok(!s.runner.asking);
  }
});

test("no, silence or never mind drops it", async () => {
  for (const no of ["no", "Nope.", "never mind", "cancel", "no thanks", "forget it", ""]) {
    const s = setup();
    assert.deepEqual(await s.hear("open this squad"), question("Open Discord?"));
    assert.deepEqual(await s.hear(no), done("OK, leaving it as is"), no);
    assert.deepEqual(s.log, []);
    assert.ok(!s.runner.asking);
    // And the next sentence is a command again, not an answer.
    assert.deepEqual(await s.hear("next track"), done("Next track"));
  }
});

test("another name said instead is tried, and another command is done as one", async () => {
  const s = setup();
  await s.hear("open spy flight");
  assert.deepEqual(await s.hear("no, discord"), done("Discord opened"));
  assert.deepEqual(s.log, ["app:Discord"]);

  const again = setup();
  await again.hear("open spy flight");
  assert.deepEqual(await again.hear("I meant Steam"), done("Steam opened"));

  // A name that is no app either is asked about in turn — once: then it is not found.
  const twice = setup();
  await twice.hear("open spy flight");
  assert.deepEqual(await twice.hear("this squad"), question("Open Discord?"));
  assert.deepEqual(await twice.hear("steem"), { outcome: "failure", message: "Not found: steem" });
  assert.deepEqual(twice.log, []);
  assert.ok(!twice.runner.asking);

  const other = setup();
  await other.hear("open spy flight");
  assert.deepEqual(await other.hear("next track"), done("Next track"));
  assert.deepEqual(other.log, ["next"]);
  assert.ok(!other.runner.asking);
});

test("two apps as near: Mochi asks which, and takes the name said", async () => {
  for (const [answer, app] of [
    ["Steam", "Steam"], ["spotify please", "Spotify"], ["the second one", "Steam"], ["the first", "Spotify"], ["open steam", "Steam"],
  ]) {
    const s = setup();
    assert.deepEqual(await s.hear("open st"), question("Spotify or Steam?"));
    assert.deepEqual(await s.hear(answer), done(`${app} opened`), answer);
    assert.deepEqual(s.log, [`app:${app}`]);
  }
  // A word only one of them has is enough.
  const s = setup();
  assert.deepEqual(await s.hear("open visual studio"), question("Visual Studio 2022 or Visual Studio Code?"));
  assert.deepEqual(await s.hear("code"), done("Visual Studio Code opened"));
  // "Yes" does not say which: asked once more, then left.
  const yes = setup();
  await yes.hear("open st");
  assert.deepEqual(await yes.hear("yes"), question("Spotify or Steam?"));
  assert.deepEqual(await yes.hear("yeah"), done("OK, leaving it as is"));
  assert.deepEqual(yes.log, []);
});

test("nothing near: said at once without a model, and left to the model when there is one", async () => {
  const s = setup();
  assert.deepEqual(await s.hear("open photoshop"), { outcome: "failure", message: "Not found: photoshop" });
  assert.ok(!s.runner.asking);

  const withModel = setup({ brain: () => ({ calls: [call("open_url", { url: "github.com" })], text: "" }) });
  assert.deepEqual(await withModel.hear("open github dot com"), done("github.com opened"));
  assert.equal(withModel.asked.length, 1);
  // A session is not an app either: the model is asked, not the list of apps.
  const session = setup({ brain: () => ({ calls: [], text: "No session." }) });
  await session.hear("open the discord session");
  assert.equal(session.asked.length, 1);
  assert.deepEqual(session.log, []);
});

test("what an answer means", () => {
  const one = ["Spotify"];
  const two = ["Spotify", "Steam"];
  assert.deepEqual(readAnswer("Yes.", one), { kind: "open", name: "Spotify" });
  assert.deepEqual(readAnswer("yes, Spotify", one), { kind: "open", name: "Spotify" });
  assert.deepEqual(readAnswer("that's the one", one), { kind: "open", name: "Spotify" });
  assert.deepEqual(readAnswer("Yes, yes.", one), { kind: "open", name: "Spotify" });
  assert.deepEqual(readAnswer("no", one), { kind: "no" });
  assert.deepEqual(readAnswer("", one), { kind: "no" });
  assert.deepEqual(readAnswer("yes", two), { kind: "unclear" });
  assert.deepEqual(readAnswer("the latter", two), { kind: "open", name: "Steam" });
  assert.deepEqual(readAnswer("no, discord", one), { kind: "other", said: "discord" });
  assert.deepEqual(readAnswer("I said figma", two), { kind: "other", said: "figma" });
  // Never a yes: words that only sound like agreeing to something else.
  for (const said of ["yes allow it", "approve", "allow", "yes decline that"]) {
    assert.equal(readAnswer(said, one).kind, "other", said);
  }
});

// ── The memory ────────────────────────────────────────────────────────────────

test("the turns are kept a minute and a half, a few of them, and nothing after voice is off", () => {
  const memory = new VoiceMemory();
  const turn = (said, action = null) => ({ said, calls: [], result: "ok", action });
  memory.remember(turn("add github", { kind: "add", ids: ["integration_github"] }), 0);
  memory.remember(turn("what's playing"), 30_000);
  assert.equal(memory.recent(60_000).length, 2);
  // A question in between does not hide what was done before it.
  assert.deepEqual(memory.last(60_000), { kind: "add", ids: ["integration_github"] });
  // Ninety seconds after the last turn, not after the first.
  assert.equal(memory.recent(30_000 + FORGOTTEN_AFTER_MS - 1).length, 2);
  assert.equal(memory.recent(30_000 + FORGOTTEN_AFTER_MS).length, 0);
  assert.equal(memory.last(30_000 + FORGOTTEN_AFTER_MS), null);
  for (let i = 0; i < 20; i++) memory.remember(turn(`turn ${i}`), 200_000 + i);
  assert.equal(memory.recent(200_100).length, MOST_TURNS);
  assert.equal(memory.recent(200_100)[0].said, `turn ${20 - MOST_TURNS}`);
  memory.clear();
  assert.equal(memory.recent(200_100).length, 0);
});

// ConversationContextTests.swift, in English.
test("a follow-up with no verb is the last action with the new name", () => {
  const relative = (said, last, bare = true) => resolveRelative(said, last, PILLS, bare)?.intent ?? null;
  const added = { kind: "add", ids: ["integration_github"] };
  const removed = { kind: "remove", ids: ["integration_github"] };
  const main = { kind: "main", id: "agent_codex", before: "integration_claude" };
  // testSameTarget_aussiFR, _pareilPour, _also
  assert.deepEqual(relative("and vercel too", added), { kind: "pillAdd", id: "integration_vercel" });
  assert.deepEqual(relative("same for stripe", added), { kind: "pillAdd", id: "integration_stripe" });
  assert.deepEqual(relative("also stripe", added), { kind: "pillAdd", id: "integration_stripe" });
  assert.deepEqual(relative("Vercel as well.", added), { kind: "pillAdd", id: "integration_vercel" });
  assert.deepEqual(relative("and vercel", removed), { kind: "pillRemove", id: "integration_vercel" });
  assert.deepEqual(relative("what about the stripe pill", removed), { kind: "pillRemove", id: "integration_stripe" });
  assert.deepEqual(relative("no, cursor", main), { kind: "pillSetMain", id: "agent_cursor" });
  // A bare name: the last action on that pill.
  assert.deepEqual(relative("vercel", added), { kind: "pillAdd", id: "integration_vercel" });
  // testNoContextReturnsNil: nothing before it, "and Vercel too" adds; anything else is not a follow-up.
  assert.deepEqual(relative("and vercel too", null), { kind: "pillAdd", id: "integration_vercel" });
  assert.equal(relative("xyz blabla blah", null), null);
  assert.equal(relative("vercel", null), null);
  assert.equal(relative("what about vercel", null), null);
  // testReverse_pillAdd, _musicPause
  assert.deepEqual(relative("put it back", added), { kind: "pillRemove", id: "integration_github" });
  assert.deepEqual(relative("undo that", removed), { kind: "pillAdd", id: "integration_github" });
  assert.deepEqual(relative("undo", { kind: "music", intent: { kind: "musicPause" } }), { kind: "musicPlay", target: null });
  assert.deepEqual(relative("cancel that", main), { kind: "pillSetMain", id: "integration_claude" });
  assert.equal(relative("undo", null), null);
  assert.equal(relative("undo", { kind: "open" }), null, "an app that was opened is not closed");
  // What the Mac does not have: the name of something to open.
  const opened = { kind: "open" };
  assert.deepEqual(relative("What about Steam?", opened), { kind: "open", name: "steam" });
  assert.deepEqual(relative("and Figma", opened), { kind: "open", name: "figma" });
  assert.deepEqual(relative("No, Discord.", opened), { kind: "open", name: "discord" });
  assert.deepEqual(relative("discord instead", opened), { kind: "open", name: "discord" });
  assert.deepEqual(relative("steam", opened), { kind: "open", name: "steam" });
  // A command of its own after "and" is that command, not a name.
  assert.equal(relative("and pause", opened), null);
  assert.equal(relative("and next track", opened), null);
  // Said to nobody in particular, a bare name is nothing.
  assert.equal(relative("steam", opened, false), null);
  assert.equal(relative("vercel", added, false), null);
  assert.deepEqual(relative("and vercel too", added, false), { kind: "pillAdd", id: "integration_vercel" });
  // Nothing about a permission is ever carried over.
  for (const said of ["no decline that", "and allow it", "what about the request", "also approve", "deny", "and reject that too"]) {
    for (const last of [added, removed, main, opened, null]) assert.equal(relative(said, last), null, said);
  }
});

test("what about Steam: the parser's turns are remembered, and a follow-up builds on them", async () => {
  const s = setup();
  assert.deepEqual(await s.hear("open spotify"), done("Spotify opened"));
  assert.deepEqual(await s.hear("What about Steam?"), done("Steam opened"));
  assert.deepEqual(await s.hear("and discord too"), done("Discord opened"));
  // A name that is no app is asked about here too.
  assert.deepEqual(await s.hear("what about steem"), question("Open Steam?"));
  assert.deepEqual(await s.hear("no"), done("OK, leaving it as is"));
  assert.deepEqual(s.log, ["app:Spotify", "app:Steam", "app:Discord"]);

  const pills = setup();
  assert.deepEqual(await pills.hear("add vercel"), done("Vercel added"));
  assert.deepEqual(await pills.hear("and stripe too"), done("Stripe added"));
  assert.deepEqual(await pills.hear("put it back"), done("Stripe removed"));
  assert.deepEqual(await pills.hear("switch to codex"), done("Main: Codex"));
  assert.deepEqual(await pills.hear("undo"), done("Main: VS Code"));
  assert.deepEqual(await pills.hear("pause"), done("Paused"));
  // "back" alone is the previous track; "put it back" after a pause is the pause undone.
  assert.deepEqual(await pills.hear("put it back"), done("Playing"));
  assert.deepEqual(pills.log, [
    "+integration_vercel", "+integration_stripe", "-integration_stripe", "main:agent_codex", "main:integration_claude", "pause", "play",
  ]);
});

test("a follow-up is forgotten with the turn it followed", async () => {
  const s = setup();
  await s.hear("open spotify");
  s.state.now += FORGOTTEN_AFTER_MS;
  assert.equal((await s.hear("what about steam")).outcome, "failure");
  assert.deepEqual(s.log, ["app:Spotify"]);
  // And when voice is turned off.
  await s.hear("open spotify");
  s.conversation.forget();
  assert.equal((await s.hear("what about steam")).outcome, "failure");
  assert.deepEqual(s.log, ["app:Spotify", "app:Spotify"]);
});

test("a bare name after opening an app opens only what is installed, and is nothing when nobody was spoken to", async () => {
  const s = setup();
  await s.hear("open spotify");
  assert.deepEqual(await s.hear("Steam"), done("Steam opened"));
  // Not an app: not a follow-up, so "not recognised" like any other sentence — no question.
  assert.equal((await s.hear("lunch")).outcome, "failure");
  assert.ok(!s.runner.asking);
  // Without the wake phrase a bare name is nothing, and so is a follow-up that names nothing.
  assert.equal(await s.hear("Discord", { spokenTo: false }), null);
  assert.equal(await s.hear("what about lunch", { spokenTo: false }), null);
  assert.deepEqual(await s.hear("what about discord", { spokenTo: false }), done("Discord opened"));
  assert.deepEqual(s.log, ["app:Spotify", "app:Steam", "app:Discord"]);
});

test("without the wake phrase, a follow-up that says it is one is a command, or looked up first", () => {
  const added = { kind: "add", ids: ["integration_github"] };
  assert.equal(followUpKind("and vercel too", PILLS, false, added), "command");
  assert.equal(followUpKind("put it back", PILLS, false, added), "command");
  assert.equal(followUpKind("vercel", PILLS, false, added), "nothing");
  // An app is looked up before anything shows.
  assert.equal(followUpKind("what about steam", PILLS, false, { kind: "open" }), "ask");
  assert.equal(followUpKind("steam", PILLS, false, { kind: "open" }), "nothing");
  assert.equal(followUpKind("what about steam", PILLS, false, null), "nothing");
  assert.equal(followUpKind("next track", PILLS, false, added), "command");
});

// ── What a model is given, and what it may do with it ─────────────────────────

test("the model gets the turns before, each with what was done and what came of it", async () => {
  const s = setup({ brain: (said) => (said.includes("same") ? { calls: [call("open_app", { name: "Steam" })], text: "" } : { calls: [], text: "Nothing." }) });
  await s.hear("open spotify");
  await s.hear("what's the weather like");
  assert.deepEqual(await s.hear("can you do the same with steam"), done("Steam opened"));
  assert.deepEqual(s.asked[1].history, [
    { said: "open spotify", calls: [call("open_app", { name: "Spotify" })], result: "Spotify opened" },
    { said: "what's the weather like", calls: [], result: "Nothing." },
  ]);
  // And its own turn is remembered for the next.
  await s.hear("thanks for that then");
  assert.deepEqual(s.asked[2].history[2], { said: "can you do the same with steam", calls: [call("open_app", { name: "Steam" })], result: "Steam opened" });
});

test("a word for opening may come from the turn before, and only after something was opened", async () => {
  const open = (name) => () => ({ calls: [call("open_app", { name })], text: "" });
  // After "open Spotify": the name is in the sentence, the verb was said a turn ago.
  const after = setup({ brain: open("Steam") });
  await after.hear("open spotify");
  assert.deepEqual(await after.hear("can you do steam as well please"), done("Steam opened"));
  // After nothing, or after something else, the same sentence opens nothing: it is asked about.
  for (const before of [null, "add vercel", "pause"]) {
    const s = setup({ brain: open("Steam") });
    if (before) await s.hear(before);
    assert.deepEqual(await s.hear("can you do steam as well please"), question("Open Steam?"), String(before));
    assert.ok(!s.log.includes("app:Steam"));
  }
  // An app the sentence does not name is never opened on the strength of the last turn.
  const guess = setup({ brain: open("Discord") });
  await guess.hear("open spotify");
  assert.equal((await guess.hear("can you do the other one as well")).outcome, "failure");
  assert.deepEqual(guess.log, ["app:Spotify"]);
});

test("nothing about a permission is carried over, and voice still never approves", async () => {
  const WAITING = { agent: "Codex", request: "Bash: rm -rf dist" };
  // "decline" a turn ago does not decline now.
  const s = setup({ permission: WAITING, brain: () => ({ calls: [call("decline_permission")], text: "" }) });
  assert.deepEqual(await s.hear("no decline that"), done("Denied"));
  s.state.permission = WAITING;
  assert.equal((await s.hear("and the other one too")).outcome, "failure");
  assert.equal((await s.hear("same again")).outcome, "failure");
  assert.deepEqual(s.log, ["DECLINE"]);
  // After opening an app, "allow it" still only brings the card up.
  const allow = setup({ permission: WAITING, brain: () => ({ calls: [call("open_app", { name: "Steam" })], text: "" }) });
  await allow.hear("open spotify");
  assert.equal(await allow.hear("yeah allow it"), null);
  assert.deepEqual(allow.log, ["app:Spotify", "showPermission"]);
  // A sentence about a permission goes to the model alone: no turns before it.
  const alone = setup({ permission: WAITING, brain: () => ({ calls: [call("decline_permission")], text: "" }) });
  await alone.hear("open spotify");
  assert.deepEqual(await alone.hear("no decline that"), done("Denied"));
  assert.deepEqual(alone.asked[0].history, []);
  // And "yes" to "Open Spotify?" opens Spotify, whatever is waiting.
  const yes = setup({ permission: WAITING });
  await yes.hear("open spy flight");
  assert.deepEqual(await yes.hear("yes"), done("Spotify opened"));
  assert.deepEqual(yes.log, ["app:Spotify"]);
  assert.ok(yes.state.permission, "the permission still waits for a click");
});

test("the model is told which apps a misheard name may be, and may ask about them", async () => {
  // Not the apps the sentence names as they are, and never the whole list.
  assert.deepEqual(misheardApps("what is claude doing", ["Claude"]), []);
  assert.deepEqual(misheardApps("pull up this squad", ["Discord"]), ["Discord"]);
  assert.ok(!systemPrompt({}).includes("misheard name of an application"));
  assert.ok(systemPrompt({}, ["Discord"]).includes('["Discord"]'));
  const names = (near) => toolSchemas(PILLS, near).map((tool) => tool.function.name);
  assert.ok(!names([]).includes("ask_which_app"));
  assert.ok(names(["Discord"]).includes("ask_which_app"));

  const s = setup({ brain: () => ({ calls: [call("ask_which_app", { apps: ["Discord"] })], text: "" }) });
  assert.deepEqual(await s.hear("could you pull up this squad for me"), question("Open Discord?"));
  assert.ok(s.asked[0].system.includes('["Discord"]'));
  assert.deepEqual(await s.hear("yes"), done("Discord opened"));
  // An app it was not told of is not asked about.
  const other = setup({ brain: () => ({ calls: [call("ask_which_app", { apps: ["Figma"] })], text: "" }) });
  assert.equal((await other.hear("could you pull up this squad for me")).outcome, "failure");
  assert.ok(!other.runner.asking);
  // Its own guess at the app is a question too, never an app opened.
  const guess = setup({ brain: () => ({ calls: [call("open_app", { name: "Discord" })], text: "" }) });
  assert.deepEqual(await guess.hear("could you pull up this squad for me"), question("Open Discord?"));
  assert.deepEqual(guess.log, []);
  // Said to nobody: no question.
  const quiet = setup({ brain: () => ({ calls: [call("ask_which_app", { apps: ["Discord"] })], text: "" }) });
  assert.equal(await quiet.hear("could you pull up this squad for me", { spokenTo: false }), null);
  assert.ok(!quiet.runner.asking);
});

test("an answer that comes after it was given up on does nothing", async () => {
  const s = setup({ brain: () => ({ calls: [call("add_pills", { pills: ["Vercel"] })], text: "" }) });
  let waited = 0;
  assert.equal(await s.hear("vercel would be nice up there", { waiting: () => (waited += 1), wanted: () => false }), null);
  assert.equal(waited, 1, "the island is told at once that there is a wait");
  assert.deepEqual(s.log, []);
  assert.deepEqual(await s.hear("vercel would be nice up there", { wanted: () => true }), done("Vercel added"));
});

// ── The rounds of a turn (the model sees what its tools came to) ──────────────

test("once its tools have run, the model is given what came of them and words the answer", async () => {
  const s = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: () => ({ calls: [], text: "  Stripe is up\nthere now. " }),
  });
  assert.deepEqual(await s.hear("could you put stripe up there for me"), done("Stripe is up there now."));
  assert.equal(s.rounds.length, 1);
  // The first round's prompt is untouched; the next one says the tools have run.
  assert.ok(!s.asked[0].system.includes("have run"));
  assert.ok(s.rounds[0].system.startsWith(s.asked[0].system) && s.rounds[0].system.includes("have run"));
  const [step] = s.rounds[0].steps;
  assert.deepEqual(step.calls, [call("add_pills", { pills: ["Stripe"] })]);
  // The status first, and whether it was seen to work: not only the card's line.
  assert.deepEqual(JSON.parse(step.results[0]), { status: "done", verified: false, result: "Stripe added" });
  // What is remembered is what Mochi said.
  assert.equal(s.conversation.memory.recent(s.state.now).at(-1).result, "Stripe is up there now.");
});

test("a model with nothing to add, or too slow to say it, leaves the tool's own line", async () => {
  const silent = setup({ brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }) });
  assert.deepEqual(await silent.hear("could you put stripe up there for me"), done("Stripe added"));
  const never = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: () => new Promise(() => {}),
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const heard = never.hear("could you put stripe up there for me");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    mock.timers.tick(WORDING_MS);
    assert.deepEqual(await heard, done("Stripe added"));
  } finally {
    mock.timers.reset();
  }
});

test("the model may go on with another tool, and nothing is done twice for one sentence", async () => {
  const s = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: (steps) =>
      steps.length === 1
        ? { calls: [call("add_pills", { pills: ["Stripe"] }), call("add_pills", { pills: ["Vercel"] })], text: "" }
        : { calls: [], text: "Stripe and Vercel are both there." },
  });
  assert.deepEqual(await s.hear("could you put stripe and vercel up there"), done("Stripe and Vercel are both there."));
  assert.deepEqual(s.log.filter((l) => l.startsWith("+")), ["+integration_stripe", "+integration_vercel"]);
  assert.equal(s.rounds.length, 2);
  assert.equal(s.rounds[1].steps.length, 2);

  // A model that only repeats itself is not asked again, and nothing runs again.
  const stuck = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
  });
  assert.deepEqual(await stuck.hear("could you put stripe up there for me"), done("Stripe added"));
  assert.deepEqual(stuck.log.filter((l) => l.startsWith("+")), ["+integration_stripe"]);
  assert.equal(stuck.rounds.length, 1);
});

test("a turn is a few rounds at most, and what failed is what the card shows, in the tool's own words", async () => {
  let n = 0;
  const names = ["Vercel", "Notion", "Resend", "Linear", "Sentry", "Supabase", "Cloudflare"].filter((name) => PILLS.some((p) => p.name === name));
  const endless = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: () => ({ calls: [call("add_pills", { pills: [names[n++ % names.length]] })], text: "" }),
    active: [],
  });
  await endless.hear(`could you put stripe ${names.join(" ")} up there`);
  assert.ok(endless.rounds.length < MOST_MODEL_ROUNDS + 1, `${endless.rounds.length} rounds`);

  const failing = setup({
    brain: () => ({ calls: [call("cancel_timer")], text: "" }),
    after: () => ({ calls: [], text: "The timer is cancelled." }),
  });
  // Whatever the model makes of a failure, the card says what did not happen.
  assert.deepEqual(await failing.hear("get rid of that timer"), { outcome: "failure", message: "No timer is running" });
  assert.equal(JSON.parse(failing.rounds[0].steps[0].results[0]).status, "failed");
});

test("an answer with no tool is one round, and so is a sentence said to nobody", async () => {
  const s = setup({ brain: () => ({ calls: [], text: "Two plus two is four." }), after: () => assert.fail("nothing ran: nothing to word") });
  assert.deepEqual(await s.hear("what is two plus two"), done("Two plus two is four."));
  const quiet = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: () => assert.fail("nobody is waiting for words"),
  });
  assert.deepEqual(await quiet.hear("put stripe up there", { spokenTo: false }), done("Stripe added"));
});

// ── A question on screen (voice/result.ts `Ask`) ──────────────────────────────

test("a question goes up, waits, and comes down with its answer; one at a time", async () => {
  const s = setup();
  const ups = [];
  s.conversation.onAsk = (ask) => ups.push(ask ? ask.question : null);
  const first = s.conversation.askUser({ kind: "yes_no", question: "Open Spotify?" });
  assert.equal(s.conversation.asked.question, "Open Spotify?");
  // Asked over another: the first is dropped.
  const second = s.conversation.askUser({ kind: "text", question: "  What then?  " });
  assert.deepEqual(await first, { kind: "dropped" });
  assert.equal(s.conversation.asked.question, "What then?");
  assert.equal(s.conversation.answer({ kind: "text", value: "nothing" }), true);
  assert.deepEqual(await second, { kind: "text", value: "nothing" });
  assert.equal(s.conversation.asked, null);
  assert.equal(s.conversation.answer({ kind: "dropped" }), false, "nothing was waiting");
  assert.deepEqual(ups, ["Open Spotify?", null, "What then?", null]);
  // A question that cannot be shown is dropped at once, and forgetting drops one that waits.
  assert.deepEqual(await s.conversation.askUser({ kind: "choice", question: "Which?", options: [] }), { kind: "dropped" });
  const waiting = s.conversation.askUser({ kind: "yes_no", question: "Sure?" });
  s.conversation.forget();
  assert.deepEqual(await waiting, { kind: "dropped" });
});

test("the model may ask once a tool has run, and goes on from the answer", async () => {
  const s = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: (steps) => {
      if (steps.length === 1) return { calls: [call("ask_user", { question: "Vercel as well?", kind: "yes_no" })], text: "" };
      const answered = JSON.parse(steps[1].results[0]);
      return answered.result === "yes"
        ? steps.length === 2
          ? { calls: [call("add_pills", { pills: ["Vercel"] })], text: "" }
          : { calls: [], text: "Stripe and Vercel are there now." }
        : { calls: [], text: "Stripe is there." };
    },
  });
  s.conversation.onAsk = (ask) => {
    if (ask) queueMicrotask(() => s.conversation.answer({ kind: "yes_no", yes: true }));
  };
  assert.deepEqual(await s.hear("put stripe up there and maybe vercel"), done("Stripe and Vercel are there now."));
  assert.deepEqual(s.log.filter((l) => l.startsWith("+")), ["+integration_stripe", "+integration_vercel"]);
  // The tool to ask with is offered only once a tool has run.
  const offered = (tools) => tools.some((tool) => tool.function.name === "ask_user");
  assert.ok(!offered(s.asked[0].tools));

  // Dropped: the model is told, and what was done stays said.
  const dropped = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: (steps) => (steps.length === 1 ? { calls: [call("ask_user", { question: "Vercel as well?", kind: "yes_no" })], text: "" } : { calls: [], text: "Stripe is there." }),
  });
  dropped.conversation.onAsk = (ask) => {
    if (ask) queueMicrotask(() => dropped.conversation.answer({ kind: "dropped" }));
  };
  const result = await dropped.hear("put stripe up there and maybe vercel");
  assert.deepEqual(dropped.log.filter((l) => l.startsWith("+")), ["+integration_stripe"]);
  assert.equal(result.outcome, "failure");
});

test("a model that asks before any tool has run, or of nobody, asks nothing", async () => {
  const early = setup({ brain: () => ({ calls: [call("ask_user", { question: "What do you mean?" })], text: "" }) });
  early.conversation.onAsk = () => assert.fail("nothing is asked in the first round");
  assert.equal((await early.hear("do the thing with the stuff")).outcome, "failure");
  const quiet = setup({
    brain: () => ({ calls: [call("add_pills", { pills: ["Stripe"] })], text: "" }),
    after: () => ({ calls: [call("ask_user", { question: "Vercel as well?" })], text: "" }),
  });
  quiet.conversation.onAsk = () => assert.fail("nobody was spoken to");
  await quiet.hear("put stripe up there", { spokenTo: false });
});

