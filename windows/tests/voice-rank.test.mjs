// Ranking the app's capabilities against a sentence (src/voice/rank.ts,
// doc/voice-brain.md section 3.2): the index and what it keeps, the order,
// a model that does not answer, and each branch of `instant`, `directed` and
// `shortlist`. The embedding model here is a fake: every word is a direction,
// a text is the sum of its words'. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_SHOWN, CONTEXT_SHARE, CapabilityIndex, DIRECTED_ACT, DIRECTED_ASK, FOLLOWS_TURN_EASE, HEARD_UNSURE,
  INSTANT_MARGIN, INSTANT_SCORE, SHORTLIST, directed, instant, shortlist,
} from "../src/voice/rank.ts";

// ── The fake embedding model ──────────────────────────────────────────────────

const WIDTH = 512;

function slot(word) {
  let hash = 0x811c9dc5;
  for (const ch of word) hash = Math.imul(hash ^ ch.codePointAt(0), 0x01000193);
  return (hash >>> 0) % WIDTH;
}

/** A bag of words: texts that share words are near. `scale` shows that length does not count. */
function bag(text, width = WIDTH, scale = 3) {
  const vector = new Array(width).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) vector[slot(word) % width] += scale;
  return vector;
}

/** An `embed` that counts its calls and can be made to fail. */
function fake() {
  const model = {
    calls: [],
    answer: (texts) => texts.map((text) => bag(text)),
    embed: async (texts) => {
      model.calls.push([...texts]);
      return model.answer(texts);
    },
  };
  return model;
}

const CAPS = [
  { name: "pause_music", text: "music: pause the music that is playing" },
  { name: "next_track", text: "music: skip to the next track" },
  { name: "add_pill", text: "pills: add a pill to the island" },
  { name: "start_timer", text: "timer: start a countdown timer" },
];

const names = (ranked) => ranked.map((r) => r.name);

// ── The index ─────────────────────────────────────────────────────────────────

test("the capabilities are embedded once, in one call", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  assert.equal(await index.sync(CAPS), true);
  assert.deepEqual(model.calls, [CAPS.map((c) => c.text)]);
  assert.equal(await index.sync(CAPS), true);
  assert.equal(model.calls.length, 1, "nothing changed: nothing is embedded again");
});

test("only what changed or is new is embedded again", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  const changed = [...CAPS.slice(0, 3), { name: "start_timer", text: "timer: count down some minutes" }, { name: "show_view", text: "views: bring a view of the island up" }];
  assert.equal(await index.sync(changed), true);
  assert.deepEqual(model.calls[1], ["timer: count down some minutes", "views: bring a view of the island up"]);
  const ranked = await index.rank("count down ten minutes");
  assert.equal(ranked[0].name, "start_timer", "the new description is the one ranked");
});

test("a capability that is no longer declared is no longer ranked", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  await index.sync(CAPS.slice(0, 2));
  assert.equal(model.calls.length, 1);
  assert.deepEqual(names(await index.rank("add a pill")).sort(), ["next_track", "pause_music"]);
});

test("ranked by cosine, best first, every capability with its score", async () => {
  const index = new CapabilityIndex(fake().embed);
  await index.sync(CAPS);
  const ranked = await index.rank("pause the music");
  assert.equal(ranked.length, CAPS.length);
  assert.equal(ranked[0].name, "pause_music");
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  // The description has "music" twice and five other words (length √9); the
  // sentence shares "pause", "the" and "music" with it: (1 + 1 + 2) / (√3 × √9).
  assert.ok(Math.abs(ranked[0].score - 4 / (Math.sqrt(3) * Math.sqrt(9))) < 1e-9, `${ranked[0].score}`);
  assert.equal(ranked.at(-1).score, 0, "nothing shared: at right angles");
  assert.equal((await index.rank("skip this track"))[0].name, "next_track");
});

test("vectors are normalised: their length does not count", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  const before = await index.rank("pause the music");
  model.answer = (texts) => texts.map((text) => bag(text, WIDTH, 40));
  const after = await index.rank("pause the music");
  assert.deepEqual(names(after), names(before));
  assert.ok(Math.abs(after[0].score - before[0].score) < 1e-9);
});

test("equal scores keep the order the capabilities were given in", async () => {
  const index = new CapabilityIndex(fake().embed);
  await index.sync([{ name: "b", text: "one two" }, { name: "a", text: "one two" }, { name: "c", text: "three" }]);
  assert.deepEqual(names(await index.rank("one two")), ["b", "a", "c"]);
});

test("one embed call per sentence, with or without a previous turn", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  await index.rank("pause the music");
  await index.rank("and the next", "add a pill to the island");
  assert.deepEqual(model.calls.slice(1), [["pause the music"], ["and the next", "add a pill to the island\nand the next"]]);
});

test("a follow-up ranks like its turn", async () => {
  const index = new CapabilityIndex(fake().embed);
  await index.sync(CAPS);
  const alone = await index.rank("and vercel too");
  assert.equal(alone[0].score, 0, "alone it says nothing of any capability");
  const ranked = await index.rank("and vercel too", "add the github pill");
  assert.equal(ranked[0].name, "add_pill");
  assert.ok(ranked[0].score > ranked[1].score);
});

test("the previous turn counts for a share of what it adds, and never against", async () => {
  const index = new CapabilityIndex(fake().embed);
  await index.sync(CAPS);
  const score = (ranked, name) => ranked.find((r) => r.name === name).score;
  const alone = score(await index.rank("pause"), "add_pill");
  const joined = score(await index.rank("add the github pill\npause"), "add_pill");
  const both = score(await index.rank("pause", "add the github pill"), "add_pill");
  assert.ok(Math.abs(both - (alone + CONTEXT_SHARE * (joined - alone))) < 1e-9);
  // "pause" alone is nearer pausing than it is with a turn about pills before it.
  const direct = score(await index.rank("pause"), "pause_music");
  assert.equal(score(await index.rank("pause", "add the github pill"), "pause_music"), direct);
});

// ── No embedding model, or one that fails ─────────────────────────────────────

test("no embedding model: sync is false and rank is null", async () => {
  const model = fake();
  model.answer = () => null;
  const index = new CapabilityIndex(model.embed);
  assert.equal(await index.sync(CAPS), false);
  assert.equal(await index.rank("pause the music"), null);
  assert.equal(model.calls.length, 1, "nothing to rank against: the sentence is not embedded");
});

test("before any sync, and with nothing declared, rank is null", async () => {
  const index = new CapabilityIndex(fake().embed);
  assert.equal(await index.rank("pause the music"), null);
  assert.equal(await index.sync([]), true);
  assert.equal(await index.rank("pause the music"), null);
});

test("an embed that throws is one that did not answer", async () => {
  const index = new CapabilityIndex(async () => { throw new Error("connection refused"); });
  assert.equal(await index.sync(CAPS), false);
  assert.equal(await index.rank("pause the music"), null);
});

test("the model stops answering after the sync: that sentence has no ranking, the next has", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  const good = model.answer;
  model.answer = () => null;
  assert.equal(await index.rank("pause the music"), null);
  model.answer = good;
  assert.equal((await index.rank("pause the music"))[0].name, "pause_music");
});

test("a failed sync keeps what was right and the next embeds only the rest", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  const good = model.answer;
  model.answer = () => null;
  const more = [...CAPS, { name: "show_view", text: "views: bring a view of the island up" }];
  assert.equal(await index.sync(more), false);
  assert.equal(await index.rank("pause the music"), null, "an index with a hole in it is not ranked against");
  model.answer = good;
  assert.equal(await index.sync(more), true);
  assert.deepEqual(model.calls.at(-1), ["views: bring a view of the island up"]);
  assert.equal((await index.rank("bring the view up"))[0].name, "show_view");
});

test("answers that are not what was asked for count as none", async () => {
  const bad = [
    (texts) => texts.slice(1).map((t) => bag(t)), // one short
    (texts) => texts.map(() => []), // empty vectors
    (texts) => texts.map(() => new Array(WIDTH).fill(0)), // no direction
    (texts) => texts.map((t, i) => bag(t, i === 0 ? WIDTH : WIDTH / 2)), // two widths
    (texts) => texts.map((t) => bag(t).map((x, i) => (i === 0 ? NaN : x))),
    () => "vectors",
  ];
  for (const answer of bad) {
    const model = fake();
    model.answer = answer;
    const index = new CapabilityIndex(model.embed);
    assert.equal(await index.sync(CAPS), false);
    assert.equal(await index.rank("pause the music"), null);
  }
});

test("another embedding model: everything is embedded again", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  await index.sync(CAPS);
  model.answer = (texts) => texts.map((text) => bag(text, WIDTH / 2));
  // Seen at a sync that has something new…
  assert.equal(await index.sync([...CAPS, { name: "show_view", text: "views: bring a view of the island up" }]), true);
  assert.equal(model.calls.at(-1).length, CAPS.length + 1);
  assert.equal((await index.rank("pause the music"))[0].name, "pause_music");
  // …or at a sentence: no ranking for it, and the next sync starts over.
  model.answer = (texts) => texts.map((text) => bag(text, WIDTH));
  assert.equal(await index.rank("pause the music"), null);
  assert.equal(await index.sync(CAPS), true);
  assert.deepEqual(model.calls.at(-1), CAPS.map((c) => c.text));
  assert.equal((await index.rank("pause the music"))[0].name, "pause_music");
});

test("two syncs at once embed each text once", async () => {
  const model = fake();
  const index = new CapabilityIndex(model.embed);
  assert.deepEqual(await Promise.all([index.sync(CAPS), index.sync(CAPS)]), [true, true]);
  assert.equal(model.calls.length, 1);
});

// ── instant ───────────────────────────────────────────────────────────────────

const run = async () => ({ status: "done" });
const cap = (name, tier, args = {}) => ({ name, area: "test", description: name, args, tier, run });
const entity = { type: "entity", kind: "pill", description: "the pill" };
const entities = { type: "entities", kind: "pill", description: "the pills" };
const text = { type: "string", description: "what to write" };

const DECLARED = [
  cap("pause_music", "reversible"),
  cap("now_playing", "read"),
  cap("show_view", "free", { view: { type: "entity", kind: "view", description: "the view" } }),
  cap("add_pill", "reversible", { pills: entities }),
  cap("remove_pill", "reversible", { pill: entity, quietly: { type: "boolean", description: "no toast", optional: true } }),
  cap("send_chat", "confirm"),
  cap("prefill_chat", "free", { text }),
  cap("start_timer", "reversible", { minutes: { type: "number", description: "how long" } }),
  cap("set_setting", (args) => (args.setting === "language" ? "confirm" : "reversible"), { setting: { type: "entity", kind: "setting", description: "which" }, value: text }),
  cap("toggle_mochi", () => "reversible"),
  cap("quit", () => "confirm"),
  cap("needs_args", (args) => args.pill.tier),
  cap("by_entity", () => "reversible", { pill: entity }),
  cap("more_tools", "free"),
  cap("nothing", "free"),
  cap("escalate", "free"),
];

/** A ranking whose best is far ahead and near enough: only the capability's own rules are left to decide. */
const clear = (name) => [{ name, score: INSTANT_SCORE + INSTANT_MARGIN + 0.1 }, { name: "now_playing", score: INSTANT_SCORE - 0.1 }];

test("instant: a clear best that asks for nothing runs with no model", () => {
  assert.equal(instant(clear("pause_music"), DECLARED), "pause_music");
  assert.equal(instant([{ name: "now_playing", score: 0.9 }, { name: "pause_music", score: 0.2 }], DECLARED), "now_playing");
  assert.equal(instant(clear("nothing"), DECLARED), "nothing");
});

test("instant: arguments the executor finds itself do not stand in the way", () => {
  assert.equal(instant(clear("show_view"), DECLARED), "show_view");
  assert.equal(instant(clear("add_pill"), DECLARED), "add_pill");
  assert.equal(instant(clear("remove_pill"), DECLARED), "remove_pill", "an optional argument is left out");
});

test("instant: an argument a model would have to write is not instant", () => {
  assert.equal(instant(clear("prefill_chat"), DECLARED), null);
  assert.equal(instant(clear("start_timer"), DECLARED), null);
  assert.equal(instant(clear("set_setting"), DECLARED), null);
});

test("instant: never what takes a click", () => {
  assert.equal(instant(clear("send_chat"), DECLARED), null);
  assert.equal(instant(clear("quit"), DECLARED), null);
});

test("instant: a tier that depends on the arguments counts only when there are none to give", () => {
  assert.equal(instant(clear("toggle_mochi"), DECLARED), "toggle_mochi");
  assert.equal(instant(clear("by_entity"), DECLARED), null, "its tier may be confirm for the thing named");
  assert.equal(instant(clear("needs_args"), DECLARED), null, "it threw without its arguments");
});

test("instant: not far enough ahead of the second", () => {
  const second = INSTANT_SCORE + 0.1;
  assert.equal(instant([{ name: "pause_music", score: second + INSTANT_MARGIN - 0.01 }, { name: "nothing", score: second }], DECLARED), null);
  assert.equal(instant([{ name: "pause_music", score: second + INSTANT_MARGIN + 0.01 }, { name: "nothing", score: second }], DECLARED), "pause_music");
});

test("instant: far ahead of the rest, and still near nothing", () => {
  assert.equal(instant([{ name: "pause_music", score: INSTANT_SCORE - 0.01 }, { name: "now_playing", score: -0.5 }], DECLARED), null);
});

test("instant: alone in the ranking, it is ahead by its own score", () => {
  assert.equal(instant([{ name: "pause_music", score: Math.max(INSTANT_SCORE, INSTANT_MARGIN) + 0.01 }], DECLARED), "pause_music");
});

test("instant: no ranking, a name that is not declared, a score that is no number", () => {
  assert.equal(instant([], DECLARED), null);
  assert.equal(instant(clear("approve_permission"), DECLARED), null);
  assert.equal(instant([{ name: "pause_music", score: NaN }], DECLARED), null);
  assert.equal(instant([{ name: "pause_music", score: 0.9 }, { name: "now_playing", score: NaN }], DECLARED), null);
});

test("instant: the two that speak to a model are not run without one", () => {
  assert.equal(instant(clear("more_tools"), DECLARED), null);
  assert.equal(instant(clear("escalate"), DECLARED), null);
});

test("instant: a tier nobody declared is not trusted", () => {
  assert.equal(instant(clear("odd"), [cap("odd", "whatever")]), null);
  assert.equal(instant(clear("odd"), [cap("odd", () => undefined)]), null);
});

// ── directed ──────────────────────────────────────────────────────────────────

const best = (score, name = "pause_music") => [{ name, score }, { name: "now_playing", score: score - 0.2 }];

test("directed: three bands from the best score", () => {
  const heard = { followsTurn: false };
  assert.equal(directed(best(DIRECTED_ASK - 0.01), heard), "ignore");
  assert.equal(directed(best(DIRECTED_ASK + 0.01), heard), "ask");
  assert.equal(directed(best(DIRECTED_ACT - 0.01), heard), "ask");
  assert.equal(directed(best(DIRECTED_ACT + 0.01), heard), "act");
});

test("directed: no ranking is nothing to judge by", () => {
  assert.equal(directed(null, { followsTurn: true }), "ignore");
  assert.equal(directed([], { followsTurn: true }), "ignore");
  assert.equal(directed([{ name: "pause_music", score: NaN }], { followsTurn: true }), "ignore");
});

test("directed: just after a turn both bands sit lower", () => {
  const half = FOLLOWS_TURN_EASE / 2;
  assert.equal(directed(best(DIRECTED_ASK - half), { followsTurn: false }), "ignore");
  assert.equal(directed(best(DIRECTED_ASK - half), { followsTurn: true }), "ask");
  assert.equal(directed(best(DIRECTED_ACT - half), { followsTurn: false }), "ask");
  assert.equal(directed(best(DIRECTED_ACT - half), { followsTurn: true }), "act");
  assert.equal(directed(best(DIRECTED_ASK - FOLLOWS_TURN_EASE - 0.01), { followsTurn: true }), "ignore");
});

test("directed: words the speech model was not sure of drop it one band", () => {
  const low = [HEARD_UNSURE - 0.2, HEARD_UNSURE - 0.1, HEARD_UNSURE + 0.1];
  const high = [0.95, HEARD_UNSURE - 0.2, 0.9];
  assert.equal(directed(best(DIRECTED_ACT + 0.1), { sure: low, followsTurn: false }), "ask");
  assert.equal(directed(best(DIRECTED_ASK + 0.01), { sure: low, followsTurn: false }), "ignore");
  assert.equal(directed(best(DIRECTED_ASK - 0.1), { sure: low, followsTurn: false }), "ignore");
  assert.equal(directed(best(DIRECTED_ACT + 0.1), { sure: high, followsTurn: false }), "act", "one doubted word among sure ones is a misheard name, not a far voice");
  assert.equal(directed(best(DIRECTED_ACT + 0.1), { sure: [], followsTurn: false }), "act", "no numbers is not unsure");
});

test("directed: nearest to asking for nothing is never asked about", () => {
  assert.equal(directed(best(DIRECTED_ASK + 0.01, "nothing"), { followsTurn: false }), "ignore");
  assert.equal(directed(best(DIRECTED_ACT + 0.01, "nothing"), { followsTurn: false }), "act");
  assert.equal(directed(best(DIRECTED_ACT + 0.01, "nothing"), { sure: [0.1], followsTurn: false }), "ignore");
});

// ── shortlist ─────────────────────────────────────────────────────────────────

const order = (...list) => list.map((name, i) => ({ name, score: 1 - i / 100 }));

test("shortlist: with no ranking, none — the caller shows areas", () => {
  assert.deepEqual(shortlist(null, DECLARED), []);
});

test("shortlist: the best few, then those always shown", () => {
  const ranked = order(...DECLARED.map((c) => c.name));
  const shown = shortlist(ranked, DECLARED);
  assert.deepEqual(shown, [...DECLARED.slice(0, SHORTLIST).map((c) => c.name), ...ALWAYS_SHOWN]);
  assert.deepEqual(shortlist(ranked, DECLARED, 2), ["pause_music", "now_playing", ...ALWAYS_SHOWN]);
});

test("shortlist: one always shown that ranked high is not listed twice, and takes no place", () => {
  const shown = shortlist(order("nothing", "pause_music", "escalate", "now_playing", "add_pill"), DECLARED, 2);
  assert.deepEqual(shown, ["pause_music", "now_playing", "more_tools", "nothing", "escalate"]);
});

test("shortlist: only what is declared", () => {
  const few = DECLARED.filter((c) => ["pause_music", "now_playing", "nothing"].includes(c.name));
  assert.deepEqual(shortlist(order("approve_permission", "now_playing", "pause_music", "add_pill"), few), ["now_playing", "pause_music", "nothing"]);
});

test("shortlist: an empty ranking, or room for none, leaves those always shown", () => {
  assert.deepEqual(shortlist([], DECLARED), [...ALWAYS_SHOWN]);
  assert.deepEqual(shortlist(order("pause_music", "now_playing"), DECLARED, 0), [...ALWAYS_SHOWN]);
});

test("the whole way: index, ranking, then the three decisions", async () => {
  const declared = [
    { ...cap("pause_music", "reversible"), area: "music", description: "pause the music that is playing" },
    { ...cap("add_pill", "reversible", { pills: entities }), area: "pills", description: "add a pill to the island" },
    { ...cap("nothing", "free"), area: "app", description: "asks for nothing at all" },
  ];
  const index = new CapabilityIndex(fake().embed);
  await index.sync(declared.map((c) => ({ name: c.name, text: `${c.area}: ${c.description}` })));
  const ranked = await index.rank("pause the music that is playing");
  assert.equal(instant(ranked, declared), "pause_music");
  assert.equal(directed(ranked, { followsTurn: true }), "act");
  assert.deepEqual(shortlist(ranked, declared, 1), ["pause_music", "nothing"]);
  const stray = await index.rank("did you call the dentist");
  assert.equal(instant(stray, declared), null);
  assert.equal(directed(stray, { followsTurn: true }), "ignore");
});
