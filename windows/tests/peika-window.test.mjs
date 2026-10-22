// The Peika window's band of mini Peikas (src/settings/band.ts): the walk of
// each cloud, which is the only part that is pure. Its loop is a
// requestAnimationFrame one that runs only while the window is seen; that is
// tried in the running app, not here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PILL_CATALOG } from "../src/core/pills.ts";
import { REST_AT_EDGE, makeWalker, stepWalker, stride } from "../src/settings/band.ts";

const SPAN = 300;

test("the three clouds start apart, inside the band, heading their own ways", () => {
  const walkers = [0, 1, 2].map((i) => makeWalker(i, SPAN));
  assert.equal(new Set(walkers.map((w) => w.x)).size, 3);
  for (const w of walkers) assert.ok(w.x >= 0 && w.x <= SPAN);
  assert.deepEqual(walkers.map((w) => w.dir), [1, -1, 1]);
  assert.ok(walkers.every((w) => w.speed > 0 && w.speed < 40), "slow");
});

test("a cloud walks along its direction at its pace", () => {
  const w = { x: 100, dir: 1, speed: 20, rest: 0, phase: 0 };
  const next = stepWalker(w, 0.5, SPAN);
  assert.equal(next.x, 110);
  assert.equal(next.dir, 1);
  assert.ok(next.phase > w.phase);
  assert.equal(stepWalker({ ...w, dir: -1 }, 0.5, SPAN).x, 90);
});

test("at the end of the band it stops, rests, then turns back", () => {
  let w = { x: 295, dir: 1, speed: 20, rest: 0, phase: 0 };
  w = stepWalker(w, 1, SPAN);
  assert.equal(w.x, SPAN);
  assert.equal(w.dir, -1);
  assert.equal(w.rest, REST_AT_EDGE);
  // Standing: it does not move, and the rest runs down.
  const still = stepWalker(w, 0.5, SPAN);
  assert.equal(still.x, SPAN);
  assert.equal(still.rest, REST_AT_EDGE - 0.5);
  // Rested: it walks the other way.
  const gone = stepWalker({ ...w, rest: 0 }, 1, SPAN);
  assert.equal(gone.x, SPAN - 20);

  const left = stepWalker({ x: 3, dir: -1, speed: 20, rest: 0, phase: 0 }, 1, SPAN);
  assert.equal(left.x, 0);
  assert.equal(left.dir, 1);
});

test("a band that shrinks keeps the clouds inside it, and a null width keeps them at 0", () => {
  assert.equal(stepWalker({ x: 280, dir: 1, speed: 20, rest: 0, phase: 0 }, 0, 100).x, 100);
  const flat = stepWalker({ x: 50, dir: 1, speed: 20, rest: 0, phase: 0 }, 1, 0);
  assert.equal(flat.x, 0);
});

test("the hop only happens mid-step, and stays small", () => {
  assert.deepEqual(stride({ x: 0, dir: 1, speed: 1, rest: 1, phase: 1 }), { dy: 0, lean: 0 });
  for (let p = 0; p < 7; p += 0.3) {
    const { dy, lean } = stride({ x: 0, dir: 1, speed: 1, rest: 0, phase: p });
    assert.ok(dy <= 0 && dy >= -3);
    assert.ok(Math.abs(lean) < 0.1);
  }
});

test("the clouds wear the colours of pills the catalog has", () => {
  for (const id of ["agent_claude-desktop", "agent_gemini", "agent_codex"]) {
    assert.ok(PILL_CATALOG.some((p) => p.id === id), id);
  }
});
