// The screen capture (`capture-taken`, src/island/capture.ts) and its card
// (src/views/capture.ts), through the real bridge: the event comes in the way Rust
// emits it, and what the island asks of Rust is read from the commands it invokes.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, sent } from "./tauri.mjs";

installFakeDom();
const { registerCaptureHandlers, pasteCapture, askAboutCapture, closeCapture } = await import(
  "../src/island/capture.ts"
);
const { buildCapture } = await import("../src/views/capture.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

const PATH = "C:\\Users\\kura1\\AppData\\Local\\Temp\\peika-capture-1.png";
const THUMB = "data:image/png;base64,iVBORw0KGgo=";
const shot = (path = PATH) => ({ path, width: 1280, height: 720, thumb: THUMB });

/** What the island was asked to do, in order. */
let asked;
const host = {
  alert: (view) => asked.push(`alert:${view}`),
  setView: (view) => asked.push(`setView:${view}`),
  collapse: () => asked.push("collapse"),
  gulpCapture: () => asked.push("gulp"),
};

/** What the capture card's own buttons asked the island to do, in order. */
let heard;
const actions = {
  capturePaste: () => heard.push("paste"),
  captureAsk: () => heard.push("ask"),
  captureClose: () => heard.push("close"),
};

// The clock the card's click guard reads (performance.now), set by each test.
let clock = 10_000;
let nowMock;

registerCaptureHandlers(host);
await flush();

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  nowMock = mock.method(performance, "now", () => clock);
  clock = 10_000;
  calls.length = 0;
  asked = [];
  heard = [];
  State.capture = null;
  State.paused = false;
  State.mode = "expanded";
  State.view = "overview";
  State.tasks = [];
  State.pendingApproval = null;
  State.droppedFile = null;
  State.promptContext = null;
  State.chatHistory = [];
  State.settings = { ...DEFAULT_SETTINGS };
});

afterEach(() => {
  nowMock.mock.restore();
  mock.timers.reset();
});

/** The card as the island builds it, shown on a capture. */
function card(picture = shot()) {
  State.capture = picture;
  const view = buildCapture(actions);
  view.sync();
  return view;
}

const button = (view, label) => view.el.find("BUTTON").find((b) => b.textContent === label);
const sizeLine = (view) => view.el.find(".sub")[0].textContent;
const pastClick = () => (clock += 700); // past the card's 600 ms guard

// ── The event ─────────────────────────────────────────────────────────────────

test("a capture fills State.capture, Peika swallows it, and the capture card comes up", () => {
  const first = shot();
  emit("capture-taken", first);
  assert.deepEqual(State.capture, first);
  assert.deepEqual(asked, ["gulp", "alert:capture"]);
  assert.deepEqual(sent("capture_discard"), []);
});

test("a second capture discards the first file and replaces it on the card", () => {
  const first = shot();
  const second = shot("C:\\Temp\\peika-capture-2.png");
  emit("capture-taken", first);
  emit("capture-taken", second);
  assert.deepEqual(sent("capture_discard"), [{ path: first.path }]);
  assert.deepEqual(State.capture, second);
});

test("a paused island shows no capture and keeps no file", () => {
  State.paused = true;
  emit("capture-taken", shot());
  assert.equal(State.capture, null);
  assert.deepEqual(asked, []);
  assert.deepEqual(sent("capture_discard"), [{ path: PATH }]);
});

// ── Paste ─────────────────────────────────────────────────────────────────────

test("Paste pastes the picture, then discards it, and folds the island", async () => {
  State.capture = shot();
  await pasteCapture(host);
  assert.deepEqual(calls.map(([name]) => name).filter((name) => name.startsWith("capture_")), [
    "capture_paste",
    "capture_discard",
  ]);
  assert.deepEqual(sent("capture_paste"), [{ path: PATH }]);
  assert.deepEqual(sent("capture_discard"), [{ path: PATH }]);
  assert.deepEqual(asked, ["collapse"]);
  assert.equal(State.capture, null);
});

test("the Paste button of the card asks the island for the paste", () => {
  const view = card();
  pastClick();
  button(view, "Paste").fire("click");
  assert.deepEqual(heard, ["paste"]);
});

// ── Copy ──────────────────────────────────────────────────────────────────────

test("Copy copies the picture and keeps the card, showing Copied for a moment", async () => {
  const view = card();
  let notified = 0;
  const unsubscribe = State.subscribe(() => notified++);
  pastClick();
  button(view, "Copy").fire("click");
  await flush();
  assert.deepEqual(sent("capture_copy"), [{ path: PATH }]);
  assert.equal(State.capture?.path, PATH);
  assert.equal(sizeLine(view), "Copied");

  // The timer redraws the card and keeps the island's frame loop running.
  mock.timers.tick(1500);
  clock += 1500;
  assert.equal(notified, 1);
  view.sync();
  assert.equal(sizeLine(view), "1280 × 720");
  unsubscribe();
});

// ── Ask ───────────────────────────────────────────────────────────────────────

test("Ask hands the picture to a fresh chat, as a dropped file is handed over", async () => {
  State.capture = shot();
  State.chatHistory = [{ role: "user", text: "an older question" }];
  askAboutCapture(host);
  await flush();
  assert.deepEqual(State.droppedFile, { name: "peika-capture-1.png", path: PATH });
  assert.deepEqual(State.promptContext, { kind: "file", name: "peika-capture-1.png", path: PATH });
  assert.deepEqual(State.chatHistory, []);
  assert.equal(sent("chat_reset").length, 1);
  assert.deepEqual(asked, ["setView:prompt"]);
  // The chat reads the file: it is not thrown away, and the card lets go of it.
  assert.deepEqual(sent("capture_discard"), []);
  assert.equal(State.capture, null);
});

test("the Ask button of the card asks the island for the chat", () => {
  const view = card();
  pastClick();
  button(view, "Ask").fire("click");
  assert.deepEqual(heard, ["ask"]);
});

// ── Draw on it ────────────────────────────────────────────────────────────────

test("Draw on it opens the picture in Paint and keeps the card", () => {
  const view = card();
  pastClick();
  button(view, "Draw on it").fire("click");
  assert.deepEqual(sent("capture_open"), [{ path: PATH }]);
  assert.equal(State.capture?.path, PATH);
  assert.deepEqual(sent("capture_discard"), []);
});

// ── Close ─────────────────────────────────────────────────────────────────────

test("the close discards the picture, clears it and goes back to the default view", async () => {
  State.capture = shot();
  closeCapture(host);
  await flush();
  assert.deepEqual(sent("capture_discard"), [{ path: PATH }]);
  assert.equal(State.capture, null);
  assert.deepEqual(asked, [`setView:${State.defaultView()}`]);
});

test("the ✕ of the card asks the island to close the capture", () => {
  const view = card();
  pastClick();
  view.el.find(".capture-close")[0].fire("click");
  assert.deepEqual(heard, ["close"]);
});

// ── The click guard and the picture ───────────────────────────────────────────

test("clicks in the first 600 ms after a capture appears do nothing", () => {
  const view = card();
  button(view, "Paste").fire("click");
  button(view, "Copy").fire("click");
  button(view, "Ask").fire("click");
  button(view, "Draw on it").fire("click");
  view.el.find(".capture-close")[0].fire("click");
  clock += 599;
  button(view, "Paste").fire("click");
  assert.deepEqual(heard, []);
  assert.deepEqual(sent("capture_copy"), []);
  assert.deepEqual(sent("capture_open"), []);
});

test("the card shows the picture at its size, and a new picture restarts the guard", () => {
  const view = card();
  assert.equal(view.el.querySelector(".capture-thumb").getAttribute("src"), THUMB);
  assert.equal(sizeLine(view), "1280 × 720");

  clock += 700;
  button(view, "Paste").fire("click");
  assert.deepEqual(heard, ["paste"]);

  // A new capture: the same card now waits out the guard again.
  State.capture = shot("C:\\Temp\\peika-capture-2.png");
  view.sync();
  button(view, "Paste").fire("click");
  assert.deepEqual(heard, ["paste"]);
});
