// What a capability gives back (src/voice/result.ts): the card's line, what a
// model is told, and what Peika says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SPOKEN, done, failed, forModel, notFoundResult, refused, spoken } from "../src/voice/result.ts";

test("a model is told whether it was checked, not the card's hope", () => {
  assert.deepEqual(forModel(done("Spotify opened")), { status: "done", verified: true, result: "Spotify opened" });
  assert.deepEqual(forModel(done("Asked Windows to open Spotify", false)), { status: "done", verified: false, result: "Asked Windows to open Spotify" });
  assert.deepEqual(forModel(failed("Spotify did not open", "no window appeared in 2 s")), { status: "failed", result: "no window appeared in 2 s" });
  assert.deepEqual(forModel(notFoundResult("Not found: spy flight", ["Spotify", "Steam"])), {
    status: "not_found", result: "Not found: spy flight", did_you_mean: ["Spotify", "Steam"],
  });
  assert.deepEqual(forModel(done("2 accounts", true, ["a@example.com", "b@example.com"])).data, ["a@example.com", "b@example.com"]);
  // What was refused is told with its rule, not with the card's line.
  assert.deepEqual(forModel(refused("I can't do that", "There is no capability named \"approve\".")), {
    status: "refused", result: "There is no capability named \"approve\".",
  });
});

test("Peika says the model's words when it has some, in a sentence or two", () => {
  assert.equal(spoken("  Spotify is\nopen now.  ", "Spotify opened"), "Spotify is open now.");
  assert.equal(spoken("", "Spotify opened"), "Spotify opened");
  assert.equal(spoken(null, "Spotify opened"), "Spotify opened");
  const long = spoken("word ".repeat(200), "x");
  assert.equal(long.length, MAX_SPOKEN);
  assert.ok(long.endsWith("…"));
});
