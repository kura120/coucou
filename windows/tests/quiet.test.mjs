// When an alert may come up over a fullscreen app (src/island/quiet.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mayBeQuiet, quietDecision } from "../src/island/quiet.ts";

const KINDS = ["finished", "error", "approval", "question"];

test("a finished or failed session becomes a silent badge while busy, with the switch on", () => {
  for (const kind of ["finished", "error"]) {
    assert.deepEqual(quietDecision(kind, true, true), { open: false, sound: false }, kind);
  }
});

test("a request that waits for an answer always comes up, with its sound", () => {
  for (const kind of ["approval", "question"]) {
    for (const busy of [true, false]) {
      for (const quiet of [true, false]) {
        assert.deepEqual(quietDecision(kind, busy, quiet), { open: true, sound: true }, `${kind} busy=${busy} quiet=${quiet}`);
      }
    }
  }
});

test("when the user is not busy, or the switch is off, nothing is held back", () => {
  for (const kind of KINDS) {
    assert.deepEqual(quietDecision(kind, false, true), { open: true, sound: true }, `${kind} not busy`);
    assert.deepEqual(quietDecision(kind, true, false), { open: true, sound: true }, `${kind} switch off`);
    assert.deepEqual(quietDecision(kind, false, false), { open: true, sound: true }, `${kind} both`);
  }
});

test("the system is only worth asking for an alert that could be held back, with the switch on", () => {
  assert.deepEqual(KINDS.map((kind) => mayBeQuiet(kind, true)), [true, true, false, false]);
  assert.deepEqual(KINDS.map((kind) => mayBeQuiet(kind, false)), [false, false, false, false]);
});
