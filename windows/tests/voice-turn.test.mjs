// One sentence through the three tiers (src/voice/turn.ts), against fakes:
// a small app declared on the real registry, an embedding model that is a
// table of vectors, and models that answer from a script. No model server is
// asked, nothing is opened, nothing is recorded.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/core/capabilities/registry.ts";
import { done, failed } from "../src/voice/result.ts";
import { FORGOTTEN_AFTER_MS } from "../src/voice/memory.ts";
import { MOST_MODEL_ROUNDS, VoiceTurns, asHeard, grounded, looksWritten, unfounded, written } from "../src/voice/turn.ts";

const WORDS = {
  refused: () => "I can't do that", unavailable: () => "Not possible now", failed: () => "That did not work",
  notFound: (said) => `Not found: ${said}`, unchanged: () => "Leaving it as is", nothingToUndo: () => "Nothing to put back",
  one: (label) => `Did you mean ${label}?`, which: (labels) => `${labels.join(" or ")}?`,
};
const TURN_WORDS = {
  noModel: () => "Voice needs a model server", silent: () => "The model did not answer",
  noEmbedding: () => "Voice needs an embedding model", embedSilent: () => "The embedding model did not answer",
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

/** An embedding model that finds every capability as near as any other: a test that is not about the ranking. */
const flat = async (texts) => texts.map(() => [1]);

function turns({ embed = flat, embedChosen = true, local = null, cloud = null, publish, followUp = false } = {}) {
  return new VoiceTurns({
    registry: app.registry, embed, embedChosen: () => embedChosen, local: () => local, cloud: () => cloud, publish, followUp: () => followUp, words: TURN_WORDS, now: () => now,
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

test("tier 2, ranked: the model is shown the nearest capabilities, its calls run, and its words are checked against what they did", async () => {
  const embed = embedBy({ "could you stop the song and bring in": { pause_music: 0.6, add_pills: 0.55, play_music: 0.5 } });
  const local = scripted(calls(call("pause_music"), call("add_pills", { pills: ["stripe"] })), says("Paused, and Stripe is in."));
  const heard = await turns({ embed, local: local.model }).hear("could you stop the song and bring stripe in");
  assert.deepEqual(app.state.log, ["pause", "add:stripe"]);
  // The model's words, which name only what ran.
  assert.deepEqual(heard.result, { outcome: "success", message: "Paused, and Stripe is in." });
  assert.equal(heard.worded, true);
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

test("with no embedding model voice says it needs one, and with one that does not answer it says so; no model is asked", async () => {
  const local = scripted(calls(call("pause_music")));
  const none = await turns({ embed: async () => null, embedChosen: false, local: local.model }).hear("pause the music");
  assert.deepEqual(none.result, { outcome: "failure", message: "Voice needs an embedding model" });
  const silent = await turns({ embed: async () => null, local: local.model }).hear("pause the music");
  assert.deepEqual(silent.result, { outcome: "failure", message: "The embedding model did not answer" });
  assert.equal(local.asked.length, 0);
  assert.deepEqual(app.state.log, []);
  // Without the wake phrase, nothing shows at all.
  assert.deepEqual(await turns({ embed: async () => null, local: local.model, followUp: true }).hear("pause the music", { wake: false }), { result: null, taken: false, rest: false });
});

test("the wake phrase gets the embedding model ready, and the sentence after it waits for that, not for a second embedding", async () => {
  let asked = 0;
  const embed = async (texts) => {
    asked += 1;
    return texts.map(() => [1]);
  };
  const local = scripted(calls(call("pause_music")));
  const t = turns({ embed, local: local.model });
  t.warm();
  t.warm();
  await t.hear("pause the music");
  // One call for every capability, at the wake phrase; one for the sentence.
  assert.equal(asked, 2);
  assert.deepEqual(app.state.log, ["pause"]);
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
  // An empty answer is asked for once more; empty again, it was not understood.
  const empty = scripted(says(""), says(""));
  assert.deepEqual((await turns({ local: empty.model }).hear("mumble")).result, { outcome: "failure", message: "Not recognised" });
  assert.equal(empty.asked.length, 2);
  assert.match(empty.asked[1].system, /called a capability that does not exist here[\s\S]*Call one of your tools — [a-z_, ]*more_tools/);
  const second = scripted(says(""), calls(call("pause_music")));
  assert.deepEqual((await turns({ local: second.model }).hear("pause")).result, { outcome: "success", message: "Paused" });
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
  assert.match(reader.asked[0].system, /Which account\?[\s\S]*1: Work, option 1 of 2, the first\n2: Home \(a@home\), option 2 of 2, the last/);
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
  // The cloud model's words, checked against what ran like the local model's.
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

test("a name the app only nearly has is told to the model as most likely that thing, and counted in the ranking", async () => {
  // A kind too large to list: its source ranks what is near the sentence (as Rust ranks the installed apps).
  app.registry.entities({
    kind: "app",
    description: "The installed apps.",
    list: () => [],
    near: async (said) => (/spy flight/.test(said) ? [{ id: "Spotify", label: "Spotify", score: 0.8 }, { id: "Steam", label: "Steam", score: 0.3 }] : []),
  });
  assert.deepEqual(await app.registry.named("open spy flight"), [{ kind: "app", id: "Spotify", label: "Spotify", near: true }]);
  const local = scripted(calls(call("nothing")));
  await turns({ local: local.model }).hear("open spy flight");
  assert.match(local.asked[0].system, /In what was said, most likely Spotify \(app\), misheard: call with that name, and the app asks the user before it acts on it; or ask them yourself with ask_user\./);
  assert.doesNotMatch(local.asked[0].system, /In what was said[^\n]*Steam/);
});

test("what cannot be used right now is not offered, and is offered once a call makes it usable", async () => {
  let draft = "";
  app.registry.declare(
    { name: "write_note", area: "music", description: "Writes a note.", args: {}, tier: "free", run: async () => ((draft = "hi"), done("Written", true)) },
    { name: "send_note", area: "music", description: "Sends the note.", args: {}, tier: "free", available: () => (draft ? true : "There is no note"), run: async () => done("Sent", true) },
  );
  const local = scripted(calls(call("write_note")), says("Written."));
  const embed = embedBy({ "write a note and send it": { write_note: 1, send_note: 0.9 } });
  await turns({ embed, local: local.model }).hear("write a note and send it");
  assert.ok(local.asked[0].tools.includes("write_note"));
  assert.ok(!local.asked[0].tools.includes("send_note"));
  assert.ok(local.asked[1].tools.includes("send_note"));
});

// ── Follow-ups, names, and what Mochi says ────────────────────────────────────

test("a follow-up is shown what the turn before called, however it ranks alone", async () => {
  // "add" is plainly adding pills (tier 1); "and the other one too" is near everything but adding.
  const others = { now_playing: 0.5, pause_music: 0.5, play_music: 0.5, remove_pills: 0.01, show_view: 0.5, open_app: 0.5, quit_coucou: 0.5, undo: 0.5 };
  const embed = embedBy({ add: { add_pills: 1 }, "and the other one too": others });
  const local = scripted(calls(call("nothing")));
  const t = turns({ embed, local: local.model });
  await t.hear("add vercel");
  assert.deepEqual(app.state.log, ["add:vercel"]);
  await t.hear("and the other one too");
  assert.ok(local.asked[0].tools.includes("add_pills"));
  // Alone, it is not shown.
  const alone = scripted(calls(call("nothing")));
  await turns({ embed, local: alone.model }).hear("and the other one too");
  assert.ok(!alone.asked[0].tools.includes("add_pills"));
});

test("what takes a kind of thing the sentence names is shown, however near the rest of the sentence is to others", async () => {
  const others = { now_playing: 0.5, pause_music: 0.5, play_music: 0.5, add_pills: 0.5, remove_pills: 0.5, open_app: 0.5, quit_coucou: 0.5, undo: 0.5 };
  const embed = embedBy({ "bring up the": others });
  const local = scripted(calls(call("show_view", { view: "wardrobe" })));
  await turns({ embed, local: local.model }).hear("bring up the wardrobe");
  assert.equal(local.asked[0].tools[0], "show_view");
  assert.deepEqual(app.state.log, ["view:wardrobe"]);
});

test("what only read is said by a model given the results alone; what was done, in the capabilities' lines", async () => {
  const local = scripted(calls(call("now_playing")), says("done"), says("Song by Artist is playing."));
  const heard = await turns({ local: local.model }).hear("hey what is this song called");
  assert.deepEqual(heard.result, { outcome: "success", message: "Song by Artist is playing." });
  const report = local.asked[2];
  // Not the sentence, not the turns before, no tools: the results.
  assert.deepEqual(report.tools, []);
  assert.deepEqual(report.history, []);
  assert.equal(report.said, "What did the app read?");
  assert.doesNotMatch(report.system, /song called/);
  assert.match(report.system, /"title":"Song"/);
  // Words that name what nothing did are never said: the lines are.
  const claims = scripted(calls(call("pause_music")), says("Paused, and Stripe is gone too."));
  const claimed = await turns({ local: claims.model }).hear("pause and remove stripe");
  assert.deepEqual(claimed.result, { outcome: "success", message: "Paused" });
  assert.equal(claimed.worded, false);
  // Words that hold up are Mochi's.
  const fine = scripted(calls(call("pause_music")), says("The music is paused."));
  const kept = await turns({ local: fine.model }).hear("pause");
  assert.deepEqual(kept.result, { outcome: "success", message: "The music is paused." });
  assert.equal(kept.worded, true);
  // A report that does not come: the reads' own lines.
  const mute = scripted(calls(call("now_playing")), says("done"));
  assert.deepEqual((await turns({ local: mute.model }).hear("what is playing")).result, { outcome: "success", message: "Song — Artist" });
});

test("a thing of a listed kind said a letter or a sound away is perhaps named; a word that only sounds alike is not", async () => {
  app.registry.entities({ kind: "setting", description: "Settings.", list: () => [{ id: "screen", label: "Screen" }, { id: "settings", label: "Settings" }] });
  assert.deepEqual(await app.registry.named("remove strife"), [{ kind: "pill", id: "stripe", label: "Stripe", near: true, heard: "strife" }]);
  assert.deepEqual(await app.registry.named("ad get hub"), [{ kind: "pill", id: "github", label: "GitHub", near: true, heard: "get hub" }]);
  // Whole names are named, not perhaps named.
  assert.deepEqual(await app.registry.named("remove stripe"), [{ kind: "pill", id: "stripe", label: "Stripe" }]);
  // Sounds alike, starts otherwise; several words that only sound like a name.
  assert.deepEqual(await app.registry.named("that's better thanks"), []);
  assert.deepEqual(await app.registry.named("is the ci green"), []);
});

test("a capability's name written as text, alone or with its arguments, is a call", () => {
  const known = new Set(["nothing", "read_session_output"]);
  assert.deepEqual(written("nothing", known), [call("nothing")]);
  assert.deepEqual(written('read_session_output {"lines": 8, "session": "VS Code"}', known), [call("read_session_output", { lines: 8, session: "VS Code" })]);
  assert.deepEqual(written('read_session_output({"session": "Codex"})', known), [call("read_session_output", { session: "Codex" })]);
  // Not a capability's name, or words: no call.
  assert.deepEqual(written("Nothing.", known), []);
  assert.deepEqual(written("rm_rf", known), []);
  assert.deepEqual(written("nothing to do here", known), []);
});

test("a name the model wrote for a thing only nearly said is put back as heard, so the executor asks", async () => {
  const local = scripted(calls(call("remove_pills", { pills: ["Stripe"] })), says("done"));
  const t = turns({ local: local.model });
  const asked = [];
  t.onAsk = (ask) => {
    if (!ask) return;
    asked.push(ask.question);
    t.answer({ kind: "yes_no", yes: false });
  };
  await t.hear("remove strife");
  assert.deepEqual(asked, ["Did you mean Stripe?"]);
  assert.deepEqual(app.state.log, []);
  // Said whole, it is the name: no question.
  const whole = scripted(calls(call("remove_pills", { pills: ["Stripe"] })), says("done"));
  await turns({ local: whole.model }).hear("remove stripe");
  assert.deepEqual(app.state.log, ["remove:stripe"]);
  assert.deepEqual(asked.length, 1);
});

test("a thing nearly named that the model did nothing with is asked about by the app, never acted on", async () => {
  app.registry.declare({
    name: "launch", area: "apps", description: "Opens an installed app.", tier: "free",
    args: { app: { type: "entity", kind: "app", description: "The app." } },
    run: async (args) => (app.state.log.push(`launch:${args.app}`), done(`${args.app} opened`, true)),
  });
  app.registry.entities({
    kind: "app", description: "The installed apps.", list: () => [],
    near: async (said) => (/spy flight/.test(said) ? [{ id: "Spotify", label: "Spotify", score: 0.8 }] : []),
  });
  const asked = [];
  const words = scripted(says("I don't know what spy flight is."));
  const t = turns({ local: words.model });
  t.onAsk = (ask) => {
    if (!ask) return;
    asked.push(ask.question);
    t.answer({ kind: "yes_no", yes: true });
  };
  await t.hear("open spy flight");
  assert.deepEqual(asked, ["Did you mean Spotify?"]);
  assert.deepEqual(app.state.log, ["launch:Spotify"]);
  // Told not to: the model's nothing stands.
  const no = scripted(calls(call("nothing")));
  const other = turns({ local: no.model });
  other.onAsk = (ask) => ask && asked.push(ask.question);
  await other.hear("don't open spy flight");
  assert.equal(asked.length, 1);
});

test("a name the sentence does not hold and that is nothing of its kind is the thing the sentence names", async () => {
  const named = (text) => app.registry.named(text);
  const show = app.registry.get("show_view");
  const turn = { said: "bring up the wardrobe", named: [{ kind: "view", id: "wardrobe", label: "Wardrobe" }] };
  assert.deepEqual((await asHeard(call("show_view", { view: "Closet" }), show, turn, named)).arguments, { view: "wardrobe" });
  // Said as it is, a thing of that kind that exists, or nothing of that kind named: as written.
  assert.deepEqual((await asHeard(call("show_view", { view: "wardrobe" }), show, turn, named)).arguments, { view: "wardrobe" });
  assert.deepEqual((await asHeard(call("show_view", { view: "Chat" }), show, turn, named)).arguments, { view: "Chat" });
  assert.deepEqual((await asHeard(call("show_view", { view: "Chat" }), show, { said: "show it", named: [] }, named)).arguments, { view: "Chat" });
  // A correction names another thing of the kind than the one to put back: left to the model.
  const remove = app.registry.get("remove_pills");
  const correction = { said: "no i meant stripe", named: [{ kind: "pill", id: "stripe", label: "Stripe" }] };
  assert.deepEqual((await asHeard(call("remove_pills", { pills: ["vercel"] }), remove, correction, named)).arguments, { pills: ["vercel"] });
});

test("a no that names another thing of the kind asked about is what was meant instead, whatever the reader said of it", async () => {
  const embed = embedBy({ "remove strife": { remove_pills: 1 } });
  for (const [said, next] of [["no, github", "no, github"], ["no", undefined], ["no, the chat", undefined]]) {
    app = makeApp();
    const t = turns({ embed, local: scripted(calls(call("answer", { option: "no", also_asks: false }))).model });
    t.onAsk = (ask) => {
      if (ask) queueMicrotask(() => void t.answerSaid(said));
    };
    const heard = await t.hear("remove strife");
    assert.equal(heard.next, next, said);
    assert.deepEqual(app.state.log, []);
  }
});

test("after a no to a name, the same call written with the name itself is not asked again", async () => {
  const local = scripted(calls(call("remove_pills", { pills: ["strife"] })), calls(call("remove_pills", { pills: ["Stripe"] })), says("done"));
  const t = turns({ local: local.model });
  const asked = [];
  t.onAsk = (ask) => {
    if (!ask) return;
    asked.push(ask.question);
    queueMicrotask(() => t.answer({ kind: "yes_no", yes: false }));
  };
  const heard = await t.hear("remove strife");
  assert.deepEqual(asked, ["Did you mean Stripe?"]);
  assert.deepEqual(app.state.log, []);
  assert.deepEqual(heard.result, { outcome: "success", message: "Leaving it as is" });
});

test("words are checked against the results: what was seen, things, numbers", async () => {
  const named = (said) => app.registry.named(said);
  const ran = (name, args, result) => ({ call: call(name, args), result });
  const removed = [ran("remove_pills", { pills: ["stripe"] }, done("Stripe removed", true))];
  assert.equal(await grounded("Stripe is off the island.", removed, named), true);
  // A thing the results do not hold.
  assert.equal(await grounded("Stripe and Vercel are gone.", removed, named), false);
  // A number the results do not hold.
  const volume = [ran("set_music_volume", { percent: 30 }, done("Volume 30%", true))];
  assert.equal(await grounded("The volume is at 30 now.", volume, named), true);
  assert.equal(await grounded("The volume is at 40 now.", volume, named), false);
  // Only asked for, not seen.
  assert.equal(await grounded("Spotify is open.", [ran("open_app", { app: "Spotify" }, done("Asked Windows to open Spotify", false))], named), false);
});

test("why words do not hold up is said: unseen, a thing, a number", async () => {
  const named = (said) => app.registry.named(said);
  const ran = (name, args, result) => ({ call: call(name, args), result });
  const removed = [ran("remove_pills", { pills: ["stripe"] }, done("Stripe removed", true))];
  assert.equal(await unfounded("Stripe is gone.", removed, named), null);
  assert.equal(await unfounded("Stripe is gone.", [ran("remove_pills", {}, done("Asked", false))], named), "unseen");
  assert.equal(await unfounded("Stripe and Vercel are gone.", removed, named), "thing");
  assert.equal(await unfounded("Stripe is gone, 2 left.", removed, named), "number");
});

test("a thing nearly named, when all the model called failed, is asked about in place of those calls", async () => {
  app.registry.declare({
    name: "launch", area: "apps", description: "Opens an installed app.", tier: "free",
    args: { app: { type: "entity", kind: "app", description: "The app." } },
    run: async (args) => (app.state.log.push(`launch:${args.app}`), done(`${args.app} opened`, true)),
  });
  app.registry.entities({
    kind: "app", description: "The installed apps.", list: () => [],
    near: async (said) => (/spy flight/.test(said) ? [{ id: "Spotify", label: "Spotify", score: 0.8 }] : []),
  });
  const asked = [];
  const local = scripted(calls(call("open_app", { app: "Nope" })), says("done"));
  const t = turns({ local: local.model });
  t.onAsk = (ask) => {
    if (!ask) return;
    asked.push(ask.question);
    t.answer({ kind: "yes_no", yes: true });
  };
  const heard = await t.hear("open spy flight");
  assert.deepEqual(asked, ["Did you mean Spotify?"]);
  assert.deepEqual(app.state.log, ["open:Nope", "launch:Spotify"]);
  assert.deepEqual(heard.result, { outcome: "success", message: "Spotify opened" });
});

test("the model may ask the user when it is not sure, is always offered to, and goes on from the answer", async () => {
  const questions = [];
  app.registry.declare({
    name: "ask_user", area: "coucou", description: "Asks the user.", tier: "free",
    args: { question: { type: "string", description: "The question." }, option_1: { type: "string", optional: true, description: "An answer." }, option_2: { type: "string", optional: true, description: "Another." } },
    run: async (args, context) => {
      const answer = await context.ask({ kind: "choice", question: args.question, options: [{ id: "1", label: args.option_1 }, { id: "2", label: args.option_2 }] });
      questions.push(args.question);
      return done("", true, { answered: answer.kind === "choice" ? [args.option_1, args.option_2][Number(answer.id) - 1] : null });
    },
  });
  const local = scripted(
    calls(call("ask_user", { question: "Discord or Steam?", option_1: "Discord", option_2: "Steam" })),
    (asked) => (/"answered":"Discord"/.test(asked.steps[0].results[0]) ? calls(call("open_app", { app: "Discord" })) : says("?")),
    says("Opening Discord."),
  );
  const t = turns({ local: local.model });
  t.onAsk = (ask) => {
    if (ask) queueMicrotask(() => t.answer({ kind: "choice", id: "1" }));
  };
  await t.hear("open this cord");
  assert.ok(local.asked[0].tools.includes("ask_user"));
  assert.deepEqual(questions, ["Discord or Steam?"]);
  assert.deepEqual(app.state.log, ["open:Discord"]);
});
