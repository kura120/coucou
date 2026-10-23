// Flow dictation, the page side: its settings and the lists the Settings page
// edits (src/core/flow.ts), the pill's dots and words (src/pill/dots.ts), and
// that the pill window is wired in (entry, capability, commands). The key
// logic, the text step and the paste are tested in Rust (src-tauri/src/flow/).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
import { calls, sent } from "./tauri.mjs";
import {
  DEFAULT_FLOW, FLOW_KEYS, FLOW_KEY_LABELS, MAX_ENTRIES, MAX_LENGTH, addReplacement, addWord, flowKeyName,
  normalizeFlow, removeAt,
} from "../src/core/flow.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { Bridge } from "../src/core/bridge.ts";
import { DOTS, HISTORY, REST, atRest, glide, messageText, pushLevel, targets } from "../src/pill/dots.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

installFakeDom();

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

beforeEach(() => {
  setLanguage("en");
  calls.length = 0;
});

// ── Settings ──────────────────────────────────────────────────────────────────

test("Flow is off by default, on right Ctrl, with nothing in its lists", () => {
  assert.deepEqual(DEFAULT_SETTINGS.flow, { enabled: false, key: "RightCtrl", replacements: [], dictionary: [] });
  assert.equal(DEFAULT_FLOW.enabled, false);
});

test("the keys to hold are three modifiers, each written the same in every language", () => {
  assert.deepEqual([...FLOW_KEYS], ["RightCtrl", "RightAlt", "RightShift"]);
  assert.deepEqual(FLOW_KEY_LABELS, { RightCtrl: "Right Ctrl", RightAlt: "Right Alt", RightShift: "Right Shift" });
});

test("a key this build does not know reads as right Ctrl, as Rust does", () => {
  assert.equal(flowKeyName("RightAlt"), "RightAlt");
  assert.equal(flowKeyName("F13"), "RightCtrl");
  assert.equal(flowKeyName(undefined), "RightCtrl");
  assert.equal(flowKeyName(3), "RightCtrl");
});

test("Flow's settings are read from whatever was saved, with defaults for the rest", () => {
  assert.deepEqual(normalizeFlow(undefined), DEFAULT_FLOW);
  assert.deepEqual(normalizeFlow("on"), DEFAULT_FLOW);
  assert.deepEqual(normalizeFlow({ enabled: true }), { ...DEFAULT_FLOW, enabled: true });
  assert.deepEqual(normalizeFlow({ enabled: 1, key: 5, replacements: "x", dictionary: {} }), DEFAULT_FLOW);
  assert.deepEqual(
    normalizeFlow({ replacements: [["a", "b"], ["c"], [1, 2], "d"], dictionary: ["Supabase", 4, null] }),
    { ...DEFAULT_FLOW, replacements: [["a", "b"]], dictionary: ["Supabase"] },
  );
});

// ── The lists ─────────────────────────────────────────────────────────────────

test("a replacement needs text on both sides, and is kept as typed but trimmed", () => {
  assert.deepEqual(addReplacement([], "  cloud code ", " Claude Code "), [["cloud code", "Claude Code"]]);
  assert.equal(addReplacement([], "", "x"), null);
  assert.equal(addReplacement([], "x", "   "), null);
  assert.equal(addReplacement([], "x".repeat(MAX_LENGTH + 1), "y"), null);
});

test("saying the same thing twice replaces the first replacement, whatever the case", () => {
  const list = [["cloud code", "Claude Code"], ["pay ka", "Peika"]];
  assert.deepEqual(addReplacement(list, "Cloud Code", "Claude Code CLI"), [
    ["Cloud Code", "Claude Code CLI"],
    ["pay ka", "Peika"],
  ]);
  assert.deepEqual(list[0], ["cloud code", "Claude Code"], "the list given is not changed");
});

test("a dictionary word is trimmed, and not added twice", () => {
  assert.deepEqual(addWord([], "  Supabase "), ["Supabase"]);
  assert.equal(addWord(["Supabase"], "supabase"), null);
  assert.equal(addWord([], "   "), null);
  assert.equal(addWord([], "w".repeat(MAX_LENGTH + 1)), null);
});

test("a list holds only so many entries", () => {
  const words = Array.from({ length: MAX_ENTRIES }, (_, i) => `word${i}`);
  assert.equal(addWord(words, "one more"), null);
  const pairs = words.map((w) => [w, w.toUpperCase()]);
  assert.equal(addReplacement(pairs, "one", "more"), null);
  // Changing one that is there is still allowed.
  assert.equal(addReplacement(pairs, "WORD3", "changed").length, MAX_ENTRIES);
});

test("removing an entry leaves the others in order", () => {
  assert.deepEqual(removeAt(["a", "b", "c"], 1), ["a", "c"]);
  assert.deepEqual(removeAt(["a"], 5), ["a"]);
});

// ── The pill's dots ───────────────────────────────────────────────────────────

test("levels go in front, newest first, and are kept to what the dots show", () => {
  let h = [];
  for (const v of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) h = pushLevel(h, v);
  assert.equal(h.length, HISTORY);
  assert.deepEqual(h.slice(0, 2), [0.7, 0.6]);
  assert.deepEqual(pushLevel([], 4), [1], "a level is a fraction");
  assert.deepEqual(pushLevel([], -1), [0]);
  assert.deepEqual(pushLevel([], Number.NaN), [0]);
});

test("the newest level is the middle dot and older ones fall away to both sides", () => {
  const dots = targets([1, 0.5, 0.25, 0, 0]);
  assert.equal(dots.length, DOTS);
  const middle = Math.floor(DOTS / 2);
  assert.equal(dots[middle], 1);
  assert.equal(dots[middle - 1], dots[middle + 1]);
  assert.ok(dots[middle - 1] < dots[middle] && dots[middle - 2] < dots[middle - 1]);
  assert.equal(dots[0], REST);
  assert.deepEqual(targets([]), Array(DOTS).fill(REST));
});

test("the dots rise quickly, fall slowly, and come to rest", () => {
  const rest = Array(DOTS).fill(REST);
  const loud = Array(DOTS).fill(1);
  const up = glide(rest, loud, 0.033)[0];
  const down = glide(loud, rest, 0.033)[0];
  assert.ok(up - REST > 1 - down, "it rises further in a frame than it falls");
  let shown = rest;
  for (let i = 0; i < 200; i++) shown = glide(shown, loud, 0.033);
  assert.ok(atRest(shown, loud));
  assert.ok(!atRest(rest, loud));
});

// ── The pill's words ──────────────────────────────────────────────────────────

test("every message code has its own words, and an unknown one says why Flow stopped", () => {
  const codes = ["empty", "noengine", "busy", "elevated", "away", "copied"];
  const texts = codes.map((c) => messageText(c, ""));
  assert.equal(new Set(texts).size, codes.length);
  for (const text of texts) assert.ok(text.length > 5);
  assert.equal(messageText("failed", "No microphone"), "Flow stopped: No microphone");
  assert.equal(messageText("failed", ""), "Flow stopped.");
  // The ones that leave the words on the clipboard say how to paste them.
  for (const c of ["elevated", "away", "copied"]) assert.match(messageText(c, ""), /Ctrl\+V/);
});

test("the messages are put in words in another language", () => {
  setLanguage("fr");
  assert.notEqual(messageText("empty", ""), "Nothing was heard.");
  assert.notEqual(messageText("elevated", ""), messageText("away", ""));
});

// ── The commands ──────────────────────────────────────────────────────────────

test("the pill's ✕ and ✓ and its state are Bridge commands", async () => {
  await Bridge.flowPillCancel();
  await Bridge.flowPillFinish();
  await Bridge.flowPillState();
  assert.deepEqual(calls.map(([name]) => name), ["flow_pill_cancel", "flow_pill_finish", "flow_pill_state"]);
  assert.equal(sent("flow_pill_finish").length, 1);
});

// ── The window is wired in ────────────────────────────────────────────────────

test("the pill page is built, may call Peika's commands, and is a window the capability names", () => {
  assert.match(read("vite.config.ts"), /pill: resolve\(__dirname, "pill\.html"\)/);
  assert.match(read("pill.html"), /src\/pill\/main\.ts/);
  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert.ok(capability.windows.includes("pill"));
  const lib = read("src-tauri/src/lib.rs");
  for (const command of ["flow_pill_state", "flow_pill_finish", "flow_pill_cancel"]) {
    assert.ok(lib.includes(`flow::${command}`), command);
  }
});
