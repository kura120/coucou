// "While you were away" (src/island/away.ts and the card in src/views/away.ts):
// what the record keeps, the threshold, "cleared once seen", the slow timer that
// asks Rust for the idle time only while something is waiting to be told, and
// the card with its lines. Rust's answers are stubbed behind the real bridge.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals } from "./tauri.mjs";

installFakeDom();
const { AwayRecord, Away, POLL_MS, SAME_IDLE_MS, MAX_EVENTS, registerAwayHandlers } = await import("../src/island/away.ts");
const { buildAway, MAX_LINES } = await import("../src/views/away.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

const MIN = 60_000;
const original = internals.invoke;

/** A task as State keeps it. */
const task = (id, state = "idle", name = id) => ({
  id, name, color: "#7c5cff", state, stepIndex: 0, steps: [], source: "agent", isIntegration: false,
});

// ── The record ────────────────────────────────────────────────────────────────

test("a session that finishes, fails or asks is recorded; the rest of its life is not", () => {
  const record = new AwayRecord();
  const a = task("a");
  record.observe([a], 0); // the first look only learns what is there
  assert.deepEqual(record.events, []);
  for (const [state, kind] of [["finished", "finished"], ["error", "error"], ["approval", "approval"], ["question", "question"]]) {
    for (const quiet of ["working", "thinking", "searching", "ratelimit", "idle", "sleeping"]) {
      a.state = quiet;
      assert.equal(record.observe([a], 5), false, quiet);
    }
    a.state = state;
    assert.equal(record.observe([a], 10), true, state);
    assert.equal(record.events.length, 1);
    assert.equal(record.events[0].kind, kind);
  }
  assert.deepEqual(record.events.map((e) => e.at), [10]);
});

test("a state that is still the same is not news again", () => {
  const record = new AwayRecord();
  const a = task("a");
  record.observe([a], 0);
  a.state = "finished";
  assert.equal(record.observe([a], 1), true);
  assert.equal(record.observe([a], 2), false);
  assert.equal(record.events[0].at, 1);
});

test("what is already there at the first look is not news", () => {
  const record = new AwayRecord();
  assert.equal(record.observe([task("a", "approval"), task("b", "error")], 0), false);
  assert.deepEqual(record.events, []);
});

test("a pill has one line, its latest, and only its name and state are kept", () => {
  const record = new AwayRecord();
  const a = task("a", "idle", "Claude Code");
  a.steps = ["rm -rf secrets"];
  a.finalLine = "the password is hunter2";
  record.observe([a, task("b")], 0);
  a.state = "approval";
  record.observe([a], 1);
  a.state = "working";
  record.observe([a], 2);
  a.state = "finished";
  record.observe([a], 3);
  assert.equal(record.events.length, 1);
  assert.deepEqual(record.events[0], { id: "a", name: "Claude Code", color: "#7c5cff", kind: "finished", at: 3 });
  assert.deepEqual(Object.keys(record.events[0]).sort(), ["at", "color", "id", "kind", "name"]);
});

test("the record is bounded", () => {
  const record = new AwayRecord();
  const many = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => task(`t${i}`));
  record.observe(many, 0);
  many.forEach((t, i) => {
    t.state = "finished";
    record.observe(many, i + 1);
  });
  assert.equal(record.events.length, MAX_EVENTS);
  assert.equal(record.events[0].id, "t5");
});

// ── The idle time ─────────────────────────────────────────────────────────────

/** A record with one finished session at `at`. */
function recorded(at, state = "finished") {
  const record = new AwayRecord();
  const a = task("a", "idle", "Claude Code");
  record.observe([a], 0);
  a.state = state;
  record.observe([a], at);
  return record;
}

test("the user comes back after the threshold: one report, then nothing is left", () => {
  // Last input at 0; the session finishes at 5 min; a look at 12 min, another when the user is back at 30 min.
  const record = recorded(5 * MIN);
  assert.equal(record.poll(12 * MIN, 12 * MIN, 10 * MIN), null);
  assert.equal(record.events.length, 1);
  const report = record.poll(2_000, 30 * MIN, 10 * MIN);
  assert.equal(report.minutes, 30);
  assert.deepEqual(report.events.map((e) => [e.id, e.kind]), [["a", "finished"]]);
  assert.deepEqual(record.events, [], "cleared once seen");
  assert.equal(record.poll(2_000, 31 * MIN, 10 * MIN), null);
});

test("a stretch shorter than the threshold tells nothing, and the record is thrown away", () => {
  const record = recorded(2 * MIN);
  assert.equal(record.poll(3 * MIN, 3 * MIN, 10 * MIN), null);
  assert.equal(record.poll(1_000, 8 * MIN, 10 * MIN), null);
  assert.deepEqual(record.events, []);
});

test("the threshold itself counts as away", () => {
  const record = recorded(2 * MIN);
  record.poll(3 * MIN, 3 * MIN, 10 * MIN);
  assert.equal(record.poll(0, 10 * MIN, 10 * MIN)?.minutes, 10);
  const shorter = recorded(2 * MIN);
  shorter.poll(3 * MIN, 3 * MIN, 10 * MIN);
  assert.equal(shorter.poll(0, 10 * MIN - 10_000, 10 * MIN), null);
});

test("what happened before the last input was seen live, and is dropped", () => {
  const record = recorded(1 * MIN);
  // The user was at the keyboard until 4 min.
  assert.equal(record.poll(1 * MIN, 5 * MIN, 10 * MIN), null);
  assert.deepEqual(record.events, []);
  // Nothing recorded: no stretch is being followed, so coming back tells nothing.
  assert.equal(record.poll(0, 40 * MIN, 10 * MIN), null);
});

test("a session that finished after the user left is told; one before is not", () => {
  const record = new AwayRecord();
  const a = task("a", "idle", "Early");
  const b = task("b", "idle", "Late");
  record.observe([a, b], 0);
  a.state = "finished";
  record.observe([a, b], 1 * MIN);
  // The user leaves at 2 min; b finishes at 4 min.
  b.state = "error";
  record.observe([a, b], 4 * MIN);
  assert.equal(record.poll(3 * MIN, 5 * MIN, 10 * MIN), null);
  assert.deepEqual(record.events.map((e) => e.id), ["b"]);
  assert.deepEqual(record.poll(0, 20 * MIN, 10 * MIN).events.map((e) => e.id), ["b"]);
});

test("moving the mouse a little inside the same idle stretch is not a return", () => {
  const record = recorded(5 * MIN);
  record.poll(6 * MIN, 6 * MIN, 10 * MIN);
  // The reading is in whole seconds and takes a moment: same stretch.
  assert.equal(record.poll(6 * MIN + 30_000 - (SAME_IDLE_MS - 1_000), 6.5 * MIN, 10 * MIN), null);
  assert.equal(record.events.length, 1);
});

test("the report lists what asks for the user first, then failures, then what finished", () => {
  const record = new AwayRecord();
  const tasks = ["f", "e", "q", "a"].map((id) => task(id));
  record.observe(tasks, 0);
  const states = { f: "finished", e: "error", q: "question", a: "approval" };
  tasks.forEach((t, i) => {
    t.state = states[t.id];
    record.observe(tasks, (i + 1) * MIN);
  });
  record.poll(5 * MIN, 5 * MIN, 5 * MIN);
  const report = record.poll(0, 20 * MIN, 5 * MIN);
  // approval and question (newest first), then the error, then the finished one.
  assert.deepEqual(report.events.map((e) => e.id), ["a", "q", "e", "f"]);
});

test("a system that cannot tell the idle time tells nothing", () => {
  const record = recorded(5 * MIN);
  assert.equal(record.poll(null, 12 * MIN, 10 * MIN), null);
  assert.deepEqual(record.events, []);
  const off = recorded(5 * MIN);
  assert.equal(off.poll(12 * MIN, 12 * MIN, 0), null, "a threshold of 0 is off");
  assert.deepEqual(off.events, []);
});

// ── The timer ─────────────────────────────────────────────────────────────────

let idle;
let asked;
let alerts;
const host = { alert: (view) => alerts.push(view) };
const record = new AwayRecord();
registerAwayHandlers(host, record);

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Lets the timer fire and the answer come back. */
async function wait(ms) {
  mock.timers.tick(ms);
  await flush();
  await flush();
}

/** A session changes state. */
function change(id, state) {
  const t = State.tasks.find((x) => x.id === id);
  t.state = state;
  State.notify();
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  idle = 0;
  asked = 0;
  alerts = [];
  calls.length = 0;
  internals.invoke = async (cmd, args) => {
    if (cmd === "idle_seconds") {
      asked += 1;
      return idle;
    }
    return original(cmd, args);
  };
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.pendingApproval = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [task("a", "idle", "Claude Code"), task("b", "idle", "Codex")];
  State.notify();
  record.clear();
  Away.report = null;
});

afterEach(() => {
  internals.invoke = original;
  mock.timers.reset();
});

test("nothing is asked of Rust while nothing notable happened", async () => {
  change("a", "working");
  change("a", "thinking");
  await wait(10 * POLL_MS);
  assert.equal(asked, 0);
  assert.deepEqual(alerts, []);
});

test("the first notable event starts a slow timer, which stops when the record is empty", async () => {
  change("a", "finished");
  assert.equal(asked, 0, "not asked at once");
  idle = 0; // the user is at the computer: what happened was seen live
  await wait(POLL_MS);
  assert.equal(asked, 1);
  assert.deepEqual(record.events, []);
  await wait(10 * POLL_MS);
  assert.equal(asked, 1, "nothing left to tell: no more timer");
});

test("coming back after the threshold shows the card once, and leaving it clears the report", async () => {
  change("a", "finished");
  change("b", "approval");
  State.approvals.enqueue({ requestId: "r1", pillId: "b", tool: "Bash" });
  idle = 5 * 60; // five minutes without input, reading at +30 s
  await wait(POLL_MS);
  assert.deepEqual(alerts, []);
  assert.equal(record.events.length, 2, "followed until the user is back");
  // 12 more minutes and the user is back.
  idle = 1;
  await wait(12 * MIN);
  assert.deepEqual(alerts, ["away"]);
  assert.equal(Away.report.minutes >= 10, true);
  assert.deepEqual(Away.report.events.map((e) => e.id), ["b", "a"]);
  assert.deepEqual(record.events, []);
  const before = asked;
  await wait(10 * POLL_MS);
  assert.equal(asked, before, "timer stopped after the card");
  // The card is on screen, then left.
  State.mode = "expanded";
  State.view = "away";
  State.notify();
  assert.notEqual(Away.report, null);
  State.view = "overview";
  State.notify();
  assert.equal(Away.report, null, "cleared once seen");
  State.approvals.clear();
});

test("a short absence tells nothing", async () => {
  change("a", "error");
  idle = 3 * 60;
  await wait(POLL_MS);
  idle = 1;
  await wait(2 * MIN);
  assert.deepEqual(alerts, []);
  assert.deepEqual(record.events, []);
});

test("a threshold of 0 turns it off: nothing recorded, nothing asked", async () => {
  State.settings = { ...State.settings, awayMinutes: 0 };
  change("a", "finished");
  assert.deepEqual(record.events, []);
  await wait(10 * POLL_MS);
  assert.equal(asked, 0);
});

test("the threshold is the setting", async () => {
  State.settings = { ...State.settings, awayMinutes: 30 };
  change("a", "finished");
  idle = 12 * 60;
  await wait(POLL_MS);
  idle = 1;
  await wait(14 * MIN);
  assert.deepEqual(alerts, [], "fourteen minutes is under thirty");
});

test("a paused island shows no card", async () => {
  change("a", "finished");
  idle = 12 * 60;
  await wait(POLL_MS);
  State.paused = true;
  idle = 0;
  await wait(MIN);
  assert.deepEqual(alerts, []);
  assert.equal(Away.report, null);
});

test("the card does not come up over the chat", async () => {
  change("a", "finished");
  idle = 12 * 60;
  await wait(POLL_MS);
  State.mode = "expanded";
  State.view = "prompt";
  idle = 0;
  await wait(MIN);
  assert.deepEqual(alerts, []);
});

test("where the system cannot tell the idle time, there is no card", async () => {
  internals.invoke = async (cmd, args) => (cmd === "idle_seconds" ? null : original(cmd, args));
  change("a", "finished");
  await wait(POLL_MS);
  assert.deepEqual(record.events, []);
  await wait(10 * POLL_MS);
  assert.deepEqual(alerts, []);
});

// ── The card ──────────────────────────────────────────────────────────────────

const event = (id, kind, name = id) => ({ id, name, color: "#7c5cff", kind, at: 1 });

let heard;
const actions = {
  setFocus: (id) => {
    heard.push(`focus:${id}`);
    State.focusId = id;
  },
  setView: (view) => {
    heard.push(`view:${view}`);
    State.view = view;
  },
  collapse: () => heard.push("collapse"),
};

function card(events, minutes = 25) {
  heard = [];
  State.mode = "expanded";
  State.view = "away";
  Away.report = { minutes, events };
  const view = buildAway(actions);
  view.sync();
  return view;
}

const lines = (view) => view.el.find(".away-line");

test("the card says how long, and tells one line per session with what happened", () => {
  State.tasks = [task("a", "finished", "Claude Code"), task("b", "error", "Codex"), task("c", "approval", "Gemini")];
  const view = card([event("a", "finished", "Claude Code"), event("b", "error", "Codex"), event("c", "question", "Gemini")]);
  assert.equal(view.el.find(".away-title")[0].textContent, "While you were away");
  assert.equal(view.el.find(".away-range")[0].textContent, "Away for 25m");
  const text = lines(view).map((l) => l.find("SPAN").map((s) => s.textContent).join("|"));
  assert.deepEqual(text, [
    "Claude Code|finished",
    "Codex|stopped on an error",
    "Gemini|asked you a question|back in its terminal",
  ]);
});

test("a request that still waits says so; one handed back to its terminal says that", () => {
  State.tasks = [task("a", "approval", "Claude Code"), task("b", "question", "Codex")];
  State.approvals.clear();
  State.approvals.enqueue({ requestId: "r3", pillId: "a", tool: "Bash" });
  const view = card([event("a", "approval", "Claude Code"), event("b", "question", "Codex")]);
  const status = lines(view).map((l) => l.find(".status")[0]?.textContent);
  assert.deepEqual(status, ["still waiting", "back in its terminal"]);
  // The request is withdrawn while the card is up: the line follows.
  State.approvals.clear();
  view.sync();
  assert.deepEqual(lines(view).map((l) => l.find(".status")[0]?.textContent), ["back in its terminal", "back in its terminal"]);
});

test("more sessions than lines are counted", () => {
  State.tasks = Array.from({ length: 6 }, (_, i) => task(`t${i}`, "finished"));
  const view = card(State.tasks.map((t) => event(t.id, "finished")));
  assert.equal(lines(view).length, MAX_LINES);
  assert.equal(view.el.find(".away-more")[0].textContent, `and ${6 - MAX_LINES} more`);
  const exact = card(State.tasks.slice(0, MAX_LINES).map((t) => event(t.id, "finished")));
  assert.equal(exact.el.find(".away-more").length, 0);
});

test("a line opens its pill, on the overview", () => {
  State.tasks = [task("a", "finished", "Claude Code"), task("b", "finished", "Codex")];
  const view = card([event("a", "finished"), event("b", "finished")]);
  lines(view)[1].fire("click");
  assert.deepEqual(heard, ["focus:b", "view:overview"]);
  assert.equal(State.focusId, "b");
});

test("a pill that is gone cannot be opened", () => {
  State.tasks = [task("a", "finished")];
  const view = card([event("a", "finished"), event("gone", "finished")]);
  const [, second] = lines(view);
  assert.equal(second.classList.contains("gone"), true);
  second.fire("click");
  assert.deepEqual(heard, []);
});

test("OK gives a request that still waits its card back", () => {
  State.tasks = [task("a", "approval")];
  State.approvals.clear();
  State.approvals.enqueue({ requestId: "r4", pillId: "a", tool: "Bash" });
  const view = card([event("a", "approval")]);
  view.el.find("BUTTON").find((b) => b.textContent === "OK").fire("click");
  assert.deepEqual(heard, ["view:approval"]);
  State.approvals.clear();
});

test("OK folds the island", () => {
  State.tasks = [task("a", "finished")];
  const view = card([event("a", "finished")]);
  view.el.find("BUTTON").find((b) => b.textContent === "OK").fire("click");
  assert.deepEqual(heard, ["collapse"]);
});
