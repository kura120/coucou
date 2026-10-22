// The screen capture overlay's rectangle (src/capture/pick.ts). The part
// itself is cut in Rust (capture/mod.rs, `selection`), tested there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRect } from "../src/capture/pick.ts";

test("the drawn rectangle is the same whichever way the drag goes", () => {
  const want = { left: 10, top: 20, width: 90, height: 40 };
  assert.deepEqual(pickRect({ x: 10, y: 20 }, { x: 100, y: 60 }), want);
  assert.deepEqual(pickRect({ x: 100, y: 60 }, { x: 10, y: 20 }), want);
  assert.deepEqual(pickRect({ x: 100, y: 20 }, { x: 10, y: 60 }), want);
  assert.deepEqual(pickRect({ x: 5, y: 5 }, { x: 5, y: 5 }), { left: 5, top: 5, width: 0, height: 0 });
});
