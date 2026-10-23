// Which frames of the island's loop are drawn (src/island/frames.ts): every
// frame while anything moves quickly, about 30 per second while only a slow loop
// (breathing, z's, sweat) does. And the engine's word on which is which.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_JITTER_MS, SLOW_FPS, SLOW_FRAME_MS, TIMER_LEAD_MS, frameDelay, shouldDraw, slowLoopOnly,
} from "../src/island/frames.ts";
import { BotEngine } from "../src/peika/engine.ts";

const still = {
  geometry: false, bot: false, greeting: false, upload: false,
  view: false, miniBots: false, engine: false, wake: false,
};

/** The frames a loop draws over `seconds`, at a display of `hz`. */
function drawn(motion, hz, seconds = 2) {
  const step = 1000 / hz;
  let last = 0;
  let count = 0;
  for (let t = step; t <= seconds * 1000 + 1e-6; t += step) {
    const m = typeof motion === "function" ? motion(t) : motion;
    if (shouldDraw(m, t - last)) {
      last = t;
      count++;
    }
  }
  return count / seconds;
}

test("a slow loop draws about 30 frames per second on any display (a multiple of the refresh interval, so 25 at 75 Hz)", () => {
  assert.equal(SLOW_FPS, 30);
  for (const hz of [60, 75, 90, 120, 144, 165, 240]) {
    const fps = drawn(still, hz);
    assert.ok(fps >= 24 && fps <= 32, `${hz} Hz drew ${fps} fps`);
  }
  // 60 Hz exactly: every second frame, not every third.
  assert.equal(drawn(still, 60), 30);
});

test("a display slower than 30 Hz draws every frame it has", () => {
  assert.equal(drawn(still, 24), 24);
});

test("anything quick draws every frame", () => {
  for (const key of Object.keys(still)) {
    const m = { ...still, [key]: true };
    assert.equal(slowLoopOnly(m), false, key);
    for (const hz of [60, 144]) assert.equal(drawn(m, hz), hz, `${key} at ${hz} Hz`);
    assert.ok(shouldDraw(m, 0.1), `${key}: even a frame right after the last`);
  }
  assert.equal(slowLoopOnly(still), true);
});

test("a frame a little early still counts, one much too early does not", () => {
  assert.ok(shouldDraw(still, SLOW_FRAME_MS));
  assert.ok(shouldDraw(still, SLOW_FRAME_MS - FRAME_JITTER_MS));
  assert.ok(!shouldDraw(still, SLOW_FRAME_MS - FRAME_JITTER_MS - 0.5));
  assert.ok(!shouldDraw(still, 0));
});

test("when something starts moving, the very next frame is drawn at full rate", () => {
  // Slow for the first second, then a tween starts: from then on all frames.
  const m = (t) => ({ ...still, engine: t > 1000 });
  const hz = 144;
  const fps = drawn(m, hz, 2);
  const slowPart = 30 * 1; // first second
  const fastPart = hz * 1; // second second
  assert.ok(Math.abs(fps * 2 - (slowPart + fastPart)) <= 6, `drew ${fps * 2} frames`);
  // A wake (an event) draws at once, however recent the last frame.
  assert.ok(shouldDraw({ ...still, wake: true }, 1));
});

test("CPU: a slow loop draws a quarter to a fifth of the frames of a 120-144 Hz loop", () => {
  assert.ok(drawn(still, 144) / drawn({ ...still, engine: true }, 144) < 0.25);
  assert.ok(drawn(still, 120) / drawn({ ...still, engine: true }, 120) <= 0.25);
});

test("a slow loop sleeps between its frames, anything quick does not", () => {
  assert.equal(frameDelay({ ...still, engine: true }, 0), 0);
  assert.equal(frameDelay({ ...still, wake: true }, 0), 0);
  // Just drawn: sleep most of the gap, but wake up before the frame is due.
  const nap = frameDelay(still, 1);
  assert.ok(nap > 0 && nap < SLOW_FRAME_MS - 1, `${nap}`);
  assert.equal(nap, SLOW_FRAME_MS - 1 - TIMER_LEAD_MS);
  // Already late: ask at once.
  assert.equal(frameDelay(still, SLOW_FRAME_MS), 0);
  assert.equal(frameDelay(still, 100), 0);
});

test("napping, then taking the next vsync, still gives about 30 fps", () => {
  for (const hz of [60, 144, 240]) {
    const step = 1000 / hz;
    let last = 0;
    let t = 0;
    let n = 0;
    while (t < 2000) {
      // After a drawn frame: nap, then the first vsync after the nap, as the loop does.
      t = Math.ceil((t + 1 + frameDelay(still, 1)) / step) * step;
      // Too early to draw: ask again at once, which lands on the next vsync.
      while (!shouldDraw(still, t - last)) t += step;
      last = t;
      n++;
    }
    const fps = n / (t / 1000);
    assert.ok(fps >= 24 && fps <= 32, `${hz} Hz: ${fps} fps`);
  }
});

// ── The engine's word: BotEngine.fastMotion ───────────────────────────────────

/** Steps the engine until its real-time tweens (the blink on a state change) are done. */
function settle(engine, ms = 3000) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    engine.update(1 / 60);
    if (!engine.fastMotion) return;
  }
}

test("a sleeping Peika is busy, but only with slow loops", () => {
  const e = new BotEngine();
  e.setState("sleeping");
  settle(e);
  assert.equal(e.busy, true, "it breathes for ever");
  assert.equal(e.fastMotion, false, "and that is a slow loop");
  // Over a few seconds of breathing and z's it never turns into full-rate motion.
  for (let i = 0; i < 60 * 4; i++) {
    e.update(1 / 30);
    assert.equal(e.fastMotion, false, `frame ${i}`);
  }
  assert.ok(e.busy);
});

test("a rate-limited Peika's sweat is a slow loop too", () => {
  const e = new BotEngine();
  e.setState("ratelimit");
  settle(e);
  assert.equal(e.busy, true);
  assert.equal(e.fastMotion, false);
});

test("anything else keeps the full rate", () => {
  const bouncing = new BotEngine();
  bouncing.setState("approval");
  assert.equal(bouncing.fastMotion, true, "bounces");

  const searching = new BotEngine();
  searching.setState("searching");
  settle(searching);
  assert.equal(searching.fastMotion, true, "scans");

  const sleeping = new BotEngine();
  sleeping.setState("sleeping");
  settle(sleeping);
  sleeping.emit("heart", 1);
  assert.equal(sleeping.fastMotion, true, "a heart is not a z");
  sleeping.triggerEmote("happy");
  assert.equal(sleeping.fastMotion, true, "an emote is a tween");

  const dancing = new BotEngine();
  dancing.setDancing(true);
  dancing.update(0.05);
  assert.equal(dancing.fastMotion, true, "dances");

  const mini = new BotEngine();
  mini.isMini = true;
  mini.setState("approval");
  assert.equal(mini.fastMotion, true, "a mini bounces too");
});

test("a mini wandering about is a slow loop: busy, but not fast", () => {
  const mini = new BotEngine();
  mini.isMini = true;
  mini.setState("working", true);
  settle(mini);
  assert.equal(mini.busy, true, "it never stops");
  // Its look wanders, it sways, and it hops and blinks: at 13 to 24 px, 30 fps does.
  mini.triggerEmote("happy");
  mini.blink();
  assert.equal(mini.fastMotion, false);
  assert.equal(mini.busy, true);
});

test("an idle Peika is not busy at all, so the loop stops", () => {
  const e = new BotEngine();
  settle(e);
  assert.equal(e.busy, false);
  assert.equal(e.fastMotion, false);
});
