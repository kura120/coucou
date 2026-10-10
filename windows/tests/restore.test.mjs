// Where the island was (src/island/restore.ts) and what it opens on again
// (State.resumeView).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { interruptedAfter, isCard, isPlace } from "../src/island/restore.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

beforeEach(() => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.pendingApproval = null;
  State.lastPlace = "overview";
  State.loadIntegrationTasks();
});

test("places are the views one stays in, cards the ones that come and go", () => {
  for (const view of ["overview", "empty", "prompt", "settings"]) assert.ok(isPlace(view), view);
  for (const view of ["approval", "question", "finished", "error"]) assert.ok(isCard(view), view);
  for (const view of ["wardrobe", "note", "confused", "upload", "greeting", "recap"]) {
    assert.ok(!isPlace(view) && !isCard(view), view);
  }
});

test("the island opens again where it was left", () => {
  assert.equal(State.resumeView(), "overview");
  State.lastPlace = "prompt";
  assert.equal(State.resumeView(), "prompt");
  State.lastPlace = "settings";
  assert.equal(State.resumeView(), "settings");
  // Home is whatever home is now: no pill left, the empty view.
  State.lastPlace = "overview";
  State.tasks = [];
  assert.equal(State.resumeView(), "empty");
  State.lastPlace = "empty";
  State.loadIntegrationTasks();
  assert.equal(State.resumeView(), "overview");
});

test("a waiting card comes before the place that was left", () => {
  State.lastPlace = "prompt";
  State.pendingApproval = { requestId: "r1", sessionId: "s", pillId: "integration_claude", tool: "Bash", command: "ls" };
  assert.equal(State.resumeView(), "approval");
  State.pendingApproval = { ...State.pendingApproval, questions: [] };
  assert.equal(State.resumeView(), "question");
  State.pendingApproval = null;
  assert.equal(State.resumeView(), "prompt");
});

test("a card over an open island interrupted what was there", () => {
  assert.equal(interruptedAfter(false, "finished", "prompt", true), true);
  assert.equal(interruptedAfter(false, "approval", "overview", true), true);
  // Over a view that is not a place too: the place before it comes back.
  assert.equal(interruptedAfter(false, "approval", "wardrobe", true), true);
});

test("a card that opens a closed island interrupted nothing", () => {
  assert.equal(interruptedAfter(false, "finished", "overview", false), false);
  assert.equal(interruptedAfter(false, "approval", "prompt", false), false);
  // Whatever an earlier card left behind.
  assert.equal(interruptedAfter(true, "error", "finished", false), false);
});

test("a card over a card keeps what the first one took", () => {
  assert.equal(interruptedAfter(true, "approval", "finished", true), true);
  assert.equal(interruptedAfter(false, "approval", "finished", true), false);
});

test("a folded card opened again is still the card that interrupted", () => {
  assert.equal(interruptedAfter(true, "approval", "approval", false), true);
  assert.equal(interruptedAfter(false, "approval", "approval", false), false);
});

test("any other view ends the interruption", () => {
  for (const view of ["prompt", "overview", "settings", "wardrobe", "note"]) {
    assert.equal(interruptedAfter(true, view, "approval", true), false, view);
  }
});
