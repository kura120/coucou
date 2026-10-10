// "OK Coucou", understanding and acting (src/voice): the sentence table of the
// parser, pill names said out loud, the grammar the recogniser is given, and
// the runner against fake music and pills.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PILL_CATALOG, availablePills } from "../src/core/pills.ts";
import { SPOKEN, levenshtein, normalise, resolvePill, spokenForms } from "../src/voice/entity.ts";
import { parseIntent, parseSeveral } from "../src/voice/intent.ts";
import { buildGrammar, sentences } from "../src/voice/grammar.ts";
import { VoiceRunner } from "../src/voice/runner.ts";

const PILLS = availablePills("windows");
const parse = (text) => parseIntent(text, PILLS);

// ── The sentence table (IntentParserTests, English) ───────────────────────────

const play = { kind: "musicPlay", target: null };
const add = (id) => ({ kind: "pillAdd", id });
const remove = (id) => ({ kind: "pillRemove", id });
const main = (id) => ({ kind: "pillSetMain", id });
const unknown = { kind: "unknown" };

const TABLE = [
  // Music
  ["play", play],
  ["Play.", play],
  ["play music", play],
  ["play some music", play],
  ["start music", play],
  ["resume", play],
  ["resume music", play],
  ["please play some music", play],
  ["can you play music", play],
  ["play spotify", { kind: "musicPlay", target: "spotify" }],
  ["play music on spotify", { kind: "musicPlay", target: "spotify" }],
  ["pause", { kind: "musicPause" }],
  ["pause music", { kind: "musicPause" }],
  ["stop", { kind: "musicPause" }],
  ["stop the music", { kind: "musicPause" }],
  ["could you pause", { kind: "musicPause" }],
  ["next", { kind: "musicNext" }],
  ["next track", { kind: "musicNext" }],
  ["next song", { kind: "musicNext" }],
  ["skip", { kind: "musicNext" }],
  ["skip this one", { kind: "musicNext" }],
  ["previous", { kind: "musicPrevious" }],
  ["previous track", { kind: "musicPrevious" }],
  ["previous song", { kind: "musicPrevious" }],
  ["go back", { kind: "musicPrevious" }],
  ["volume up", { kind: "musicVolumeUp" }],
  ["louder", { kind: "musicVolumeUp" }],
  ["turn up the volume", { kind: "musicVolumeUp" }],
  ["volume down", { kind: "musicVolumeDown" }],
  ["quieter", { kind: "musicVolumeDown" }],
  ["volume 50", { kind: "musicSetVolume", percent: 50 }],
  ["set volume to 30", { kind: "musicSetVolume", percent: 30 }],
  ["volume 150", unknown],
  ["shuffle", { kind: "musicShuffle", on: null }],
  ["shuffle on", { kind: "musicShuffle", on: true }],
  ["shuffle off", { kind: "musicShuffle", on: false }],
  ["turn shuffle off", { kind: "musicShuffle", on: false }],
  ["repeat", { kind: "musicRepeat", on: null }],
  ["repeat on", { kind: "musicRepeat", on: true }],
  ["repeat off", { kind: "musicRepeat", on: false }],
  ["play Get Lucky", { kind: "musicPlaySearch", name: "Get Lucky" }],
  ["play some Daft Punk", { kind: "musicPlaySearch", name: "Daft Punk" }],
  ["play playlist Focus", { kind: "musicPlayPlaylist", name: "Focus" }],
  ["start playlist Deep Work", { kind: "musicPlayPlaylist", name: "Deep Work" }],
  // Pills
  ["add github", add("integration_github")],
  ["add GitHub", add("integration_github")],
  ["add the github pill", add("integration_github")],
  ["show vercel", add("integration_vercel")],
  ["enable stripe", add("integration_stripe")],
  ["activate notion", add("integration_notion")],
  ["add gemini", add("agent_gemini")],
  ["add n eight n", add("integration_n8n")],
  ["add n8n", add("integration_n8n")],
  ["show l m studio", add("ai_lmstudio")],
  ["add open a i", add("ai_openai")],
  ["add cal dot com", add("integration_calcom")],
  ["play github", add("integration_github")],
  ["please add copilot", add("agent_copilot")],
  ["add vercel and stripe", { kind: "pillAddMultiple", ids: ["integration_vercel", "integration_stripe"] }],
  ["show github and notion", { kind: "pillAddMultiple", ids: ["integration_github", "integration_notion"] }],
  ["remove vercel", remove("integration_vercel")],
  ["hide github", remove("integration_github")],
  ["disable stripe", remove("integration_stripe")],
  ["delete the notion pill", remove("integration_notion")],
  ["remove stripe and notion", { kind: "pillRemoveMultiple", ids: ["integration_stripe", "integration_notion"] }],
  ["replace n eight n with github", { kind: "pillReplace", old: "integration_n8n", new: "integration_github" }],
  ["swap vercel for stripe", { kind: "pillReplace", old: "integration_vercel", new: "integration_stripe" }],
  ["keep only github", { kind: "pillOnly", ids: ["integration_github"] }],
  ["keep only github and vercel", { kind: "pillOnly", ids: ["integration_github", "integration_vercel"] }],
  ["keep only github and vercel and stripe", { kind: "pillOnly", ids: ["integration_github", "integration_vercel", "integration_stripe"] }],
  // The main pill
  ["switch to cursor", main("agent_cursor")],
  ["use codex", main("agent_codex")],
  ["set main to antigravity", main("agent_antigravity")],
  ["change to v s code", main("integration_claude")],
  ["switch to claude", main("integration_claude")],
  ["play cursor", main("agent_cursor")],
  ["switch to github", unknown], // not a workspace tool
  ["use the force", unknown],
  // Leaving
  ["never mind", { kind: "cancel" }],
  ["cancel", { kind: "cancel" }],
  ["forget it", { kind: "cancel" }],
  // Nothing
  ["", unknown],
  ["   ", unknown],
  ["please", unknown],
  ["what time is it", unknown],
  ["add", unknown],
  ["add something else", unknown],
  ["remove the thing", unknown],
  ["github", unknown],
  // Never: voice does not approve, and does not send.
  ["allow", unknown],
  ["approve it", unknown],
  ["yes allow that", unknown],
  ["send the email", unknown],
];

test("the table has the Mac's sixty sentences and more", () => {
  assert.ok(TABLE.length >= 60, `${TABLE.length} sentences`);
});

for (const [said, expected] of TABLE) {
  test(`"${said}" → ${expected.kind}`, () => assert.deepEqual(parse(said), expected));
}

test("the same sentence always gives the same intent, whatever its case or punctuation", () => {
  for (const [said, expected] of TABLE) {
    if (expected.kind === "musicPlaySearch" || expected.kind === "musicPlayPlaylist") continue;
    assert.deepEqual(parse(said.toUpperCase()), expected, said);
    assert.deepEqual(parse(`${said}.`), expected, said);
  }
});

test("several commands in one sentence are each understood, or it is one command", () => {
  assert.deepEqual(parseSeveral("pause and remove github", PILLS), [{ kind: "musicPause" }, remove("integration_github")]);
  assert.deepEqual(parseSeveral("add stripe then switch to cursor", PILLS), [add("integration_stripe"), main("agent_cursor")]);
  // "cursor" alone means nothing: this is one command, adding two pills.
  assert.equal(parseSeveral("add gemini and copilot", PILLS), null);
  assert.equal(parseSeveral("pause", PILLS), null);
});

// ── Pill names ────────────────────────────────────────────────────────────────

test("normalise: lowercase, no accents, no punctuation, single spaces", () => {
  assert.equal(normalise("  Cal.com,  PLEASE!  "), "calcom please");
  assert.equal(normalise("Écoute l'île"), "ecoute l ile");
  assert.equal(normalise("VS-Code"), "vs code");
});

test("a pill is found by its name, an alias, a word of its name, or a near miss", () => {
  assert.equal(resolvePill("GitHub", PILLS), "integration_github");
  assert.equal(resolvePill("claude", PILLS), "integration_claude");
  assert.equal(resolvePill("vs code", PILLS), "integration_claude");
  assert.equal(resolvePill("gemini cli", PILLS), "agent_gemini");
  assert.equal(resolvePill("studio", PILLS), "ai_lmstudio");
  assert.equal(resolvePill("githup", PILLS), "integration_github");
  assert.equal(resolvePill("vercell", PILLS), "integration_vercel");
  assert.equal(resolvePill("strip", PILLS), "integration_stripe");
});

test("nothing close enough, or two pills as close, is no pill", () => {
  assert.equal(resolvePill("", PILLS), null);
  assert.equal(resolvePill("banana", PILLS), null);
  // "cli" is a whole word of two names.
  assert.equal(resolvePill("cli", PILLS), null);
  assert.equal(resolvePill("github", []), null);
});

test("the main pill is only looked for among the workspace tools", () => {
  assert.equal(resolvePill("cursor", PILLS, "workspace"), "agent_cursor");
  assert.equal(resolvePill("github", PILLS, "workspace"), null);
});

test("a pill this build does not offer is never the answer", () => {
  // Apple Music is in the catalog and not on Windows or Linux.
  assert.equal(resolvePill("apple music", PILLS), null);
  assert.equal(resolvePill("music", PILLS), null);
});

test("levenshtein", () => {
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("github", "github"), 0);
});

test("every way of saying a pill is words a recogniser can say, and means that pill", () => {
  for (const [id, said] of Object.entries(SPOKEN)) {
    assert.ok(PILL_CATALOG.some((p) => p.id === id), `${id} is not a pill ID`);
    for (const s of said) {
      assert.match(s, /^[a-z0-9]+( [a-z0-9]+)*$/, `${id}: "${s}"`);
      const def = PILL_CATALOG.find((p) => p.id === id);
      assert.equal(resolvePill(s, [def]), id, `"${s}"`);
    }
  }
  for (const def of PILLS) assert.ok(spokenForms(def).length > 0, def.id);
});

test("no two pills are said the same way", () => {
  const seen = new Map();
  for (const def of PILL_CATALOG) {
    for (const s of spokenForms(def)) {
      assert.ok(!seen.has(s), `"${s}" is both ${seen.get(s)} and ${def.id}`);
      seen.set(s, def.id);
    }
  }
});

// ── The grammar ───────────────────────────────────────────────────────────────

const GRAMMAR = buildGrammar(PILLS);

test("the grammar is what Rust accepts: plain words, known slots, within its bounds", () => {
  assert.ok(GRAMMAR.commands.length > 30 && GRAMMAR.commands.length <= 200);
  assert.deepEqual(Object.keys(GRAMMAR.slots).sort(), ["pill", "workspace"]);
  for (const command of GRAMMAR.commands) {
    const parts = command.split(" ");
    assert.ok(parts.length <= 12, command);
    for (const part of parts) assert.match(part, /^([a-z0-9]+|\{(pill|workspace)\})$/, command);
  }
  for (const values of Object.values(GRAMMAR.slots)) {
    assert.ok(values.length > 0 && values.length <= 200);
    for (const v of values) assert.match(v, /^[a-z0-9]+( [a-z0-9]+){0,5}$/, v);
  }
  assert.equal(new Set(GRAMMAR.commands).size, GRAMMAR.commands.length);
});

test("every pill this build offers can be said, and only the workspace tools as the main pill", () => {
  for (const def of PILLS) assert.ok(spokenForms(def).every((s) => GRAMMAR.slots.pill.includes(s)), def.id);
  const workspace = PILLS.filter((p) => p.category === "workspace").flatMap(spokenForms);
  assert.deepEqual([...GRAMMAR.slots.workspace].sort(), [...workspace].sort());
});

test("everything the recogniser can hear, the parser understands", () => {
  let checked = 0;
  for (const command of GRAMMAR.commands) {
    for (const sentence of sentences(command, GRAMMAR.slots)) {
      // A pill's name alone is the answer to a question, not a command.
      if (command === "{pill}") {
        assert.ok(resolvePill(sentence, PILLS), sentence);
      } else {
        assert.notEqual(parse(sentence).kind, "unknown", sentence);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 300, `${checked} sentences`);
});

test("the recogniser is never given a way to approve or to send", () => {
  for (const command of GRAMMAR.commands) assert.doesNotMatch(command, /allow|approve|accept|yes|send|confirm/, command);
});

// ── The runner ────────────────────────────────────────────────────────────────

function fakes({ active = [], mainPill = "integration_claude", limit = 6, music = {} } = {}) {
  const calls = [];
  const state = { enabled: true, running: true, playing: false, shuffle: false, repeat: false, ...music };
  const pills = { active: [...active], main: mainPill };
  const takesSlot = (id) => id !== "integration_spotify";
  const runner = new VoiceRunner(
    {
      enabled: () => state.enabled,
      running: () => state.running,
      playing: () => state.playing,
      shuffle: () => state.shuffle,
      repeat: () => state.repeat,
      playPause: () => { calls.push("playPause"); state.playing = !state.playing; },
      next: () => calls.push("next"),
      previous: () => calls.push("previous"),
      setShuffle: (on) => { calls.push(`shuffle:${on}`); state.shuffle = on; },
      setRepeat: (on) => { calls.push(`repeat:${on}`); state.repeat = on; },
      open: () => calls.push("open"),
    },
    {
      active: () => [...pills.active],
      main: () => pills.main,
      hasRoomFor: (id) => !takesSlot(id) || pills.active.filter(takesSlot).length < limit,
      limit: () => limit,
      toggle: (id) => {
        pills.active = pills.active.includes(id) ? pills.active.filter((x) => x !== id) : [...pills.active, id];
      },
      setMain: (id) => {
        pills.main = id;
        pills.active = pills.active.filter((x) => x !== id);
      },
    },
    () => PILLS,
  );
  const say = (text) => runner.run(parse(text), text);
  return { runner, say, calls, pills, state };
}

const SIX = [
  "integration_github", "integration_vercel", "integration_stripe",
  "integration_notion", "integration_resend", "integration_n8n",
];

test("music: play, pause, next and previous reach Spotify once", () => {
  const f = fakes();
  assert.deepEqual(f.say("play"), { outcome: "success", message: "Playing" });
  assert.deepEqual(f.say("play"), { outcome: "success", message: "Playing" }); // already playing: no toggle
  assert.deepEqual(f.say("pause"), { outcome: "success", message: "Paused" });
  assert.deepEqual(f.say("pause"), { outcome: "success", message: "Paused" });
  assert.deepEqual(f.say("next track"), { outcome: "success", message: "Next track" });
  assert.deepEqual(f.say("previous"), { outcome: "success", message: "Previous track" });
  assert.deepEqual(f.calls, ["playPause", "playPause", "next", "previous"]);
});

test("music: shuffle and repeat are set, or turned the other way round", () => {
  const f = fakes();
  assert.equal(f.say("shuffle").message, "Shuffle on");
  assert.equal(f.say("shuffle").message, "Shuffle off");
  assert.equal(f.say("shuffle off").message, "Shuffle off");
  assert.equal(f.say("repeat on").message, "Repeat on");
  assert.deepEqual(f.calls, ["shuffle:true", "shuffle:false", "shuffle:false", "repeat:true"]);
});

test("music: without Spotify, play opens it and the rest says there is nothing to control", () => {
  const f = fakes({ music: { running: false } });
  assert.deepEqual(f.say("play"), { outcome: "success", message: "Open Spotify" });
  for (const said of ["pause", "next", "previous", "shuffle", "repeat off"]) {
    assert.deepEqual(f.say(said), { outcome: "failure", message: "No music app running" }, said);
  }
  assert.deepEqual(f.calls, ["open"]);
});

test("music: with Spotify switched off in Settings, nothing is played, opened or pretended", () => {
  for (const running of [true, false]) {
    const f = fakes({ music: { enabled: false, running } });
    for (const said of ["play", "play spotify", "pause", "next track", "previous", "shuffle", "repeat on", "volume up"]) {
      assert.deepEqual(f.say(said), { outcome: "failure", message: "Spotify is off in Settings" }, said);
    }
    assert.deepEqual(f.calls, []);
  }
  // Pills are not music: they still work.
  const f = fakes({ music: { enabled: false } });
  assert.equal(f.say("add github").outcome, "success");
});

test("music: what Spotify cannot be asked here says so, and does nothing", () => {
  const f = fakes();
  for (const said of ["play Get Lucky", "play playlist Focus", "volume up", "volume 50"]) {
    assert.deepEqual(f.say(said), { outcome: "failure", message: `Not recognised: « ${said} »` });
  }
  assert.deepEqual(f.calls, []);
});

test("pills: added, removed, already there, not there", () => {
  const f = fakes({ active: ["integration_vercel"] });
  assert.deepEqual(f.say("add github"), { outcome: "success", message: "GitHub added" });
  assert.deepEqual(f.say("add github"), { outcome: "success", message: "Already active" });
  assert.deepEqual(f.say("add v s code"), { outcome: "success", message: "Already active" }); // the main pill
  assert.deepEqual(f.say("remove vercel"), { outcome: "success", message: "Vercel removed" });
  assert.deepEqual(f.say("remove vercel"), { outcome: "failure", message: "Not active" });
  assert.deepEqual(f.pills.active, ["integration_github"]);
});

test("pills: several at once, skipping what is there or does not fit", () => {
  const f = fakes({ active: SIX.slice(0, 5) });
  assert.deepEqual(f.say("add github and gemini"), { outcome: "success", message: "Gemini CLI added" });
  assert.equal(f.pills.active.length, 6);
  assert.equal(f.say("add copilot and codex").outcome, "failure"); // full
  assert.deepEqual(f.say("remove github and gemini"), { outcome: "success", message: "GitHub, Gemini CLI removed" });
  assert.equal(f.say("remove github and gemini").outcome, "failure");
});

test("pills: the main pill changes and leaves the declared ones", () => {
  const f = fakes({ active: ["agent_cursor", "integration_github"] });
  assert.deepEqual(f.say("switch to cursor"), { outcome: "success", message: "Main: Cursor" });
  assert.equal(f.pills.main, "agent_cursor");
  assert.deepEqual(f.pills.active, ["integration_github"]);
});

test("pills: replace, and keep only", () => {
  const f = fakes({ active: ["integration_n8n", "integration_vercel", "integration_stripe"] });
  assert.deepEqual(f.say("replace n eight n with github"), { outcome: "success", message: "n8n → GitHub" });
  assert.deepEqual(f.pills.active, ["integration_vercel", "integration_stripe", "integration_github"]);
  assert.deepEqual(f.say("keep only github and notion"), { outcome: "success", message: "Only: GitHub, Notion" });
  assert.deepEqual(f.pills.active, ["integration_github", "integration_notion"]);
});

test("the six-pill limit: Mochi asks which one goes, and the answer swaps them", () => {
  const f = fakes({ active: SIX });
  assert.deepEqual(f.say("add gemini"), { outcome: "question", message: "6 active — remove which?" });
  assert.equal(f.runner.asking, true);
  assert.deepEqual(f.pills.active, SIX); // nothing changed yet
  assert.deepEqual(f.runner.answer("stripe"), { outcome: "success", message: "Stripe → Gemini CLI" });
  assert.equal(f.runner.asking, false);
  assert.ok(f.pills.active.includes("agent_gemini") && !f.pills.active.includes("integration_stripe"));
  assert.equal(f.pills.active.length, 6);
});

test("the limit's question: no answer, a wrong one, or a pill that is not there", () => {
  const f = fakes({ active: SIX });
  f.say("add gemini");
  assert.deepEqual(f.runner.answer(""), { outcome: "success", message: "OK, leaving it as is" });
  f.say("add gemini");
  assert.equal(f.runner.answer("banana").outcome, "failure");
  f.say("add gemini");
  assert.equal(f.runner.answer("copilot").outcome, "failure"); // not one of the six
  assert.deepEqual(f.pills.active, SIX);
  // An answer nobody asked for.
  assert.equal(f.runner.answer("stripe").outcome, "failure");
  // A question forgotten when the island moves on.
  f.say("add gemini");
  f.runner.reset();
  assert.equal(f.runner.asking, false);
});

test("Spotify takes no slot: it is added to a full island without a question", () => {
  const f = fakes({ active: SIX });
  assert.deepEqual(f.runner.run({ kind: "pillAdd", id: "integration_spotify" }), { outcome: "success", message: "Spotify added" });
  assert.equal(f.pills.active.length, 7);
});

test("what was not understood is said back, and nothing is done", () => {
  const f = fakes({ active: ["integration_github"] });
  assert.deepEqual(f.say("what time is it"), { outcome: "failure", message: "Not recognised: « what time is it »" });
  assert.deepEqual(f.runner.run({ kind: "unknown" }), { outcome: "failure", message: "Command not recognised" });
  assert.deepEqual(f.say("allow"), { outcome: "failure", message: "Not recognised: « allow »" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.pills.active, ["integration_github"]);
});
