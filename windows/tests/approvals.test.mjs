// The queue of waiting permission requests (src/core/approvals.ts), as
// ApprovalQueueTests.swift tests the Mac's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue, MAX_PENDING, WAIT_MS, inputKey } from "../src/core/approvals.ts";

const entry = (requestId, extra = {}) => ({
  requestId,
  sessionId: "s1",
  pillId: "integration_claude",
  tool: "Bash",
  inputKey: inputKey({ command: "ls" }),
  received: 0,
  ...extra,
});

const ids = (list) => list.map((e) => e.requestId);

test("the oldest request is the head, and the others wait in order", () => {
  const q = new ApprovalQueue();
  assert.equal(q.head, null);
  assert.equal(q.enqueue(entry("a")), true);
  assert.equal(q.enqueue(entry("b")), true);
  assert.equal(q.enqueue(entry("c")), true);
  assert.equal(q.head.requestId, "a");
  assert.equal(q.count, 3);
  assert.deepEqual(ids(q.all), ["a", "b", "c"]);
});

test("removing one leaves the others in their order", () => {
  const q = new ApprovalQueue();
  for (const id of ["a", "b", "c"]) q.enqueue(entry(id));
  assert.equal(q.remove("b").requestId, "b");
  assert.deepEqual(ids(q.all), ["a", "c"]);
  assert.equal(q.remove("b"), null);
  q.remove("a");
  assert.equal(q.head.requestId, "c");
});

test("past the bound the newest is refused, and the queue is unchanged", () => {
  const q = new ApprovalQueue();
  assert.equal(MAX_PENDING, 5);
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(q.enqueue(entry(`r${i}`)), true);
  assert.equal(q.enqueue(entry("late")), false);
  assert.equal(q.count, MAX_PENDING);
  assert.equal(q.has("late"), false);
  q.remove("r0");
  assert.equal(q.enqueue(entry("late")), true);
});

test("a turn that ends settles only its own session's requests", () => {
  const q = new ApprovalQueue();
  q.enqueue(entry("a"));
  q.enqueue(entry("b", { sessionId: "s2" }));
  q.enqueue(entry("c", { pillId: "agent_codex" }));
  q.enqueue(entry("d"));
  for (const end of ["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]) {
    assert.deepEqual(ids(q.resolvedBy(end, "s1", "integration_claude", "", "")), ["a", "d"], end);
  }
  assert.deepEqual(ids(q.resolvedBy("PreToolUse", "s1", "integration_claude", "Bash", q.head.inputKey)), []);
});

test("a tool's result settles the request for that very call, not its siblings", () => {
  const q = new ApprovalQueue();
  q.enqueue(entry("ls"));
  q.enqueue(entry("rm", { inputKey: inputKey({ command: "rm x" }) }));
  q.enqueue(entry("write", { tool: "Write", inputKey: inputKey({ command: "ls" }) }));
  const key = inputKey({ command: "ls" });
  assert.deepEqual(ids(q.resolvedBy("PostToolUse", "s1", "integration_claude", "Bash", key)), ["ls"]);
  assert.deepEqual(ids(q.resolvedBy("PostToolUseFailure", "s1", "integration_claude", "Bash", key)), ["ls"]);
  assert.deepEqual(ids(q.resolvedBy("PostToolUse", "s2", "integration_claude", "Bash", key)), []);
});

test("a question's result settles it whatever its input came back as", () => {
  const q = new ApprovalQueue();
  q.enqueue(entry("q", { tool: "AskUserQuestion", inputKey: inputKey({ questions: [] }) }));
  const answered = inputKey({ questions: [], answers: { Which: "A" } });
  assert.deepEqual(ids(q.resolvedBy("PostToolUse", "s1", "integration_claude", "AskUserQuestion", answered)), ["q"]);
});

test("the input key does not depend on the order of the keys", () => {
  assert.equal(inputKey({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 2 } }), inputKey({ a: { c: 2, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.equal(inputKey(undefined), "");
  assert.equal(inputKey({}), "{}");
});

test("each request runs out on its own clock", () => {
  const q = new ApprovalQueue();
  assert.equal(q.nextDeadline(), null);
  q.enqueue(entry("a", { received: 1000 }));
  q.enqueue(entry("b", { received: 5000 }));
  assert.equal(q.nextDeadline(), 1000 + WAIT_MS);
  assert.deepEqual(ids(q.expired(1000 + WAIT_MS - 1)), []);
  assert.deepEqual(ids(q.expired(1000 + WAIT_MS)), ["a"]);
  q.remove("a");
  assert.equal(q.nextDeadline(), 5000 + WAIT_MS);
  assert.deepEqual(ids(q.expired(5000 + WAIT_MS)), ["b"]);
});
