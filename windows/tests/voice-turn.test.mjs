// One sentence through the three tiers (src/voice/turn.ts), against fakes:
// a small app declared on the real registry, an embedding model that is a
// table of vectors, and models that answer from a script. No model server is
// asked, nothing is opened, nothing is recorded.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/core/capabilities/registry.ts";
import { done, failed } from "../src/voice/result.ts";
import { FORGOTTEN_AFTER_MS } from "../src/voice/memory.ts";
import { MOST_MODEL_ROUNDS, VoiceTurns, looksWritten, written } from "../src/voice/turn.ts";

const WORDS = {
  refused: () => "I can't do that", unavailable: () => "Not possible now", failed: () => "That did not work",
  notFound: (said) => `Not found: ${said}`, unchanged: () => "Leaving it as is", nothingToUndo: () => "Nothing to put back",
  one: (label) => `Did you mean ${label}?`, which: (labels) => `${labels.join(" or ")}?`,
};
const TURN_WORDS = {
  noModel: () => "Voice needs a model server", silent: () => "The model did not answer",
  notUnderstood: () => "Not recognised", beyond: () => "More than I can do here", askingCloud: () => "Asking a bigger model…",
};

let app;
let clicks;
let now;

/** A small app: music, pills, a view, something that takes a click, and the capabilities about the conversation. */
function makeApp() {
  const state = { playing: true, pills: ["github"], view: "overview", quit: false, log: [] };
  const registry = createRegistry({ guard: { confirm: async (c) => (clicks.shift() ?? false) && Boolean(c) }, words: WORDS, doubted: () => false });
  const cap = (c) => registry.declare({ args: {}, tier: "free", ...c });
  registry.entities({ kind: "pill", description: "The pills.", list: () => [{ id: "github", label: "GitHub" }, { id: "vercel", label: "Vercel" }, { id: "stripe", label: "Stripe" }] });
  registry.entities({ kind: "view", description: "The views.", list: () => [{ id: "chat", label: "Chat" }, { id: "wardrobe", label: "Wardrobe" }] });
  cap({
    name: "now_playing", area: "music", description: "Reads what is playing.", tier: "read", inSnapshot: true,
    run: async () => done("Song — Artist", true, { playing: state.playing, title: "Song" }),
  });
  cap({
    name: "pause_music", area: "music", description: "Pauses the music.", tier: "reversible",
    inverse: () => ({ name: "play_music", arguments: {} }),
    run: async () => {
      state.log.push("pause");
      state.playing = false;
      return done("Paused", true);
    },
  });
  cap({
    name: "play_music", area: "music", description: "Plays the music.", tier: "reversible",
    inverse: () => ({ name: "pause_music", arguments: {} }),
    run: async () => {
      state.log.push("play");
      state.playing = true;
      return done("Playing", true);
    },
  });
  cap({
    name: "add_pills", area: "pills", description: "Adds pills.", tier: "reversible",
    args: { pills: { type: "entities", kind: "pill", description: "The pills to add." } },
    inverse: (args) => ({ name: "remove_pills", arguments: { pills: args.pills } }),
    run: async (args) => {
      state.log.push(`add:${args.pills.join(",")}`);
      state.pills.push(...args.pills);
      return done(`${args.pills.join(", ")} added`, true);
    },
  });
  cap({
    name: "remove_pills", area: "pills", description: "Removes pills.", tier: "reversible",
    args: { pills: { type: "entities", kind: "pill", description: "The pills to remove." } },
    inverse: (args) => ({ name: "add_pills", arguments: { pills: args.pills } }),
    run: async (args) => {
      state.log.push(`remove:${args.pills.join(",")}`);
      state.pills = state.pills.filter((p) => !args.pills.includes(p));
      return done(`${args.pills.join(", ")} removed`, true);
    },
  });
  cap({
    name: "show_view", area: "views", description: "Shows a view.",
    args: { view: { type: "entity", kind: "view", description: "The view." } },
    run: async (args) => {
      state.log.push(`view:${args.view}`);
      state.view = args.view;
      return done(`${args.view} opened`, true);
    },
  });
  cap({
    name: "open_app", area: "apps", description: "Opens an app.", args: { app: { type: "string", description: "Its name." } },
    run: async (args) => {
      state.log.push(`open:${args.app}`);
      return args.app === "Nope" ? failed("Nope did not open", "No window came.") : done(`Asked Windows to open ${args.app}`, false);
    },
  });
  cap({
    name: "quit_coucou", area: "coucou", description: "Quits Coucou.", tier: "confirm",
    describe: () => ({ title: "Quit Coucou?", change: "Coucou closes.", action: "Quit" }),
    run: async () => {
      state.log.push("quit");
      state.quit = true;
      return done("Quitting", false);
    },
  });
  cap({ name: "undo", area: "coucou", description: "Puts the last change back.", run: (_a, context) => registry.undo(context) });
  cap({ name: "nothing", area: "coucou", description: "Does nothing.", run: async () => done("", true) });
  cap({ name: "escalate", area: "coucou", description: "Hands over to a stronger model.", run: async () => done("", false, { escalate: true }) });
  cap({
    name: "more_tools", area: "coucou", description: "Lists an area's capabilities.", tier: "read",
    args: { area: { type: "string", optional: true, description: "The area." } },
    run: async (args) => {
      const found = registry.areas().find((a) => a.area === args.area);
      return found ? done("", true, { area: found.area, capabilities: found.names.map((name) => ({ name, description: "" })) }) : done("", true, { areas: registry.areas() });
    },
  });
  return { registry, state };
}

/** An embedding model as a table: each text's vector is where its capability's name sits, by the words given. */
function embedBy(near) {
  const names = app.registry.all().map((c) => c.name);
  const axis = (name) => names.map((n) => (n === name ? 1 : 0));
  return async (texts) =>
    texts.map((text) => {
      // A capability's own text: its axis.
      const own = app.registry.all().find((c) => text === `${c.area}: ${c.description}`);
      if (own) return axis(own.name);
      const weights = near[text.split("\n").pop()] ?? {};
      // "far": as near one capability as any other, which is near none.
      const vector = names.map((n) => (weights === "far" ? 1 : (weights[n] ?? 0)));
      return vector.some((x) => x) ? vector : names.map(() => 0.01);
    });
}

/** A model that answers from a script, and notes what it was asked with. */
/**
 * A model that answers from a script, and notes what it was asked with. With
 * no ranking the turn first asks which areas a sentence is about (one tool,
 * `about`): that is answered by `route` — no area unless a test says — and
 * noted apart, in `routes`.
 */
function scripted(...replies) {
  const asked = [];
  const routes = [];
  const self = { model: null, asked, routes, route: ["none", "none", "none"] };
  self.model = async (system, said, tools, history, steps) => {
    const names = tools.map((t) => t.function.name);
    if (names.length === 1 && names[0] === "about") {
      routes.push({ system, said, tools, history });
      const [first, second, third] = self.route;
      return calls(call("about", { first, second, third }));
    }
    asked.push({ system, said, tools: names, history, steps: steps ?? [] });
    const reply = replies.shift();
    return typeof reply === "function" ? reply(asked[asked.length - 1]) : reply;
  };
  return self;
}

const call = (name, args = {}) => ({ name, arguments: args });
const calls = (...list) => ({ calls: list, text: "" });
const says = (text) => ({ calls: [], text });

function turns({ embed = async () => null, local = null, cloud = null, publish, followUp = false } = {}) {
  return new VoiceTurns({
    registry: app.registry, embed, local: () => local, cloud: () => cloud, publish, followUp: () => followUp, words: TURN_WORDS, now: () => now,
  });
}

beforeEach(() => {
  clicks = [];
  now = 1_000_000;
  app = makeApp();
});

// ── Was it said to Coucou? ────────────────────────────────────────────────────

test("without the wake phrase, a sentence goes to a model only when it is on this computer", async () => {
  const local = scripted(calls(call("pause_music")));
  // A model server elsewhere: the sentence is for nobody, and nobody is asked.
  assert.deepEqual(await turns({ local: local.model }).hear("pause the music", { wake: false }), { result: null, taken: false, rest: false });
  // No model at all: the same.
  assert.equal((await turns({ followUp: true }).hear("pause the music", { wake: false })).taken, false);
  assert.equal(local.asked.length, 0);
  assert.deepEqual(app.state.log, []);
});

test("without the wake phrase the local model decides: nothing for what was said to someone else, and nothing shows", async () => {
  const local = scripted(calls(call("nothing")), calls(call("pause_music")), says("Paused."));
  const t = turns({ local: local.model, followUp: true });
  let taken = 0;
  const stray = await t.hear("see you at four then", { wake: false, taken: () => taken++ });
  assert.deepEqual(stray, { result: null, taken: false, rest: false });
  assert.equal(taken, 0);
  // It is told the sentence may not be for Coucou.
  assert.match(local.asked[0].system, /may have been said to someone else/);
  // Not a turn: nothing is remembered of it.
  assert.deepEqual(t.memory.recent(now), []);
  // Something the app does, asked for: taken once, before it runs.
  const meant = await t.hear("pause it", { wake: false, taken: () => taken++ });
  assert.equal(taken, 1);
  assert.deepEqual(meant.result, { outcome: "success", message: "Paused." });
  assert.deepEqual(app.state.log, ["pause"]);
});

test("without the wake phrase: words alone show nothing, tier 1 does not run, and the cloud is never asked", async () => {
  let clouded = 0;
  const cloud = async () => ((clouded += 1), { text: "" });
  // Ranked far ahead, a clear command for tier 1 — which waits for the wake phrase.
  const embed = embedBy({ "pause the music": { pause_music: 1 } });
  const local = scripted(says("Sure, four works."), calls(call("escalate")), null);
  const t = turns({ embed, local: local.model, cloud, followUp: true });
  assert.equal((await t.hear("pause the music", { wake: false })).taken, false);
  assert.deepEqual(app.state.log, []);
  // Handing up is not even offered for it, and a model that does not answer is not replaced by the cloud.
  assert.ok(!local.asked[0].tools.includes("escalate"));
  assert.equal((await t.hear("work out my week", { wake: false })).taken, false);
  assert.equal((await t.hear("hmm", { wake: false })).taken, false);
  assert.equal(clouded, 0);
});

test("tier 1: a clear command runs with no model call, and the thing it names is found in the sentence", async () => {
  const embed = embedBy({ "pause the music": { pause_music: 1 }, "add": { add_pills: 1 }, "show me the": { show_view: 1 } });
  const local = scripted();
  const t = turns({ embed, local: local.model });
  assert.deepEqual((await t.hear("pause the music")).result, { outcome: "success", message: "Paused" });
  assert.deepEqual((await t.hear("add vercel")).result, { outcome: "success", message: "vercel added" });
  assert.deepEqual((await t.hear("show me the wardrobe")).result, { outcome: "success", message: "wardrobe opened" });
  assert.deepEqual(app.state.log, ["pause", "add:vercel", "view:wardrobe"]);
  assert.equal(local.asked.length, 0);
});

test("tier 1 never runs what takes a click, and what it cannot name goes to the model", async () => {
  const embed = embedBy({ "quit coucou": { quit_coucou: 1 }, "add the thing": { add_pills: 1 } });
  const local = scripted(calls(call("quit_coucou")), says("Okay."), calls(call("nothing")));
  const t = turns({ embed, local: local.model });
  // Ranked first by far, but `confirm`: the model is asked, and the click still decides.
  const quit = await t.hear("quit coucou");
  assert.equal(local.asked.length, 2);
  assert.equal(app.state.quit, false);
  assert.deepEqual(quit.result, { outcome: "success", message: "Leaving it as is" });
  // No pill is named in the sentence: not found by the executor, so the model reads it.
  await t.hear("add the thing");
  assert.equal(local.asked.length, 3);
  assert.deepEqual(app.state.log, []);
});

test("a name that is only near is asked about before anything is done", async () => {
  const embed = embedBy({ "remove strife": { remove_pills: 1 } });
  const t = turns({ embed });
  const asks = [];
  t.onAsk = (ask) => {
    if (!ask) return;
    asks.push(ask.question);
    queueMicrotask(() => t.answer({ kind: "yes_no", yes: true }));
  };
  const heard = await t.hear("remove strife");
  assert.deepEqual(asks, ["Did you mean Stripe?"]);
  assert.deepEqual(app.state.log, ["remove:stripe"]);
  assert.equal(heard.result.outcome, "success");
});

// ── Tier 2 ────────────────────────────────────────────────────────────────────

test("with no model server, voice says what it needs", async () => {
  const heard = await turns().hear("pause the music");
  assert.deepEqual(heard.result, { outcome: "failure", message: "Voice needs a model server" });
  assert.deepEqual(app.state.log, []);
});

test("tier 2, ranked: the model is shown the nearest capabilities, its calls run, and its words are Mochi's", async () => {
  const embed = embedBy({ "could you stop the song and bring in": { pause_music: 0.6, add_pills: 0.55, play_music: 0.5 } });
  const local = scripted(calls(call("pause_music"), call("add_pills", { pills: ["stripe"] })), says("Paused, and Stripe is in."));
  const heard = await turns({ embed, local: local.model }).hear("could you stop the song and bring stripe in");
  assert.deepEqual(app.state.log, ["pause", "add:stripe"]);
  assert.deepEqual(heard.result, { outcome: "success", message: "Paused, and Stripe is in." });
  // The nearest first — Stripe is a pill, so what takes pills is counted nearer — then the ones always shown, and no handing up with nobody to hand up to.
  assert.deepEqual(local.asked[0].tools.slice(0, 3), ["add_pills", "pause_music", "play_music"]);
  assert.ok(local.asked[0].tools.includes("more_tools") && local.asked[0].tools.includes("nothing"));
  assert.ok(!local.asked[0].tools.includes("escalate"));
  // The second round is given what each call came to: its status first.
  assert.deepEqual(local.asked[1].steps[0].calls.map((c) => c.name), ["pause_music", "add_pills"]);
  assert.match(local.asked[1].steps[0].results[0], /"status":"done","verified":true/);
  // The state of the app is in what it is told, read by the app itself.
  assert.match(local.asked[0].system, /"now_playing"/);
});

test("tier 2, with no embedding model: the areas first, then those areas' capabilities", async () => {
  const local = scripted(calls(call("pause_music")), says("Paused."));
  local.route = ["music", "none", "nonsense"];
  const heard = await turns({ local: local.model }).hear("pause the music");
  // One tool, the areas as its values, and the app's state to tell what a name belongs to.
  assert.equal(local.routes.length, 1);
  assert.deepEqual(local.routes[0].tools[0].function.parameters.properties.first.enum, ["music", "pills", "views", "apps", "coucou", "none"]);
  assert.match(local.routes[0].system, /music: now playing, pause music, play music/);
  assert.match(local.routes[0].system, /"now_playing"/);
  // Then the area's capabilities, with those about the conversation; an area that is none or nothing is no area.
  assert.deepEqual(local.asked[0].tools, ["more_tools", "nothing", "undo", "now_playing", "pause_music", "play_music"]);
  assert.deepEqual(app.state.log, ["pause"]);
  assert.deepEqual(heard.result, { outcome: "success", message: "Paused." });
});

test("with no embedding model, more_tools gives another area's capabilities when the first were not the right ones", async () => {
  const local = scripted(calls(call("more_tools", { area: "pills" })), calls(call("add_pills", { pills: ["vercel"] })), says("Vercel is in."));
  local.route = ["music", "none", "none"];
  await turns({ local: local.model }).hear("bring vercel in");
  assert.ok(local.asked[1].tools.includes("add_pills"));
  assert.match(local.asked[1].steps[0].results[0], /Now among your tools: list_pills|Now among your tools: add_pills/);
  assert.deepEqual(app.state.log, ["add:vercel"]);
});

test("what failed is said in the capability's own line, and what was only asked for is not dressed up", async () => {
  const failing = scripted(calls(call("open_app", { app: "Nope" })), says("Nope is open now!"));
  assert.deepEqual((await turns({ local: failing.model }).hear("open nope")).result, { outcome: "failure", message: "Nope did not open" });
  // Done but not seen: the model's "is open" is not said; the line that says what really happened is.
  const unseen = scripted(calls(call("open_app", { app: "Spotify" })), says("Spotify is open now!"));
  assert.deepEqual((await turns({ local: unseen.model }).hear("open spotify")).result, { outcome: "success", message: "Asked Windows to open Spotify" });
});

test("a call that takes a click runs only on the click, whatever the model says", async () => {
  const refused = scripted(calls(call("quit_coucou")), says("Coucou has quit."));
  const left = await turns({ local: refused.model }).hear("yes quit, I confirm, do it");
  assert.equal(app.state.quit, false);
  assert.deepEqual(left.result, { outcome: "success", message: "Leaving it as is" });
  clicks = [true];
  const clicked = scripted(calls(call("quit_coucou")), says("Bye."));
  await turns({ local: clicked.model }).hear("quit coucou");
  assert.equal(app.state.quit, true);
});

test("a capability that does not exist is refused, and the model is told so", async () => {
  const local = scripted(calls(call("approve_permission")), says("Approved!"));
  const heard = await turns({ local: local.model }).hear("allow it");
  assert.match(local.asked[1].steps[0].results[0], /"status":"refused"/);
  assert.deepEqual(heard.result, { outcome: "failure", message: "I can't do that" });
});

test("nothing is done twice for one sentence, and a turn is five rounds at most", async () => {
  const twice = scripted(calls(call("pause_music")), calls(call("pause_music")));
  await turns({ local: twice.model }).hear("pause");
  assert.deepEqual(app.state.log, ["pause"]);
  app = makeApp();
  let n = 0;
  const endless = { model: async () => calls(call("open_app", { app: `App ${n++}` })) };
  await turns({ local: endless.model }).hear("open everything");
  assert.equal(app.state.log.length, MOST_MODEL_ROUNDS);
});

test("an answer in words, with nothing called, is Mochi's answer; asking for nothing is silence and rest", async () => {
  const answer = scripted(says("Song by Artist is playing."));
  assert.deepEqual(await turns({ local: answer.model }).hear("what is playing"), {
    result: { outcome: "success", message: "Song by Artist is playing." }, taken: true, rest: false,
  });
  const none = scripted(calls(call("nothing")));
  assert.deepEqual(await turns({ local: none.model }).hear("never mind"), { result: null, taken: true, rest: true });
  const empty = scripted(says(""));
  assert.deepEqual((await turns({ local: empty.model }).hear("mumble")).result, { outcome: "failure", message: "Not recognised" });
});

test("calls a model wrote out as text are calls, and its plumbing is never said", async () => {
  const known = new Set(["pause_music", "add_pills"]);
  assert.deepEqual(written('{"name": "pause_music", "arguments": {}}', known), [call("pause_music")]);
  assert.deepEqual(written('```json\n[{"name":"add_pills","arguments":"{\\"pills\\":[\\"Stripe\\"]}"}]\n```', known), [call("add_pills", { pills: ["Stripe"] })]);
  assert.deepEqual(written('{"name": "rm_rf", "arguments": {}}', known), []);
  assert.deepEqual(written("I paused the music.", known), []);
  assert.equal(looksWritten('{"name": "x"}'), true);
  assert.equal(looksWritten("Paused."), false);
  const local = scripted(says('{"name": "pause_music", "arguments": {}}'), says('{"oops": 1}'));
  const heard = await turns({ local: local.model }).hear("pause");
  assert.deepEqual(app.state.log, ["pause"]);
  assert.deepEqual(heard.result, { outcome: "success", message: "Paused" });
});

// ── The memory of turns ───────────────────────────────────────────────────────

test("the last turns are given to the model as data, undo is the registry's, and it is all forgotten in time", async () => {
  const local = scripted(
    calls(call("add_pills", { pills: ["vercel"] })), says("Vercel is in."),
    calls(call("undo")), says("Put back."),
    says("Nothing before this."),
  );
  const t = turns({ local: local.model });
  await t.hear("add vercel");
  assert.deepEqual(local.asked[0].history, []);
  await t.hear("no wait, put that back");
  assert.deepEqual(local.asked[2].history, [{ said: "add vercel", calls: [call("add_pills", { pills: ["vercel"] })], result: "Vercel is in." }]);
  assert.deepEqual(app.state.log, ["add:vercel", "remove:vercel"]);
  now += FORGOTTEN_AFTER_MS;
  await t.hear("and now?");
  assert.deepEqual(local.asked[4].history, []);
  // Voice turned off: nothing is kept.
  await t.hear("add vercel".replace("add", "what about"));
  t.forget();
  assert.deepEqual(t.memory.recent(now), []);
});

// ── A question on screen ──────────────────────────────────────────────────────

test("a spoken answer to a choice or a yes/no is read by the model, given the question and its options as one tool", async () => {
  const reader = scripted(calls(call("answer", { option: "2" })), calls(call("answer", { option: "unclear" })), calls(call("answer", { option: "yes" })));
  const t = turns({ local: reader.model });
  const which = t.askUser({ kind: "choice", question: "Which account?", options: [{ id: "work", label: "Work" }, { id: "home", label: "Home", hint: "a@home" }] });
  assert.deepEqual(await t.answerSaid("the home one"), { is: "answer" });
  assert.deepEqual(await which, { kind: "choice", id: "home" });
  assert.deepEqual(reader.asked[0].tools, ["answer"]);
  assert.match(reader.asked[0].system, /Which account\?[\s\S]*1: Work\n2: Home \(a@home\)/);
  assert.equal(reader.asked[0].said, "the home one");
  // Not an answer: the question stays.
  const open = t.askUser({ kind: "yes_no", question: "Open Spotify?" });
  assert.deepEqual(await t.answerSaid("what time is it"), { is: "unclear" });
  assert.ok(t.asked);
  assert.deepEqual(await t.answerSaid("yeah go on"), { is: "answer" });
  assert.deepEqual(await open, { kind: "yes_no", yes: true });
});

test("a text question is dictation: the words are taken as they are, and nothing said confirms it", async () => {
  const reader = scripted();
  const t = turns({ local: reader.model });
  const asked = t.askUser({ kind: "text", question: "What should it say?" });
  assert.deepEqual(await t.answerSaid("the build is ready"), { is: "draft", value: "the build is ready" });
  assert.deepEqual(await t.answerSaid("confirm", "the build is ready"), { is: "draft", value: "the build is ready confirm" });
  assert.equal(reader.asked.length, 0);
  assert.ok(t.asked);
  t.answer({ kind: "text", value: "the build is ready" });
  assert.deepEqual(await asked, { kind: "text", value: "the build is ready" });
});

test("with no model nothing said answers a question: a click or a key does", async () => {
  const t = turns();
  const asked = t.askUser({ kind: "yes_no", question: "Open Spotify?" });
  assert.deepEqual(await t.answerSaid("yes"), { is: "unclear" });
  t.answer({ kind: "yes_no", yes: true });
  assert.deepEqual(await asked, { kind: "yes_no", yes: true });
});

test("no to a question, with a request of its own, is heard as the next turn", async () => {
  const embed = embedBy({ "remove strife": { remove_pills: 1 } });
  const local = scripted(calls(call("answer", { option: "no", also_asks: true })));
  const t = turns({ embed, local: local.model });
  t.onAsk = (ask) => {
    if (ask) queueMicrotask(() => void t.answerSaid("no, github"));
  };
  const heard = await t.hear("remove strife");
  assert.deepEqual(app.state.log, []);
  assert.equal(heard.next, "no, github");
  assert.deepEqual(heard.result, { outcome: "success", message: "Leaving it as is" });
});

// ── Tier 3 ────────────────────────────────────────────────────────────────────

test("tier 3: handed up only when the user allowed a cloud model, which reaches the app through the executor", async () => {
  // Off: handing up is not even offered, and a model that tries is told there is no such thing to do.
  const alone = scripted(calls(call("escalate", { reason: "too hard" })));
  const beyond = await turns({ local: alone.model }).hear("plan my week");
  assert.ok(!alone.asked[0].tools.includes("escalate"));
  assert.deepEqual(beyond.result, { outcome: "failure", message: "More than I can do here" });

  const published = [];
  let t;
  const cloud = async (system, said, history) => {
    assert.match(system, /"now_playing"/);
    assert.equal(said, "plan my week");
    assert.deepEqual(history, []);
    // It asks for capabilities through its endpoint, one at a time.
    assert.match(await t.cloudCall("pause_music", {}), /"status":"done"/);
    assert.match(await t.cloudCall("quit_coucou", {}), /Nothing was changed/);
    assert.match(await t.cloudCall("approve_permission", {}), /"status":"refused"/);
    return { text: "Paused, and your week is planned." };
  };
  const local = scripted(calls(call("escalate", { reason: "too hard" })));
  t = turns({ local: local.model, cloud, publish: (tools) => published.push(tools.map((x) => x.function.name)) });
  const waits = [];
  const heard = await t.hear("plan my week", { waiting: (line, ms) => waits.push([line, ms]) });
  assert.ok(local.asked[0].tools.includes("escalate"));
  assert.deepEqual(app.state.log, ["pause"]);
  assert.equal(app.state.quit, false);
  // Something was refused on the way: its own line is what is shown.
  assert.deepEqual(heard.result, { outcome: "failure", message: "I can't do that" });
  // The cloud is given every capability but the two that speak to the local model.
  assert.equal(published.length, 1);
  assert.ok(published[0].includes("pause_music") && !published[0].includes("escalate") && !published[0].includes("more_tools"));
  assert.deepEqual(waits[waits.length - 1], ["Asking a bigger model…", 150_000]);
});

test("a capability asked for when no turn is with the cloud model is for nobody: refused", async () => {
  const t = turns({ cloud: async () => ({ text: "" }) });
  assert.match(await t.cloudCall("pause_music", {}), /"status":"refused"/);
  assert.deepEqual(app.state.log, []);
});

test("a local model that does not answer: the cloud model when allowed, else it is said", async () => {
  const silent = async () => null;
  assert.deepEqual((await turns({ local: silent }).hear("pause")).result, { outcome: "failure", message: "The model did not answer" });
  let t;
  const cloud = async () => {
    await t.cloudCall("pause_music", {});
    return { text: "Paused." };
  };
  t = turns({ local: silent, cloud });
  assert.deepEqual((await t.hear("pause")).result, { outcome: "success", message: "Paused." });
  assert.deepEqual(app.state.log, ["pause"]);
});

test("a turn nobody waits for any more does nothing further", async () => {
  let wanted = true;
  const local = scripted(
    () => {
      wanted = false;
      return calls(call("pause_music"));
    },
  );
  const heard = await turns({ local: local.model }).hear("pause", { wanted: () => wanted });
  assert.deepEqual(heard, { result: null, taken: true, rest: false });
  assert.deepEqual(app.state.log, []);
});

test("a name the app has is not embedded, and what takes its kind is ranked nearer", async () => {
  const seen = [];
  const names = () => app.registry.all().map((c) => c.name);
  // The embedding model as a table: "remove" alone is nearest to undo, a little less to the pills.
  const embed = async (texts) =>
    texts.map((text) => {
      seen.push(text);
      const own = app.registry.all().find((c) => text === `${c.area}: ${c.description}`);
      if (own) return names().map((n) => (n === own.name ? 1 : 0));
      return names().map((n) => ({ undo: 0.72, remove_pills: 0.7, add_pills: 0.69 })[n] ?? 0.05);
    });
  const local = scripted(calls(call("remove_pills", { pills: ["stripe"] })), says("Stripe is gone."));
  await turns({ embed, local: local.model }).hear("remove Stripe");
  assert.ok(seen.includes("remove"), "the name is taken out of what is embedded");
  assert.ok(!seen.some((text) => /stripe/i.test(text) && !text.includes(":")));
  // Stripe is a pill: remove_pills and add_pills, which take pills, come before undo.
  assert.deepEqual(local.asked[0].tools.slice(0, 3), ["remove_pills", "add_pills", "undo"]);
});
