// The names the user confirmed (src/core/capabilities/names.ts): what is kept
// of a confirmation, its counts and times, how many are kept, and what is
// forgotten. In memory only: nothing here touches a disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLearnedNames } from "../src/core/capabilities/names.ts";

/** A clock that moves one step at each call, so the order of confirmations is certain. */
const clock = () => {
  let at = 0;
  return () => ++at;
};

test("a learned name is found by what was heard, compared normalised, and its forms are its written forms", () => {
  const names = createLearnedNames({ now: clock() });
  names.learn("integration", "  Strife! ", "integration_stripe", "Stripe");
  assert.deepEqual(names.find("integration", "strife"), { heard: "strife", kind: "integration", id: "integration_stripe", label: "Stripe", confirmed: 1, at: 1 });
  assert.equal(names.find("integration", "STRIFE").id, "integration_stripe");
  assert.equal(names.find("integration", "Strífe").id, "integration_stripe");
  assert.equal(names.find("app", "strife"), undefined);
  assert.equal(names.find("integration", "stripe"), undefined);
  assert.deepEqual(names.forms("integration", "integration_stripe"), ["strife"]);
  assert.deepEqual(names.forms("integration", "integration_vercel"), []);
  assert.deepEqual(names.forms("app", "integration_stripe"), []);
});

test("a name confirmed again counts once more, and takes the new id, label and time", () => {
  const names = createLearnedNames({ now: clock() });
  names.learn("app", "this squad", "discord", "Discord");
  names.learn("app", "this squad", "discord_canary", "Discord Canary");
  assert.deepEqual(names.find("app", "this squad"), { heard: "this squad", kind: "app", id: "discord_canary", label: "Discord Canary", confirmed: 2, at: 2 });
  assert.equal(names.list().length, 1);
});

test("at most `most` names are kept, and the one confirmed longest ago goes", () => {
  const names = createLearnedNames({ most: 2, now: clock() });
  names.learn("pill", "alpha", "a", "A");
  names.learn("pill", "beta", "b", "B");
  names.learn("pill", "alpha", "a", "A");
  names.learn("pill", "gamma", "c", "C");
  assert.deepEqual(names.list().map((name) => name.heard), ["alpha", "gamma"]);
  assert.equal(names.find("pill", "beta"), undefined);
});

test("by default, 200 names are kept", () => {
  const names = createLearnedNames({ now: clock() });
  for (let i = 0; i < 201; i++) names.learn("pill", `name ${i}`, `id_${i}`, `Name ${i}`);
  assert.equal(names.list().length, 200);
  assert.equal(names.find("pill", "name 0"), undefined);
  assert.equal(names.find("pill", "name 200").id, "id_200");
});

test("a name is one to three words: a sentence is not learned", () => {
  const names = createLearnedNames({ now: clock() });
  names.learn("pill", "remove the strife one", "integration_stripe", "Stripe");
  assert.equal(names.list().length, 0);
  names.learn("pill", "the strife one", "integration_stripe", "Stripe");
  assert.equal(names.find("pill", "the strife one").id, "integration_stripe");
  names.learn("pill", "one two three", "x", "X");
  assert.equal(names.find("pill", "one two three").id, "x");
});

test("nothing heard is not learned", () => {
  const names = createLearnedNames({ now: clock() });
  names.learn("pill", "", "integration_stripe", "Stripe");
  names.learn("pill", "  !? ", "integration_stripe", "Stripe");
  assert.deepEqual(names.list(), []);
});

test("forget removes what was learned, and nothing else", () => {
  const names = createLearnedNames({ now: clock() });
  names.learn("pill", "strife", "integration_stripe", "Stripe");
  names.learn("pill", "strype", "integration_stripe", "Stripe");
  names.forget("pill", " Strife ");
  assert.equal(names.find("pill", "strife"), undefined);
  assert.equal(names.find("pill", "strype").id, "integration_stripe");
  names.forget("pill", "never learned");
  names.forget("app", "strype");
  assert.equal(names.list().length, 1);
});

test("names given at the start are kept as they were confirmed", () => {
  const names = createLearnedNames({
    now: clock(),
    initial: [{ heard: "Strife", kind: "pill", id: "integration_stripe", label: "Stripe", confirmed: 5, at: 42 }],
  });
  assert.deepEqual(names.find("pill", "strife"), { heard: "strife", kind: "pill", id: "integration_stripe", label: "Stripe", confirmed: 5, at: 42 });
  names.learn("pill", "strife", "integration_stripe", "Stripe");
  assert.equal(names.find("pill", "strife").confirmed, 6);
});
