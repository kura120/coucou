// A question on screen (src/voice/asking.ts): the keys it holds, what a key
// answers, and what may be shown. What a sentence said answers is read by the
// local model (tests/voice-turn.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { keyAnswer, keysFor, usable } from "../src/voice/asking.ts";
import { askRoom } from "../src/views/ask.ts";

const ACCOUNTS = {
  kind: "choice",
  question: "Which email account do you want to use?",
  options: [
    { id: "work", label: "Work", hint: "kura@work.example" },
    { id: "home", label: "Home", hint: "kura@home.example" },
    { id: "old", label: "Old address" },
  ],
};
const YES_NO = { kind: "yes_no", question: "Open Spotify?" };
const TEXT = { kind: "text", question: "What should the email say?" };
test("the keys: a number for a choice, 1 and 2 for yes and no, Enter for the field", () => {
  assert.deepEqual(keysFor(ACCOUNTS), { numbers: 3, enter: false });
  assert.deepEqual(keysFor(YES_NO), { numbers: 2, enter: false });
  assert.deepEqual(keysFor(TEXT), { numbers: 0, enter: true });
  assert.deepEqual(keysFor(null), { numbers: 0, enter: false });
  assert.deepEqual(keyAnswer(ACCOUNTS, "2"), { kind: "choice", id: "home" });
  assert.equal(keyAnswer(ACCOUNTS, "4"), null);
  assert.equal(keyAnswer(ACCOUNTS, "enter"), null);
  assert.deepEqual(keyAnswer(YES_NO, "1"), { kind: "yes_no", yes: true });
  assert.deepEqual(keyAnswer(YES_NO, "2"), { kind: "yes_no", yes: false });
  assert.equal(keyAnswer(YES_NO, "3"), null);
  assert.deepEqual(keyAnswer(TEXT, "enter", " hello "), { kind: "text", value: "hello" });
  assert.equal(keyAnswer(TEXT, "enter", ""), null);
  assert.equal(keyAnswer(TEXT, "1", "hello"), null);
});

test("a question is shown only when it is one: trimmed, two to nine choices", () => {
  assert.equal(usable({ kind: "text", question: "   " }), null);
  assert.equal(usable({ kind: "choice", question: "Which?", options: [{ id: "a", label: "Only one" }] }), null);
  const many = usable({ kind: "choice", question: " Which\n one? ", options: Array.from({ length: 14 }, (_, i) => ({ id: String(i), label: `Option ${i}` })) });
  assert.equal(many.question, "Which one?");
  assert.equal(many.options.length, 9);
  assert.equal(usable({ kind: "choice", question: "Which?", options: [{ id: "a", label: "A" }, { id: "", label: "x" }, { id: "c", label: " " }, { id: "d", label: "D" }] }).options.length, 2);
  // The island makes room for what is shown.
  assert.ok(askRoom(ACCOUNTS) > askRoom(YES_NO));
  assert.equal(askRoom(null), 0);
});
