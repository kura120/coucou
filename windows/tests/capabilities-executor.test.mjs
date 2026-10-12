// The executor (src/core/capabilities/registry.ts): one call from a model,
// guarded and done. Every branch, against capabilities made up here — nothing
// of the app runs, nothing is asked of a model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/core/capabilities/registry.ts";
import { done } from "../src/voice/result.ts";

const WORDS = {
  refused: () => "I can't do that.",
  unavailable: () => "Not right now.",
  failed: () => "That didn't work.",
  notFound: (said) => `I can't find ${said}.`,
  unchanged: () => "Nothing was changed.",
  nothingToUndo: () => "Nothing to put back.",
  one: (label) => `Did you mean ${label}?`,
  which: (labels) => `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}?`,
};

const PILLS = [
  { id: "integration_github", label: "GitHub", spoken: ["git hub"] },
  { id: "integration_stripe", label: "Stripe" },
  { id: "integration_vercel", label: "Vercel" },
  { id: "agent_claude", label: "Claude" },
  { id: "agent_claude_code", label: "Claude Code" },
];

/** Two sessions of the same agent: only their folders tell them apart. */
const SESSIONS = [
  { id: "session_1", label: "Codex", hint: "coucou" },
  { id: "session_2", label: "Codex", hint: "website" },
];

/** A registry over a small made-up app, and everything that happened to it. */
function setup({ click = true, answers = [], doubted } = {}) {
  const log = { ran: [], asked: [], confirmed: [], working: [] };
  const app = { volume: 40, shown: ["integration_github"], playing: true, music: true };
  const guard = {
    confirm: async (confirm) => {
      log.confirmed.push(confirm);
      return click;
    },
  };
  const registry = createRegistry({ guard, words: WORDS, doubted });
  const ran = (name, args) => log.ran.push({ name, args });

  registry.entities({ kind: "pill", description: "The pills of the island.", list: () => PILLS });
  registry.entities({ kind: "session", description: "The agents' sessions.", list: async () => SESSIONS });
  registry.entities({
    kind: "app",
    description: "The installed apps.",
    list: () => [],
    near: async (said) => (said.toLowerCase().includes("spot") ? [{ id: "Spotify", label: "Spotify", score: 0.82 }] : []),
  });
  registry.declare(
    {
      name: "now_playing", area: "music", description: "What is playing.", args: {}, tier: "read", inSnapshot: true,
      available: () => (app.music ? true : "No music app is running."),
      run: async () => done("Playing", true, { playing: app.playing }),
    },
    {
      name: "show_pill", area: "pills", description: "Brings a pill's view up.", tier: "free",
      args: { pill: { type: "entity", kind: "pill", description: "The pill to show." } },
      question: (label) => `Show ${label}?`,
      run: async (args) => (ran("show_pill", args), done("Shown")),
    },
    {
      name: "add_pills", area: "pills", description: "Adds pills to the island.", tier: "reversible",
      args: { pills: { type: "entities", kind: "pill", max: 3, description: "The pills to add." } },
      inverse: (args) => ({ name: "remove_pills", arguments: { pills: args.pills.filter((id) => !app.shown.includes(id)) } }),
      run: async (args) => (ran("add_pills", args), app.shown.push(...args.pills), done("Added")),
    },
    {
      name: "remove_pills", area: "pills", description: "Removes pills from the island.", tier: "reversible",
      args: { pills: { type: "entities", kind: "pill", description: "The pills to remove." } },
      inverse: (args) => ({ name: "add_pills", arguments: { pills: args.pills } }),
      run: async (args) => (ran("remove_pills", args), (app.shown = app.shown.filter((id) => !args.pills.includes(id))), done("Removed")),
    },
    {
      name: "set_volume", area: "music", description: "Sets the music's volume.", tier: "reversible",
      args: {
        percent: { type: "number", min: 0, max: 100, description: "0 to 100." },
        fade: { type: "boolean", optional: true, description: "Fade to it." },
        curve: { type: "string", optional: true, enum: ["linear", "smooth"], description: "How it fades." },
        note: { type: "string", optional: true, maxLength: 10, description: "A note." },
      },
      inverse: () => (app.volume === null ? null : { name: "set_volume", arguments: { percent: app.volume } }),
      run: async (args, context) => {
        ran("set_volume", args);
        context.working("Setting the volume…");
        app.volume = args.percent;
        return done("Volume set");
      },
    },
    {
      name: "tell_agent", area: "chat", description: "Sends a message to an agent.", tier: "confirm",
      args: { text: { type: "string", description: "The message." } },
      describe: (args) => ({ title: "Send this?", change: args.text, action: "Send" }),
      run: async (args) => (ran("tell_agent", args), done("Sent")),
    },
    {
      name: "set_setting", area: "settings", description: "Changes a setting.",
      args: { key: { type: "string", description: "The setting." }, value: { type: "string", description: "Its value." } },
      tier: (args) => (args.key === "language" ? "confirm" : "reversible"),
      describe: (args) => ({ title: `Change ${args.key}?`, change: String(args.value), action: "Change" }),
      run: async (args) => (ran("set_setting", args), done("Changed")),
    },
    {
      name: "open_app", area: "apps", description: "Opens an app.", tier: "free",
      args: { app: { type: "entity", kind: "app", description: "The app." } },
      run: async (args) => (ran("open_app", args), done("Opened", false)),
    },
    {
      name: "focus_session", area: "sessions", description: "Brings a session to the front.", tier: "free",
      args: { session: { type: "entity", kind: "session", description: "The session." } },
      run: async (args) => (ran("focus_session", args), done("Focused")),
    },
    { name: "breaks", area: "test", description: "Throws.", args: {}, tier: "free", run: async () => { throw new Error("the pipe is gone"); } },
    { name: "says_nothing", area: "test", description: "Returns nothing.", args: {}, tier: "free", run: async () => undefined },
    {
      name: "peeks", area: "test", description: "Looks at what it was given.", args: {}, tier: "free",
      run: async (_args, context) => done("Looked", true, { keys: Object.keys(context).sort() }),
    },
  );

  const context = (origin = "local") => ({
    origin,
    guard,
    ask: async (ask) => {
      log.asked.push(ask);
      return answers.shift() ?? { kind: "dropped" };
    },
    working: (line) => log.working.push(line),
  });
  const call = (name, args = {}, origin) => registry.execute({ name, arguments: args }, context(origin));
  return { registry, log, app, call, context };
}

// ── Looking up, and the arguments ─────────────────────────────────────────────

test("a name that is not declared does not exist: refused, nothing run", async () => {
  const { call, log } = setup();
  for (const name of ["approve_permission", "", undefined, "constructor", "__proto__"]) {
    const result = await call(name);
    assert.equal(result.status, "refused");
    assert.equal(result.line, "I can't do that.");
    assert.match(result.detail, /no capability named/);
  }
  assert.deepEqual(log.ran, []);
});

test("arguments are read as the declared type however a model wrote them", async () => {
  const { call, log } = setup();
  assert.equal((await call("set_volume", { percent: "55", fade: "on", curve: "Smooth" })).status, "done");
  assert.deepEqual(log.ran.at(-1).args, { percent: 55, fade: true, curve: "smooth" });
  await call("set_volume", { percent: " 12,5% ", fade: "false" });
  assert.deepEqual(log.ran.at(-1).args, { percent: 12.5, fade: false });
  await call("set_volume", { percent: 7, fade: 1, curve: null, note: "" });
  assert.deepEqual(log.ran.at(-1).args, { percent: 7, fade: true });
});

test("arguments nobody declared are left out, and the JSON text of them is read", async () => {
  const { registry, context, log } = setup();
  const result = await registry.execute({ name: "set_volume", arguments: '{"percent": 30, "reason": "it is loud", "guard": false}' }, context());
  assert.equal(result.status, "done");
  assert.deepEqual(log.ran.at(-1).args, { percent: 30 });
});

test("arguments that cannot be read are refused, with what is wrong", async () => {
  const { call, registry, context, log } = setup();
  const wrong = async (args, pattern) => {
    const result = await call("set_volume", args);
    assert.equal(result.status, "refused", JSON.stringify(args));
    assert.match(result.detail, pattern);
  };
  await wrong({}, /"percent" is required/);
  await wrong({ percent: "" }, /"percent" is required/);
  await wrong({ percent: "loud" }, /"percent" must be a number/);
  await wrong({ percent: 140 }, /at most 100/);
  await wrong({ percent: -1 }, /at least 0/);
  await wrong({ percent: 50, fade: "maybe" }, /"fade" must be true or false/);
  await wrong({ percent: 50, curve: "bouncy" }, /one of: linear, smooth/);
  await wrong({ percent: 50, note: "far too long a note" }, /at most 10 characters/);
  await wrong({ percent: { value: 5 } }, /must be a number/);
  for (const args of ["not json", "[1]", 5]) {
    assert.equal((await registry.execute({ name: "set_volume", arguments: args }, context())).status, "refused");
  }
  assert.equal((await call("show_pill", { pill: { id: "integration_github" } })).status, "refused");
  assert.equal((await call("add_pills", { pills: [] })).status, "refused");
  assert.equal((await call("add_pills", { pills: [{}] })).status, "refused");
  assert.deepEqual(log.ran, []);
});

// ── Which thing a name is ─────────────────────────────────────────────────────

test("an id or a name as it is written is that thing, and run is given the id", async () => {
  const { call, log } = setup();
  for (const pill of ["integration_stripe", "Stripe", "stripe", "  STRIPE ", "the stripe pill"]) {
    assert.equal((await call("show_pill", { pill })).status, "done", pill);
    assert.deepEqual(log.ran.at(-1).args, { pill: "integration_stripe" });
  }
  await call("show_pill", { pill: "git hub" });
  assert.equal(log.ran.at(-1).args.pill, "integration_github");
  // A name that is part of another is that one alone when said alone, and the longer one when that is said.
  await call("show_pill", { pill: "claude" });
  assert.equal(log.ran.at(-1).args.pill, "agent_claude");
  await call("show_pill", { pill: "open claude code" });
  assert.equal(log.ran.at(-1).args.pill, "agent_claude_code");
  assert.deepEqual(log.asked, []);
});

test("other letters for the same sounds is that thing, unless the speech model doubted the word", async () => {
  const sure = setup();
  assert.equal((await sure.call("show_pill", { pill: "versal" })).status, "done");
  assert.equal(sure.log.ran.at(-1).args.pill, "integration_vercel");
  assert.deepEqual(sure.log.asked, []);

  const doubtful = setup({ doubted: () => true, answers: [{ kind: "yes_no", yes: true }] });
  assert.equal((await doubtful.call("show_pill", { pill: "versal" })).status, "done");
  assert.equal(doubtful.log.asked.length, 1);
});

test("a name that is only near one thing is asked about, in the capability's words, and a yes goes on", async () => {
  const { call, log } = setup({ answers: [{ kind: "yes_no", yes: true }] });
  const result = await call("show_pill", { pill: "strife" });
  assert.deepEqual(log.asked, [{ kind: "yes_no", question: "Show Stripe?" }]);
  assert.equal(result.status, "done");
  assert.deepEqual(log.ran, [{ name: "show_pill", args: { pill: "integration_stripe" } }]);
});

test("a no, or no answer, to that question changes nothing and says so", async () => {
  for (const answer of [{ kind: "yes_no", yes: false }, { kind: "dropped" }, { kind: "text", value: "yes" }, { kind: "choice", id: "integration_stripe" }]) {
    const { call, log } = setup({ answers: [answer] });
    const result = await call("show_pill", { pill: "strife" });
    assert.equal(result.status, "done");
    assert.equal(result.verified, false);
    assert.equal(result.line, "Nothing was changed.");
    assert.match(result.detail, /Nothing was done/);
    assert.deepEqual(log.ran, []);
  }
});

test("without a question of its own, the registry's general one is asked", async () => {
  const { call, log } = setup({ answers: [{ kind: "yes_no", yes: true }] });
  await call("add_pills", { pills: ["strife"] });
  assert.equal(log.asked[0].question, "Did you mean Stripe?");
  assert.deepEqual(log.ran.at(-1).args, { pills: ["integration_stripe"] });
});

test("two as near as each other are a choice, and the one picked is used", async () => {
  const { call, log } = setup({ answers: [{ kind: "choice", id: "session_2" }] });
  const result = await call("focus_session", { session: "codex" });
  assert.equal(log.asked.length, 1);
  assert.equal(log.asked[0].kind, "choice");
  assert.equal(log.asked[0].question, "Codex or Codex?");
  assert.deepEqual(log.asked[0].options, [
    { id: "session_1", label: "Codex", hint: "coucou" },
    { id: "session_2", label: "Codex", hint: "website" },
  ]);
  assert.equal(result.status, "done");
  assert.equal(log.ran.at(-1).args.session, "session_2");

  // An id that was not offered is no answer.
  const other = setup({ answers: [{ kind: "choice", id: "integration_github" }] });
  assert.equal((await other.call("focus_session", { session: "codex" })).line, "Nothing was changed.");
  assert.deepEqual(other.log.ran, []);
});

test("nothing by that name is not_found, with what it might have been", async () => {
  const { call, log } = setup();
  const result = await call("show_pill", { pill: "spreadsheet" });
  assert.equal(result.status, "not_found");
  assert.equal(result.line, "I can't find spreadsheet.");
  assert.match(result.detail, /No pill is named "spreadsheet"/);
  const far = await call("show_pill", { pill: "zzzzqqqq" });
  assert.equal(far.status, "not_found");
  assert.equal(far.near, undefined);
  const close = await call("show_pill", { pill: "parcels" });
  assert.equal(close.status, "not_found");
  assert.deepEqual(close.near, ["Vercel"]);
  assert.deepEqual(log.ran, []);
  assert.deepEqual(log.asked, []);
});

test("a kind too large to list is ranked by its source, and judged the same way", async () => {
  const sure = setup();
  assert.equal((await sure.call("open_app", { app: "open spotify" })).status, "done");
  assert.deepEqual(sure.log.ran.at(-1).args, { app: "Spotify" });

  const unsure = setup({ answers: [{ kind: "yes_no", yes: true }] });
  assert.equal((await unsure.call("open_app", { app: "spot a fly" })).status, "done");
  assert.equal(unsure.log.asked[0].question, "Did you mean Spotify?");

  assert.equal((await setup().call("open_app", { app: "notepad" })).status, "not_found");
});

test("several things: one name, a list, or several said in one string; each once", async () => {
  const { call, log } = setup();
  await call("add_pills", { pills: "stripe" });
  assert.deepEqual(log.ran.at(-1).args, { pills: ["integration_stripe"] });
  await call("add_pills", { pills: ["Vercel", "integration_vercel", "claude code"] });
  assert.deepEqual(log.ran.at(-1).args, { pills: ["integration_vercel", "agent_claude_code"] });
  await call("add_pills", { pills: "github and stripe" });
  assert.deepEqual(log.ran.at(-1).args, { pills: ["integration_github", "integration_stripe"] });
  const many = await call("add_pills", { pills: ["github", "stripe", "vercel", "claude"] });
  assert.equal(many.status, "refused");
  assert.match(many.detail, /at most 3/);
  assert.equal((await call("add_pills", { pills: ["github", "spreadsheet"] })).status, "not_found");
  assert.equal(log.ran.length, 3);
});

test("a kind nobody lists is a failure of the app, said as one", async () => {
  const { registry, call } = setup();
  registry.declare({
    name: "open_folder", area: "apps", description: "Opens a folder.", tier: "free",
    args: { folder: { type: "entity", kind: "folder", description: "The folder." } },
    run: async () => done("Opened"),
  });
  const result = await call("open_folder", { folder: "Downloads" });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /kind "folder"/);
});

// ── Available, tiers, the click ───────────────────────────────────────────────

test("a capability that cannot be used now says why, and is not run", async () => {
  const { call, app } = setup();
  app.music = false;
  const result = await call("now_playing");
  assert.equal(result.status, "failed");
  assert.equal(result.line, "Not right now.");
  assert.equal(result.detail, "No music app is running.");
});

test("the instant tier runs what reads, shows and can be put back — never what takes a click", async () => {
  const { call, log } = setup();
  assert.equal((await call("now_playing", {}, "instant")).status, "done");
  assert.equal((await call("show_pill", { pill: "stripe" }, "instant")).status, "done");
  assert.equal((await call("set_volume", { percent: 10 }, "instant")).status, "done");
  for (const [name, args] of [["tell_agent", { text: "ship it" }], ["set_setting", { key: "language", value: "hi" }]]) {
    const result = await call(name, args, "instant");
    assert.equal(result.status, "refused");
    assert.match(result.detail, /never run without a model/);
  }
  assert.deepEqual(log.confirmed, []);
  assert.deepEqual(log.ran.map((r) => r.name), ["show_pill", "set_volume"]);
});

test("confirm: the exact change is shown, and a click does it", async () => {
  for (const origin of ["local", "cloud"]) {
    const { call, log } = setup({ click: true });
    const result = await call("tell_agent", { text: "ship it" }, origin);
    assert.deepEqual(log.confirmed, [{ title: "Send this?", change: "ship it", action: "Send" }]);
    assert.equal(result.status, "done");
    assert.equal(result.line, "Sent");
    assert.deepEqual(log.ran, [{ name: "tell_agent", args: { text: "ship it" } }]);
  }
});

test("confirm: no click is done-and-unchanged, and nothing ran", async () => {
  const { call, log } = setup({ click: false });
  const result = await call("tell_agent", { text: "ship it" });
  assert.equal(log.confirmed.length, 1);
  assert.deepEqual({ status: result.status, verified: result.verified, line: result.line }, { status: "done", verified: false, line: "Nothing was changed." });
  assert.match(result.detail, /did not click/);
  assert.deepEqual(log.ran, []);
});

test("a tier that depends on the arguments is worked out from them", async () => {
  const { call, log } = setup({ click: false });
  assert.equal((await call("set_setting", { key: "sound", value: "off" })).line, "Changed");
  assert.deepEqual(log.confirmed, []);
  assert.equal((await call("set_setting", { key: "language", value: "hi" })).line, "Nothing was changed.");
  assert.equal(log.confirmed.length, 1);
});

test("the app's own interface is the click already", async () => {
  const { call, log } = setup({ click: false });
  assert.equal((await call("tell_agent", { text: "ship it" }, "ui")).line, "Sent");
  assert.deepEqual(log.confirmed, []);
});

test("the guard is not in what a capability is given, whatever the caller's context carries", async () => {
  const { call } = setup();
  const result = await call("peeks");
  assert.deepEqual(result.data.keys, ["ask", "origin", "working"]);
});

// ── What breaks ───────────────────────────────────────────────────────────────

test("a capability that throws, or says nothing, is a failed result and never an exception", async () => {
  const { call, registry, context } = setup();
  const thrown = await call("breaks");
  assert.deepEqual({ status: thrown.status, line: thrown.line, detail: thrown.detail }, { status: "failed", line: "That didn't work.", detail: "the pipe is gone" });
  assert.equal((await call("says_nothing")).status, "failed");

  const broken = (name, part) => ({
    name, area: "test", description: "Breaks.", args: { pill: { type: "entity", kind: "pill", optional: true, description: "A pill." } }, tier: "confirm",
    describe: () => ({ title: "t", change: "c", action: "a" }),
    run: async () => done("Ran"),
    ...part,
  });
  const boom = () => { throw new Error("boom"); };
  registry.declare(
    broken("breaks_available", { available: boom }),
    broken("breaks_describe", { describe: boom }),
    broken("breaks_tier", { tier: boom }),
    broken("breaks_inverse", { tier: "reversible", inverse: boom }),
  );
  for (const name of ["breaks_available", "breaks_describe", "breaks_tier", "breaks_inverse"]) {
    const result = await call(name);
    assert.equal(result.status, "failed", name);
    assert.equal(result.detail, "boom");
  }
  // The question that cannot be put on screen, and the toast that cannot be shown.
  const mute = { ...context(), ask: async () => { throw new Error("no island"); } };
  assert.equal((await registry.execute({ name: "show_pill", arguments: { pill: "strife" } }, mute)).detail, "no island");
  const noToast = createRegistry({ guard: { confirm: async () => { throw new Error("no toast"); } }, words: WORDS });
  noToast.declare(broken("send", {}));
  assert.equal((await noToast.execute({ name: "send", arguments: {} }, context())).detail, "no toast");
});

// ── Putting things back ───────────────────────────────────────────────────────

test("undo runs what puts the last reversible thing back, once", async () => {
  const { registry, call, context, app, log } = setup();
  assert.equal((await registry.undo(context())).status, "failed");
  await call("set_volume", { percent: 80 });
  assert.equal(app.volume, 80);
  const back = await registry.undo(context());
  assert.equal(back.status, "done");
  assert.equal(app.volume, 40);
  const again = await registry.undo(context());
  assert.deepEqual({ status: again.status, line: again.line }, { status: "failed", line: "Nothing to put back." });
  assert.equal(log.ran.length, 2);
});

test("the inverse is worked out before the change, with the things' ids", async () => {
  const { registry, call, context, app } = setup();
  // GitHub is already shown: only Stripe is to be taken away again.
  await call("add_pills", { pills: ["git hub", "strype"] });
  assert.deepEqual(app.shown, ["integration_github", "integration_github", "integration_stripe"]);
  await registry.undo(context());
  assert.deepEqual(app.shown, ["integration_github", "integration_github"]);
});

test("only what was done and can be put back is remembered", async () => {
  const { registry, call, context, app, log } = setup({ click: true });
  await call("set_volume", { percent: 80 });
  // Reads, free things, confirmed things and refusals leave the memory alone.
  await call("now_playing");
  await call("show_pill", { pill: "stripe" });
  await call("tell_agent", { text: "hello" });
  await call("set_volume", { percent: 400 });
  // Nothing to put back (the inverse is null): the earlier change stays the last one.
  app.volume = null;
  await call("set_volume", { percent: 5 });
  await registry.undo(context());
  assert.deepEqual(log.ran.at(-1), { name: "set_volume", args: { percent: 40 } });
});

test("a reversible change that cannot say how to go back forgets the older one", async () => {
  const { registry, call, context, log } = setup();
  await call("set_volume", { percent: 80 });
  // set_setting is reversible for this key and declares no inverse.
  await call("set_setting", { key: "sound", value: "off" });
  assert.equal((await registry.undo(context())).status, "failed");
  assert.equal(log.ran.length, 2);
});

test("putting back goes through the same guard", async () => {
  const { registry, context, app } = setup();
  registry.declare({
    name: "odd", area: "test", description: "Its inverse is not declared.", args: {}, tier: "reversible",
    inverse: () => ({ name: "install_hooks", arguments: {} }),
    run: async () => done("Done"),
  }, {
    name: "bad", area: "test", description: "Its inverse has a wrong argument.", args: {}, tier: "reversible",
    inverse: () => ({ name: "set_volume", arguments: { percent: 900 } }),
    run: async () => done("Done"),
  });
  await registry.execute({ name: "odd", arguments: {} }, context());
  assert.equal((await registry.undo(context())).status, "refused");
  await registry.execute({ name: "bad", arguments: {} }, context());
  assert.equal((await registry.undo(context())).status, "refused");
  assert.equal(app.volume, 40);
});
