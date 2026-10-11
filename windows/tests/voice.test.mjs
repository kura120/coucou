// "OK Coucou": the island's listening state (src/island/fsm.ts), when a wake
// phrase is ignored and what each report from Rust does (src/island/voice.ts).
// The session itself is tested in Rust (src-tauri/src/voice/session.rs).

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { IslandStateMachine } from "../src/island/fsm.ts";
import { applyVoice, decodeSpeech, speechGain, wakeBlocked } from "../src/island/voice.ts";
import { VIEW_LAYOUTS, islandSize } from "../src/core/layout.ts";
import { isCard, isPlace } from "../src/island/restore.ts";
import { SHORTCUTS, activeKeys } from "../src/core/shortcuts.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

let fsm;
let transitions;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  fsm = new IslandStateMachine();
  transitions = [];
  fsm.onTransition = (from, to) => transitions.push(`${from}>${to}`);
});

afterEach(() => mock.timers.reset());

const seconds = (n) => mock.timers.tick(n * 1000);

// ── The listening state (VoiceIslandTests) ────────────────────────────────────

test("the wake phrase opens the listening state from hidden, and it ends compact", () => {
  fsm.voiceWoke();
  assert.equal(fsm.state, "listening");
  fsm.voiceFinished();
  assert.equal(fsm.state, "petit");
  assert.deepEqual(transitions, ["hidden>listening", "listening>petit"]);
});

test("from the compact island it ends compact", () => {
  fsm.reveal();
  fsm.voiceWoke();
  fsm.voiceFinished();
  assert.equal(fsm.state, "petit");
});

test("an island that was open is open again afterwards", () => {
  fsm.forceHome();
  fsm.voiceWoke();
  assert.equal(fsm.state, "listening");
  fsm.voiceFinished();
  assert.equal(fsm.state, "home");
});

test("the greeting gives way to listening and is not gone back to", () => {
  fsm.launch();
  fsm.voiceWoke();
  assert.equal(fsm.state, "listening");
  // The greeting's own collapse must not fold the listening island.
  fsm.greetComplete();
  seconds(30);
  assert.equal(fsm.state, "listening");
  fsm.voiceFinished();
  assert.equal(fsm.state, "petit");
});

test("it never folds by itself while listening, whatever the mouse does", () => {
  fsm.forceHome();
  fsm.mouseLeft(); // the open island's countdown is running
  fsm.voiceWoke();
  fsm.mouseEntered();
  fsm.mouseLeft();
  fsm.click();
  seconds(600);
  assert.equal(fsm.state, "listening");
});

test("hovering does not turn a listening island into a hover-opened one", () => {
  fsm.openOnHover = true;
  fsm.voiceWoke();
  fsm.mouseEntered();
  assert.equal(fsm.state, "listening");
  assert.equal(fsm.openedByHover, false);
});

test("a second wake phrase while listening changes nothing", () => {
  fsm.forceHome();
  fsm.voiceWoke();
  fsm.voiceWoke();
  fsm.voiceFinished();
  // Still remembers the island was open before the first one.
  assert.equal(fsm.state, "home");
  assert.deepEqual(transitions, ["hidden>home", "home>listening", "listening>home"]);
});

test("the end of a command does nothing once the island has moved on", () => {
  fsm.voiceWoke();
  fsm.forcePetit(); // Escape
  fsm.voiceFinished();
  assert.equal(fsm.state, "petit");
  fsm.forceHome();
  fsm.voiceFinished();
  assert.equal(fsm.state, "home");
});

test("an alert takes the island from listening like from anywhere", () => {
  fsm.voiceWoke();
  fsm.forceHome();
  assert.equal(fsm.state, "home");
  assert.deepEqual(transitions, ["hidden>listening", "listening>home"]);
});

// ── When a wake phrase is ignored (VoiceWakeFilter) ───────────────────────────

test("a wake phrase is taken on a closed island and on the views one only looks at", () => {
  for (const mode of ["hidden", "compact"]) {
    for (const view of ["overview", "approval", "prompt"]) assert.equal(wakeBlocked(view, mode, false, false), null);
  }
  for (const view of ["overview", "empty", "settings", "finished", "error", "wardrobe", "listening", "voiceResult", "recap"]) {
    assert.equal(wakeBlocked(view, "expanded", false, false), null, view);
  }
});

test("a request waiting for an answer comes first, open or folded away", () => {
  assert.equal(wakeBlocked("overview", "compact", true, false), "approval shown");
  assert.equal(wakeBlocked("overview", "hidden", true, false), "approval shown");
  assert.equal(wakeBlocked("approval", "expanded", false, false), "approval shown");
  assert.equal(wakeBlocked("question", "expanded", false, false), "question shown");
});

test("the chat being written in is not interrupted", () => {
  assert.equal(wakeBlocked("prompt", "expanded", false, false), "chat shown");
});

test("a paused Coucou does not wake", () => {
  assert.equal(wakeBlocked("overview", "hidden", false, true), "paused");
});

// ── Rust's reports ────────────────────────────────────────────────────────────

test("each report reaches the island as what it is", () => {
  const calls = [];
  const island = {
    voiceWoke: () => calls.push("woke"),
    voiceHeard: (text, final) => calls.push(`${final ? "final" : "partial"}:${text}`),
    voiceMissed: () => calls.push("missed"),
    voiceCancelled: () => calls.push("cancelled"),
    voiceFollowing: (on) => calls.push(on ? "following" : "rested"),
  };
  for (const [phase, text] of [["woke", ""], ["partial", "next"], ["final", "next track"], ["missed", ""], ["cancelled", ""]]) {
    applyVoice(island, { phase, text });
  }
  assert.deepEqual(calls, ["woke", "partial:next", "final:next track", "missed", "cancelled"]);
  // Around the time another command may follow without the wake phrase.
  applyVoice(island, { phase: "following", text: "" });
  applyVoice(island, { phase: "rested", text: "" });
  assert.deepEqual(calls.slice(5), ["following", "rested"]);
  // A phase a later build might add is ignored, not an error.
  applyVoice(island, { phase: "something-new", text: "" });
  assert.equal(calls.length, 7);
});

// ── Mochi's voice ─────────────────────────────────────────────────────────────

test("speech arrives as 16-bit samples in base64 and plays as it was made", () => {
  // 0, full scale up, full scale down, a quarter: little-endian, as Rust writes them.
  const bytes = Uint8Array.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x20]);
  const samples = decodeSpeech(Buffer.from(bytes).toString("base64"));
  assert.equal(samples.length, 4);
  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 1) < 0.001);
  assert.equal(samples[2], -1);
  assert.equal(samples[3], 0.25);
  assert.equal(decodeSpeech("").length, 0);
  // A byte left over is not half a sample.
  assert.equal(decodeSpeech(Buffer.from([1, 2, 3]).toString("base64")).length, 1);
});

test("Mochi speaks at full level at the usual volume, quieter below, never louder", () => {
  assert.equal(speechGain(0.12), 1);
  assert.equal(speechGain(0.2), 1);
  assert.equal(speechGain(0.06), 0.5);
  assert.equal(speechGain(0), 0);
});

// ── The view, the shortcut, the setting ───────────────────────────────────────

test("the listening view is the Mac's: 160 high, Mochi at 68, 58 wide", () => {
  assert.deepEqual(VIEW_LAYOUTS.listening, { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "none" });
  assert.deepEqual(islandSize("expanded", "listening"), { w: 640, h: 160 });
});

test("the result card has the same shape, so nothing moves when it replaces the listening view", () => {
  assert.deepEqual(VIEW_LAYOUTS.voiceResult, VIEW_LAYOUTS.listening);
});

test("the voice views are neither a place the island comes back to nor a card over one", () => {
  for (const view of ["listening", "voiceResult"]) {
    assert.equal(isPlace(view), false);
    assert.equal(isCard(view), false);
  }
});

test("talking to Coucou has the Mac's key and is off until turned on", () => {
  const talk = SHORTCUTS.find((d) => d.id === "talkToCoucou");
  assert.deepEqual(talk, { id: "talkToCoucou", defaultKeys: "Ctrl+Alt+V", enabledByDefault: false, ported: true });
  assert.ok(!activeKeys({}).some(([id]) => id === "talkToCoucou"));
  assert.ok(activeKeys({ talkToCoucou: { keys: "Ctrl+Alt+V", enabled: true } }).some(([id]) => id === "talkToCoucou"));
});

test("voice is off by default, with the wake phrase ready for when it is turned on", () => {
  assert.deepEqual(DEFAULT_SETTINGS.voice, {
    enabled: false, wake: true, brain: "", brainModel: "", engine: "system", followUp: 8,
    speak: false, speaker: "female",
  });
});
