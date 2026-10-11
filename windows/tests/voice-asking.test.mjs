// A question on screen (src/voice/asking.ts): what a sentence, a key or a
// click answers, and what a model's ask_user call may put up (src/voice/tools.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { answerLine, keyAnswer, keysFor, optionSaid, readSaid, usable } from "../src/voice/asking.ts";
import { askOf } from "../src/voice/tools.ts";
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
const choice = (id) => ({ is: "answer", answer: { kind: "choice", id } });

test("a choice is answered by its name, its place or its number", () => {
  for (const [said, id] of [
    ["Work", "work"], ["work.", "work"], ["the work one", "work"], ["home", "home"], ["old address", "old"],
    ["the first one", "work"], ["second", "home"], ["the last one", "old"], ["number two", "home"], ["option one", "work"],
    ["one", "work"], ["3", "old"], ["I'll take the second one", "home"], ["the old one", "old"],
  ]) {
    assert.deepEqual(readSaid(ACCOUNTS, said), choice(id), said);
  }
  // Not one of them, or not one alone: the question stays.
  for (const said of ["the fourth one", "example", "kura", "what do you mean", "", "open spotify"]) {
    assert.deepEqual(readSaid(ACCOUNTS, said), { is: "unclear" }, said);
  }
  assert.equal(optionSaid("two", [{ id: "a", label: "Two" }, { id: "b", label: "One" }])?.id, "a", "a label wins over a number");
});

test("yes or no, in the words people use, and in the buttons' own", () => {
  for (const said of ["yes", "Yeah.", "sure", "do it", "go ahead", "okay"]) {
    assert.deepEqual(readSaid(YES_NO, said), { is: "answer", answer: { kind: "yes_no", yes: true } }, said);
  }
  for (const said of ["no", "Nope.", "nah", "don't"]) {
    assert.deepEqual(readSaid(YES_NO, said), { is: "answer", answer: { kind: "yes_no", yes: false } }, said);
  }
  const named = { kind: "yes_no", question: "Send it now?", yes: "Send", no: "Keep editing" };
  assert.deepEqual(readSaid(named, "send"), { is: "answer", answer: { kind: "yes_no", yes: true } });
  assert.deepEqual(readSaid(named, "keep editing"), { is: "answer", answer: { kind: "yes_no", yes: false } });
  assert.deepEqual(readSaid(YES_NO, "maybe later on"), { is: "unclear" });
});

test("a text field is dictated into, and confirmed by a word said alone, never by being said", () => {
  assert.deepEqual(readSaid(TEXT, "I will be ten minutes late"), { is: "draft", value: "I will be ten minutes late" });
  assert.deepEqual(readSaid(TEXT, "see you there", "I will be ten minutes late."), { is: "draft", value: "I will be ten minutes late. see you there" });
  // "confirm" alone confirms what is written; inside a sentence it is a word of it.
  assert.deepEqual(readSaid(TEXT, "Confirm.", "I will be late"), { is: "answer", answer: { kind: "text", value: "I will be late" } });
  assert.deepEqual(readSaid(TEXT, "please confirm the meeting"), { is: "draft", value: "please confirm the meeting" });
  // Nothing written: nothing to confirm.
  assert.deepEqual(readSaid(TEXT, "confirm", "  "), { is: "unclear" });
  assert.deepEqual(readSaid(TEXT, "start over", "I will be late"), { is: "draft", value: "" });
});

test("never mind drops any question", () => {
  for (const ask of [ACCOUNTS, YES_NO, TEXT]) {
    assert.deepEqual(readSaid(ask, "never mind"), { is: "answer", answer: { kind: "dropped" } });
    assert.deepEqual(readSaid(ask, "Cancel."), { is: "answer", answer: { kind: "dropped" } });
  }
});

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
  assert.equal(answerLine(ACCOUNTS, { kind: "choice", id: "home" }), "Home");
  assert.equal(answerLine(YES_NO, { kind: "yes_no", yes: false }), "no");
  assert.equal(answerLine(TEXT, { kind: "dropped" }), "");
});

test("what a model may ask: a list when it gives options, else yes or no, or words", () => {
  assert.deepEqual(askOf({ question: "Which account?", options: ["Work", "Home"] }), {
    kind: "choice", question: "Which account?", options: [{ id: "1", label: "Work" }, { id: "2", label: "Home" }],
  });
  assert.deepEqual(askOf({ question: "Recent ones only?", kind: "yes_no" }), { kind: "yes_no", question: "Recent ones only?" });
  assert.deepEqual(askOf({ question: "Which person or topic?" }), { kind: "text", question: "Which person or topic?" });
  // One option is no choice; no question is no question.
  assert.equal(askOf({ question: "Which?", options: ["Work"], kind: "choice" })?.kind, "text");
  assert.equal(askOf({ options: ["a", "b"] }), null);
  assert.equal(askOf({ question: 12 }), null);
});
