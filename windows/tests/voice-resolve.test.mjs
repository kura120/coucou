// How names are compared (src/voice/entity.ts, src/voice/resolve.ts): letters,
// a key of how a name sounds, and how sure the speech model was of the words.
// Which thing a name is, among the app's own, is the executor's
// (tests/capabilities-*.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { among } from "../src/core/capabilities/match.ts";
import { levenshtein, normalise, soundKey } from "../src/voice/entity.ts";
import { UNSURE_WORD, heardWith, likeness, sureOf } from "../src/voice/resolve.ts";
import { applyVoice } from "../src/island/voice.ts";

test("a name is compared without its accents, its capitals and its punctuation", () => {
  assert.equal(normalise("  Café-Crème, s'il vous plaît! "), "cafe creme s il vous plait");
  assert.equal(normalise("LM Studio"), "lm studio");
  assert.equal(normalise("…"), "");
});

test("how a name sounds: consonants, those a recogniser confuses made the same", () => {
  assert.equal(soundKey("Discord"), soundKey("this cord"));
  assert.equal(soundKey("Codex"), soundKey("Kodaks"));
  assert.equal(soundKey("Vercel"), soundKey("versal"));
  assert.notEqual(soundKey("Stripe"), soundKey("strife") + "x");
});

test("letters apart", () => {
  assert.equal(levenshtein("stripe", "strife"), 1);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("same", "same"), 0);
});

test("how alike two names are: letters, or how they sound", () => {
  assert.equal(likeness("spotify", "Spotify"), 1);
  assert.ok(likeness("strife", "stripe") >= 0.8);
  assert.ok(likeness("this squad", "discord") >= 0.75, "the same sounds but one");
  assert.equal(likeness("photoshop", "photos"), 0);
  assert.equal(likeness("ocean", "notion"), 0);
});

test("how sure the speech model was of a word comes with the sentence", () => {
  // As Rust reports "Open this cord." — the name's words were a guess.
  applyVoice({ voiceHeard() {} }, { phase: "final", text: "Open this cord.", sure: [0.92, 0.4, 0.83] });
  assert.equal(sureOf("this cord"), 0.4);
  assert.equal(sureOf("open"), 0.92);
  assert.equal(sureOf("spotify"), null, "not in the sentence: nothing is known");
  // No numbers, or not one for each word: nothing is known, which is not unsure.
  heardWith("switch to kodaks", [0.1]);
  assert.equal(sureOf("kodaks"), null);
  heardWith("switch to kodaks", undefined);
  assert.equal(sureOf("kodaks"), null);
});

test("a name found by its sound is that thing — unless the speech model doubted the word", () => {
  const things = [{ id: "codex", label: "Codex" }, { id: "cursor", label: "Cursor" }, { id: "stripe", label: "Stripe" }];
  const doubted = (said) => (sureOf(said) ?? 1) < UNSURE_WORD;
  heardWith("switch to kodaks", [0.97, 0.98, 0.62]);
  assert.equal(among("kodaks", things, { doubted }).is, "sure");
  heardWith("switch to kodaks", [0.97, 0.98, 0.3]);
  assert.equal(among("kodaks", things, { doubted }).is, "unsure");
  // Spelt as it is written, it is never questioned, however unsure the model was.
  heardWith("remove stripe", [0.3, 0.2]);
  assert.equal(among("stripe", things, { doubted }).is, "sure");
  // A letter away and not the same sound: another word, perhaps. Asked about.
  heardWith("remove strife", undefined);
  assert.deepEqual(among("strife", things, { doubted }).is, "unsure");
});

test("the whole sentence may be given as the name: the thing said in it is found", () => {
  const things = [{ id: "chat", label: "Chat" }, { id: "wardrobe", label: "Wardrobe" }, { id: "recap", label: "Weekly recap" }];
  assert.deepEqual(among("show me the wardrobe please", things), { is: "sure", id: "wardrobe", label: "Wardrobe" });
  assert.equal(among("open the weekly recap", things).is, "sure");
  // Two of them said: neither is guessed.
  assert.equal(among("the chat or the wardrobe", things).is, "unsure");
  // None of them said: nothing by that name.
  assert.equal(among("seven eight nine", things).is, "none");
});
