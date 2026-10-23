// The sessions behind each pill (src/core/sessions.ts), as the Mac's
// PillSessionRegistry holds them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SILENCE_MS, PillSessions } from "../src/core/sessions.ts";

const PILL = "integration_claude";
const A = { cwd: "C:\\dev\\alpha", project: "alpha" };
const B = { cwd: "C:\\dev\\beta", project: "beta" };

test("the silence limit is the Mac's twelve hours", () => {
  assert.equal(MAX_SILENCE_MS, 12 * 3600 * 1000);
});

test("two sessions on one pill: the last heard is the one shown", () => {
  const s = new PillSessions();
  s.heard(PILL, "a", 0, A);
  s.heard(PILL, "b", 0, B);
  assert.equal(s.count(PILL), 2);
  assert.deepEqual(s.latest(PILL), { session: "b", cwd: B.cwd, project: "beta" });
  // Same millisecond or not, hearing a again brings it back in front.
  s.heard(PILL, "a", 0);
  assert.deepEqual(s.latest(PILL), { session: "a", cwd: A.cwd, project: "alpha" });
});

test("an event without a folder keeps the folder already known", () => {
  const s = new PillSessions();
  s.heard(PILL, "a", 0, A);
  s.heard(PILL, "a", 5, {});
  s.heard(PILL, "a", 9, { cwd: "", project: "Session" });
  assert.deepEqual(s.latest(PILL), { session: "a", cwd: A.cwd, project: "alpha" });
});

test("one session ending leaves the pill with the other; the last one empties it", () => {
  const s = new PillSessions();
  s.heard(PILL, "a", 0, A);
  s.heard(PILL, "b", 1, B);
  assert.equal(s.ended(PILL, "b"), false);
  assert.equal(s.latest(PILL).session, "a");
  assert.equal(s.ended(PILL, "a"), true);
  assert.equal(s.count(PILL), 0);
  assert.equal(s.latest(PILL), null);
  assert.equal(s.active, false);
});

test("a session nobody heard ends nothing for the others, and everything for an empty pill", () => {
  const s = new PillSessions();
  assert.equal(s.ended(PILL, "ghost"), true);
  s.heard(PILL, "a", 0, A);
  assert.equal(s.ended(PILL, "ghost"), false);
  assert.equal(s.has(PILL, "a"), true);
});

test("pills keep their sessions apart", () => {
  const s = new PillSessions();
  s.heard(PILL, "a", 0, A);
  s.heard("agent_codex", "c", 0);
  assert.equal(s.ended("agent_codex", "c"), true);
  assert.equal(s.count(PILL), 1);
});

test("a silent session goes stale after twelve hours, not before", () => {
  const s = new PillSessions();
  s.heard(PILL, "a", 0, A);
  s.heard(PILL, "b", 1000, B);
  assert.deepEqual(s.stale(MAX_SILENCE_MS - 1), { emptied: [], touched: [] });
  assert.deepEqual(s.stale(MAX_SILENCE_MS), { emptied: [], touched: [PILL] });
  assert.equal(s.has(PILL, "a"), false);
  assert.equal(s.latest(PILL).session, "b");
  assert.deepEqual(s.stale(MAX_SILENCE_MS + 1000), { emptied: [PILL], touched: [] });
  assert.equal(s.active, false);
});

test("hearing a session again pushes its deadline back", () => {
  const s = new PillSessions();
  s.heard(PILL, "a", 0, A);
  assert.equal(s.nextDeadline(), MAX_SILENCE_MS);
  s.heard(PILL, "a", 3600_000);
  assert.equal(s.nextDeadline(), 3600_000 + MAX_SILENCE_MS);
  assert.deepEqual(s.stale(MAX_SILENCE_MS), { emptied: [], touched: [] });
});

test("nothing to watch while no pill has a session", () => {
  const s = new PillSessions();
  assert.equal(s.active, false);
  assert.equal(s.nextDeadline(), null);
  s.heard(PILL, "a", 0);
  assert.equal(s.active, true);
  s.clear();
  assert.equal(s.nextDeadline(), null);
});
