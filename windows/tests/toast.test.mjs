// Toasts (src/toast/stack.ts): the queue, the timings — life, pause on hover,
// expiry, the slide out — and decisions, on a clock of the test's own. Plus the
// hard rule that a toast can never approve a permission or send an email.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DURATION_MS, LEAVE_MS, MAX_VISIBLE, MIN_DURATION_MS, ToastStack, lifetime, normalize,
} from "../src/toast/stack.ts";

/** A stack and the answers it gave, in order. */
function make() {
  const answers = [];
  const stack = new ToastStack((id, answer) => answers.push([id, answer]));
  return { stack, answers };
}

const info = (id, extra = {}) => ({ id, kind: "info", title: `Toast ${id}`, ...extra });
const decision = (id, extra = {}) => ({ id, kind: "warning", title: `Question ${id}`, actions: {}, ...extra });
const ids = (stack) => stack.onScreen().map((e) => `${e.spec.id}:${e.phase}`);

// ── Lifetimes ─────────────────────────────────────────────────────────────────

test("each kind has its default life; a decision waits for its answer", () => {
  assert.equal(lifetime(info("a")), DEFAULT_DURATION_MS.info);
  assert.equal(lifetime({ ...info("a"), kind: "error" }), DEFAULT_DURATION_MS.error);
  assert.ok(DEFAULT_DURATION_MS.warning > DEFAULT_DURATION_MS.info, "a warning stays longer than a note");
  assert.equal(lifetime(decision("q")), Infinity);
  assert.equal(lifetime(decision("q", { durationMs: 20000 })), 20000, "unless its caller gives it a time");
  assert.equal(lifetime(info("a", { durationMs: 50 })), MIN_DURATION_MS, "never too short to read");
});

test("a description from elsewhere is checked before it is shown", () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize({ id: "a" }), null, "no title");
  assert.equal(normalize({ title: "Hi" }), null, "no id");
  const t = normalize({ id: "a", title: "Hi", kind: "shout", durationMs: "soon", actions: { yes: "Send", no: 3 } });
  assert.equal(t.kind, "info", "an unknown kind is a note");
  assert.equal(t.durationMs, null);
  assert.deepEqual(t.actions, { yes: "Send" });
  assert.equal(normalize({ id: "a", title: "Hi" }).actions, null, "no actions: no buttons");
});

// ── Queue ─────────────────────────────────────────────────────────────────────

test("newest on top; past the room on screen, toasts wait their turn in order", () => {
  const { stack } = make();
  for (const id of ["a", "b", "c", "d", "e"]) stack.push(info(id), 0);
  assert.equal(MAX_VISIBLE, 3);
  assert.deepEqual(ids(stack), ["c:shown", "b:shown", "a:shown"]);
  assert.equal(stack.queued(), 2);

  // a runs out first; once it has slid away, d (the oldest waiting) comes in.
  stack.tick(DEFAULT_DURATION_MS.info);
  assert.deepEqual(ids(stack), ["c:leaving", "b:leaving", "a:leaving"]);
  stack.tick(DEFAULT_DURATION_MS.info + LEAVE_MS);
  assert.deepEqual(ids(stack), ["e:shown", "d:shown"]);
  assert.equal(stack.queued(), 0);
});

test("a waiting toast's life doesn't run until it is on screen", () => {
  const { stack } = make();
  for (const id of ["a", "b", "c", "d"]) stack.push(info(id), 0);
  stack.answer("c", "dismissed", 4000); // room for d, 4 s in
  stack.tick(4000 + LEAVE_MS);
  assert.ok(ids(stack).includes("d:shown"));
  assert.equal(stack.remaining("d", 4000 + LEAVE_MS), DEFAULT_DURATION_MS.info, "its full life ahead");
});

test("the same id replaces a toast in place and starts its life over", () => {
  const { stack, answers } = make();
  stack.push(info("a", { text: "one" }), 0);
  stack.push(info("b"), 0);
  stack.push(info("a", { text: "two" }), 3000);
  assert.deepEqual(ids(stack), ["b:shown", "a:shown"], "same place, no second copy");
  assert.equal(stack.onScreen()[1].spec.text, "two");
  stack.tick(DEFAULT_DURATION_MS.info + 1);
  assert.deepEqual(ids(stack), ["b:leaving", "a:shown"], "a got its full life again");
  assert.deepEqual(answers, [["b", "dismissed"]]);
});

test("pushing again while it slides out brings it back as a new toast", () => {
  const { stack } = make();
  stack.push(info("a"), 0);
  stack.answer("a", "dismissed", 100);
  stack.push(info("a"), 150);
  assert.deepEqual(ids(stack), ["a:shown"]);
});

// ── Timings ───────────────────────────────────────────────────────────────────

test("a toast leaves when its life is over, and is gone once it has slid out", () => {
  const { stack, answers } = make();
  stack.push(info("a"), 1000);
  assert.equal(stack.nextWake(1000), DEFAULT_DURATION_MS.info);
  stack.tick(1000 + DEFAULT_DURATION_MS.info - 1);
  assert.deepEqual(ids(stack), ["a:shown"]);
  const end = 1000 + DEFAULT_DURATION_MS.info;
  stack.tick(end);
  assert.deepEqual(ids(stack), ["a:leaving"]);
  assert.deepEqual(answers, [["a", "dismissed"]], "answered as it starts leaving, once");
  assert.equal(stack.nextWake(end), LEAVE_MS);
  stack.tick(end + LEAVE_MS);
  assert.ok(stack.isEmpty());
  assert.equal(stack.nextWake(end + LEAVE_MS), null, "nothing left to wake up for");
  assert.equal(answers.length, 1);
});

test("the pointer on the stack stops every clock, and they carry on where they were", () => {
  const { stack } = make();
  stack.push(info("a"), 0);
  stack.hover(true, 2000);
  assert.equal(stack.nextWake(2000), null, "nothing runs out under the pointer");
  stack.tick(60_000);
  assert.deepEqual(ids(stack), ["a:shown"]);
  assert.equal(stack.remaining("a", 60_000), DEFAULT_DURATION_MS.info - 2000);
  // A toast that arrives while the pointer is there waits too.
  stack.push(info("b"), 60_000);
  assert.equal(stack.remaining("b", 70_000), DEFAULT_DURATION_MS.info);
  stack.hover(false, 70_000);
  stack.tick(70_000 + DEFAULT_DURATION_MS.info - 2000);
  assert.deepEqual(ids(stack), ["b:shown", "a:leaving"]);
  stack.tick(70_000 + DEFAULT_DURATION_MS.info);
  assert.deepEqual(ids(stack), ["b:leaving"], "a has slid out by then");
});

test("closing a note settles it as dismissed; a second close changes nothing", () => {
  const { stack, answers } = make();
  stack.push(info("a"), 0);
  assert.equal(stack.answer("a", "yes", 10), true);
  assert.equal(stack.answer("a", "no", 20), false);
  assert.deepEqual(answers, [["a", "dismissed"]], "a note has no yes or no");
});

// ── Decisions ─────────────────────────────────────────────────────────────────

test("a decision stays until it is answered, and the answer goes back once", () => {
  const { stack, answers } = make();
  stack.push(decision("q"), 0);
  assert.equal(stack.decisionOnScreen(), true);
  stack.tick(3_600_000);
  assert.deepEqual(ids(stack), ["q:shown"], "an hour later, still asking");
  stack.answer("q", "no", 3_600_000);
  assert.deepEqual(answers, [["q", "no"]]);
  assert.equal(stack.decisionOnScreen(), false, "the keys are let go as it leaves");
});

test("a decision with a time limit ends dismissed when it runs out", () => {
  const { stack, answers } = make();
  stack.push(decision("q", { durationMs: 10_000 }), 0);
  stack.tick(10_000);
  assert.deepEqual(answers, [["q", "dismissed"]]);
});

test("a shortcut answers the decision nearest the top, never a note", () => {
  const { stack, answers } = make();
  stack.push(decision("first"), 0);
  stack.push(decision("second"), 10);
  stack.push(info("note"), 20);
  assert.equal(stack.key("yes", 30), "second");
  assert.equal(stack.key("no", 40), "first");
  assert.equal(stack.key("yes", 50), null, "no decision left: the key does nothing");
  assert.deepEqual(answers, [["second", "yes"], ["first", "no"]]);
  assert.deepEqual(ids(stack), ["note:shown", "second:leaving", "first:leaving"]);
});

test("a decision waiting in the queue holds no keys and can be taken back unseen", () => {
  const { stack, answers } = make();
  for (const id of ["a", "b", "c"]) stack.push(info(id), 0);
  stack.push(decision("q"), 0);
  assert.equal(stack.decisionOnScreen(), false, "not on screen yet");
  assert.equal(stack.key("yes", 10), null);
  stack.answer("q", "dismissed", 20);
  assert.deepEqual(answers, [["q", "dismissed"]]);
  assert.equal(stack.queued(), 0);
});

test("a decision replaced by a note is settled as dismissed", () => {
  const { stack, answers } = make();
  stack.push(decision("q"), 0);
  stack.push(info("q", { title: "Never mind" }), 100);
  assert.deepEqual(answers, [["q", "dismissed"]]);
  assert.equal(stack.decisionOnScreen(), false);
});

// ── The hard rule ─────────────────────────────────────────────────────────────

test("nothing in the toasts can approve a permission or send an email", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../src/toast");
  const sources = [
    ...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8")),
    readFileSync(join(here, "../src-tauri/src/toast.rs"), "utf8"),
  ];
  // The commands and modules that answer a permission or send mail.
  const forbidden = /approval_decision|approval_answer|approvalDecision|approvalAnswer|crate::pipe|resend|send_email|sendEmail/i;
  for (const source of sources) {
    const code = source.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, forbidden);
  }
});
