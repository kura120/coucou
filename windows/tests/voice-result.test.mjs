// What a tool gives back (src/voice/result.ts): the card's line, what a model
// is told, and what Mochi says.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SPOKEN, asVoiceResult, asks, confirms, done, failed, forModel, fromVoiceResult, notFoundResult, refused, spoken,
} from "../src/voice/result.ts";

test("a result ends the turn as the card shows it", () => {
  assert.deepEqual(asVoiceResult(done("Spotify opened")), { outcome: "success", message: "Spotify opened" });
  assert.deepEqual(asVoiceResult(failed("Spotify did not open", "no window appeared")), { outcome: "failure", message: "Spotify did not open" });
  assert.equal(asVoiceResult(notFoundResult("Not found: spy flight", ["Spotify"])).outcome, "failure");
  assert.equal(asVoiceResult(refused("That takes a click", "voice never approves")).outcome, "failure");
  assert.deepEqual(asVoiceResult(asks({ kind: "yes_no", question: "Open Spotify?" })), { outcome: "question", message: "Open Spotify?" });
  assert.equal(asVoiceResult(confirms({ title: "Change the language to Hindi?", change: "English → Hindi", action: "Change" })).outcome, "question");
});

test("a model is told whether it was checked, not the card's hope", () => {
  assert.deepEqual(forModel(done("Spotify opened")), { status: "done", verified: true, result: "Spotify opened" });
  assert.deepEqual(forModel(done("Asked Windows to open Spotify", false)), { status: "done", verified: false, result: "Asked Windows to open Spotify" });
  assert.deepEqual(forModel(failed("Spotify did not open", "no window appeared in 2 s")), { status: "failed", result: "no window appeared in 2 s" });
  assert.deepEqual(forModel(notFoundResult("Not found: spy flight", ["Spotify", "Steam"])), {
    status: "not_found", result: "Not found: spy flight", did_you_mean: ["Spotify", "Steam"],
  });
  assert.deepEqual(forModel(done("2 accounts", true, ["a@example.com", "b@example.com"])).data, ["a@example.com", "b@example.com"]);
  assert.equal(forModel(asks({ kind: "choice", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })).waiting_for, "the user's answer");
  assert.equal(forModel(confirms({ title: "t", change: "c", action: "a" })).waiting_for, "the user's click");
});

test("the old kind of result is a done or a failed step, unverified unless said", () => {
  assert.deepEqual(fromVoiceResult({ outcome: "success", message: "Paused" }), done("Paused", false));
  assert.deepEqual(fromVoiceResult({ outcome: "success", message: "Paused" }, true), done("Paused"));
  assert.equal(fromVoiceResult({ outcome: "failure", message: "No music app running" }).status, "failed");
  assert.equal(fromVoiceResult({ outcome: "question", message: "Remove which?" }).status, "ask");
});

test("Mochi says the model's words when it has some, in a sentence or two", () => {
  assert.equal(spoken("  Spotify is\nopen now.  ", "Spotify opened"), "Spotify is open now.");
  assert.equal(spoken("", "Spotify opened"), "Spotify opened");
  assert.equal(spoken(null, "Spotify opened"), "Spotify opened");
  const long = spoken("word ".repeat(200), "x");
  assert.equal(long.length, MAX_SPOKEN);
  assert.ok(long.endsWith("…"));
});
