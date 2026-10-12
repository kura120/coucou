// The registry (src/core/capabilities/registry.ts): what is declared, how a
// capability is shown to a model (schema.ts), what a model is told every time
// (the snapshot), and the matcher's own judgement (match.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { among, contained } from "../src/core/capabilities/match.ts";
import { SNAPSHOT_MOST, createRegistry } from "../src/core/capabilities/registry.ts";
import { check } from "../src/core/capabilities/validate.ts";
import { done } from "../src/voice/result.ts";

const WORDS = {
  refused: () => "refused", unavailable: () => "unavailable", failed: () => "failed", notFound: (said) => `no ${said}`,
  unchanged: () => "unchanged", nothingToUndo: () => "nothing", one: (label) => `${label}?`, which: (labels) => `${labels.join(" / ")}?`,
};
const make = () => createRegistry({ guard: { confirm: async () => false }, words: WORDS });
const cap = (name, part = {}) => ({ name, area: "test", description: `Does ${name}.`, args: {}, tier: "free", run: async () => done("Done"), ...part });

// ── Declaring ─────────────────────────────────────────────────────────────────

test("capabilities are kept in the order declared, by name and by area", () => {
  const registry = make();
  registry.declare(cap("pause_music", { area: "music" }), cap("show_view", { area: "views" }));
  registry.declare(cap("next_track", { area: "music" }));
  assert.deepEqual(registry.all().map((c) => c.name), ["pause_music", "show_view", "next_track"]);
  assert.equal(registry.get("show_view").area, "views");
  assert.equal(registry.get("approve_permission"), undefined);
  assert.equal(registry.get("toString"), undefined);
  assert.deepEqual(registry.areas(), [
    { area: "music", names: ["pause_music", "next_track"] },
    { area: "views", names: ["show_view"] },
  ]);
});

test("a name declared twice is an error, and nothing of that declaration is kept", () => {
  const registry = make();
  registry.declare(cap("pause_music"));
  assert.throws(() => registry.declare(cap("next_track"), cap("pause_music")), /declared twice/);
  assert.throws(() => registry.declare(cap("stop"), cap("stop")), /declared twice/);
  assert.deepEqual(registry.all().map((c) => c.name), ["pause_music"]);
  registry.entities({ kind: "pill", description: "Pills.", list: () => [] });
  assert.throws(() => registry.entities({ kind: "pill", description: "Pills again.", list: () => [] }), /declared twice/);
});

test("a capability declared wrong is found when it is declared", () => {
  const registry = make();
  assert.throws(() => registry.declare(cap("Pause Music")), /snake_case/);
  assert.throws(() => registry.declare(cap("send", { tier: "confirm" })), /no describe/);
  assert.throws(() => registry.declare(cap("mute", { tier: "reversible" })), /no inverse/);
  assert.throws(() => registry.declare(cap("state", { inSnapshot: true })), /must be a read/);
  assert.throws(() => registry.declare(cap("state", { tier: "read", inSnapshot: true, args: { of: { type: "string", description: "What." } } })), /needs no argument/);
  assert.deepEqual(registry.all(), []);
});

// ── Schemas ───────────────────────────────────────────────────────────────────

test("a capability is an OpenAI function tool, with only what was declared", () => {
  const registry = make();
  registry.declare(cap("set_volume", {
    tier: "confirm",
    describe: () => ({ title: "t", change: "c", action: "a" }),
    args: {
      percent: { type: "number", min: 0, max: 100, description: "0 to 100." },
      fade: { type: "boolean", optional: true, description: "Fade to it." },
      curve: { type: "string", optional: true, enum: ["linear", "smooth"], description: "How." },
      note: { type: "string", optional: true, maxLength: 80, description: "A note." },
      on: { type: "entity", kind: "app", description: "The app that plays." },
      also: { type: "entities", kind: "pill", max: 3, optional: true, description: "Pills to tell." },
      all: { type: "entities", kind: "pill", optional: true, description: "Any number." },
    },
  }));
  assert.deepEqual(registry.schema("set_volume"), {
    type: "function",
    function: {
      name: "set_volume",
      description: "Does set_volume.",
      parameters: {
        type: "object",
        properties: {
          percent: { type: "number", description: "0 to 100.", minimum: 0, maximum: 100 },
          fade: { type: "boolean", description: "Fade to it." },
          curve: { type: "string", description: "How.", enum: ["linear", "smooth"] },
          note: { type: "string", description: "A note.", maxLength: 80 },
          on: { type: "string", description: "The app that plays. A app: its name or its id." },
          also: { type: "array", description: "Pills to tell.", items: { type: "string", description: "A pill: its name or its id." }, maxItems: 3 },
          all: { type: "array", description: "Any number.", items: { type: "string", description: "A pill: its name or its id." } },
        },
        required: ["percent", "on"],
        additionalProperties: false,
      },
    },
  });
  // Neither the tier nor the guard is anywhere in what a model reads.
  assert.doesNotMatch(JSON.stringify(registry.schema("set_volume")), /confirm|tier|guard/);
  assert.equal(registry.schema("install_hooks"), null);
});

test("a capability with no argument is a tool with an empty object", () => {
  const registry = make();
  registry.declare(cap("pause_music"));
  assert.deepEqual(registry.schema("pause_music").function.parameters, { type: "object", properties: {}, required: [], additionalProperties: false });
});

// ── The snapshot ──────────────────────────────────────────────────────────────

test("the snapshot is the reads that are always told, the screen, and a line for each kind", async () => {
  const registry = make();
  let ran = 0;
  registry.declare(
    cap("now_playing", { tier: "read", inSnapshot: true, run: async () => done("Playing", true, { track: "So What", playing: true }) }),
    cap("timer", { tier: "read", inSnapshot: true, run: async () => done("No timer") }),
    cap("search", { tier: "read", run: async () => (ran++, done("Searched")) }),
    cap("pause_music", { run: async () => (ran++, done("Paused")) }),
  );
  registry.entities({ kind: "view", description: "The island's views:", list: async () => [{ id: "music", label: "Music" }, { id: "chat", label: "Chat" }] });
  registry.entities({ kind: "app", description: "The installed apps, by name.", list: () => [{ id: "x", label: "Never listed" }], near: async () => [] });
  registry.screen(() => ({ view: "chat", subjects: [{ kind: "session", id: "agent_claude", label: "Claude" }], summary: "A conversation with Claude." }));

  assert.deepEqual(await registry.snapshot(), {
    screen: { view: "chat", subjects: [{ kind: "session", id: "agent_claude", label: "Claude" }], summary: "A conversation with Claude." },
    entities: { view: "The island's views: Music, Chat.", app: "The installed apps, by name." },
    state: { now_playing: { track: "So What", playing: true }, timer: "No timer" },
  });
  assert.equal(ran, 0);
});

test("the snapshot leaves out what has nothing to say, cannot be used, or breaks", async () => {
  const registry = make();
  assert.deepEqual(await registry.snapshot(), {});
  registry.declare(
    cap("off", { tier: "read", inSnapshot: true, available: () => "No music app.", run: async () => done("Never") }),
    cap("throws", { tier: "read", inSnapshot: true, run: async () => { throw new Error("boom"); } }),
    cap("fails", { tier: "read", inSnapshot: true, run: async () => ({ status: "failed", verified: false, line: "No" }) }),
    cap("fine", { tier: "read", inSnapshot: true, run: async () => done("Fine") }),
  );
  registry.entities({ kind: "pill", description: "The pills.", list: () => { throw new Error("boom"); } });
  registry.screen(() => null);
  assert.deepEqual(await registry.snapshot(), { entities: { pill: "The pills." }, state: { fine: "Fine" } });
  registry.screen(() => { throw new Error("boom"); });
  assert.deepEqual((await registry.snapshot()).state, { fine: "Fine" });
});

test("the snapshot is bounded, however much the app has to say", async () => {
  const registry = make();
  const long = "x".repeat(5000);
  registry.declare(...Array.from({ length: 40 }, (_, i) => cap(`read_${i}`, { tier: "read", inSnapshot: true, run: async () => done("Read", true, { text: long }) })));
  registry.entities({ kind: "pill", description: "The pills:", list: () => Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, label: `Pill ${i}` })) });
  registry.entities({ kind: "long", description: long, list: () => [] });
  registry.screen(() => ({ view: "pills", subjects: Array.from({ length: 50 }, (_, i) => ({ kind: "pill", id: `p${i}`, label: long })), summary: long }));
  const snapshot = await registry.snapshot();
  assert.ok(JSON.stringify(snapshot).length <= SNAPSHOT_MOST + 200, `${JSON.stringify(snapshot).length} characters`);
  assert.equal(snapshot.screen.subjects.length, 8);
  assert.match(snapshot.entities.pill, /^The pills: Pill 0, .*Pill 11, and 188 more\.$/);
  assert.ok(snapshot.entities.long.length <= 400);
  assert.ok(Object.keys(snapshot.state).length < 40);
  assert.ok(snapshot.state.read_0.endsWith("…"));
});

// ── The matcher ───────────────────────────────────────────────────────────────

const THINGS = [
  { id: "dl", label: "Downloads" },
  { id: "docs", label: "Documents" },
  { id: "vs", label: "Visual Studio Code", spoken: ["vs code"] },
  { id: "vs22", label: "Visual Studio 2022" },
  { id: "é", label: "Études" },
];

test("the matcher: an id, a name, a spoken form, a word of a name, a name among words", () => {
  const sure = (said, id) => assert.deepEqual(among(said, THINGS), { is: "sure", id, label: THINGS.find((t) => t.id === id).label }, said);
  sure("dl", "dl");
  sure("downloads", "dl");
  sure("Downloads!", "dl");
  sure("vs code", "vs");
  sure("code", "vs");
  sure("the downloads folder", "dl");
  sure("etudes", "é");
  sure("downlodes", "dl");
});

test("the matcher: near is unsure, as near is a choice, nothing is none", () => {
  const near = among("documenta", THINGS);
  assert.equal(near.is, "unsure");
  assert.deepEqual(near.candidates.map((c) => c.id), ["docs"]);
  const two = among("visual studio", THINGS);
  assert.equal(two.is, "unsure");
  assert.deepEqual(two.candidates.map((c) => c.id).sort(), ["vs", "vs22"]);
  assert.deepEqual(among("spreadsheet", THINGS), { is: "none", near: [] });
  assert.deepEqual(among("", THINGS), { is: "none", near: [] });
  assert.deepEqual(among("downloads", []), { is: "none", near: [] });
  // Too short to tell a name by, unless it is one.
  assert.equal(among("doc", THINGS).is, "none");
});

test("the matcher: a source's own ranking is judged, not ranked again", () => {
  const scores = new Map([["dl", 0.8], ["docs", 0.78]]);
  const found = among("dee ell", THINGS, { scores });
  assert.equal(found.is, "unsure");
  assert.deepEqual(found.candidates.map((c) => [c.id, c.score]), [["dl", 0.8], ["docs", 0.78]]);
  assert.deepEqual(among("dee ell", THINGS, { scores: new Map([["dl", 0.9], ["docs", 0.5]]) }).candidates.map((c) => c.id), ["dl"]);
  assert.equal(among("dee ell", THINGS, { scores: new Map() }).is, "none");
});

test("the matcher: names said whole in a sentence, the longer one when one is inside another", () => {
  const things = [{ id: "c", label: "Claude" }, { id: "cc", label: "Claude Code" }, { id: "g", label: "GitHub", spoken: ["git hub"] }];
  assert.deepEqual(contained("add claude code and git hub", things).map((t) => t.id), ["cc", "g"]);
  assert.deepEqual(contained("add claude and github", things).map((t) => t.id), ["c", "g"]);
  assert.deepEqual(contained("add nothing", things), []);
});

// ── Arguments ─────────────────────────────────────────────────────────────────

test("check: what was declared, coerced; an optional one left out is absent", () => {
  const specs = {
    text: { type: "string", description: "Text." },
    count: { type: "number", optional: true, description: "How many." },
    on: { type: "boolean", optional: true, description: "On." },
  };
  assert.deepEqual(check(specs, { text: 5 }), { ok: true, args: { text: "5" } });
  assert.deepEqual(check(specs, { text: "a", count: "3", on: "off", more: 1 }), { ok: true, args: { text: "a", count: 3, on: false } });
  assert.deepEqual(check(specs, { text: "a", count: null, on: undefined }), { ok: true, args: { text: "a" } });
  assert.equal(check(specs, { text: "a", count: "three" }).ok, false);
  assert.equal(check(specs, { text: "a", count: Infinity }).ok, false);
  assert.equal(check(specs, { text: ["a"] }).ok, false);
  assert.equal(check(specs, null).ok, false);
  assert.deepEqual(check({}, undefined), { ok: true, args: {} });
  assert.deepEqual(check({}, ""), { ok: true, args: {} });
});
