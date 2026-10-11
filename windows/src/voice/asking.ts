// A question is on screen (voice/result.ts `Ask`): what a sentence said next
// answers. A choice by its name, its place or its number; yes or no; and for
// a text field, words to write into it — which are confirmed by a key, a
// click or "confirm" said alone, never by having been said.
//
// Pure: text in, an answer out. island.ts shows the question and passes on
// clicks and keys; conversation.ts holds whoever is waiting for the answer.

import { normalise } from "./entity";
import type { Answer, Ask, AskOption } from "./result";

/** A choice is two to nine options: one key each. */
export const MOST_OPTIONS = 9;

const YES = new Set(["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "do it", "go ahead", "please do", "yes please", "correct", "right", "that one"]);
const NO = new Set(["no", "nope", "nah", "no thanks", "don t", "do not", "not that", "neither", "none"]);
const DROP = new Set(["never mind", "cancel", "forget it", "stop", "nothing", "leave it"]);
const CONFIRM = new Set(["confirm", "send it", "that s it", "done", "ok confirm", "okay confirm"]);
const CLEAR = new Set(["clear", "clear it", "start over", "erase that"]);

const PLACES: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, last: -1,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

/** What a sentence does to a question: answers it, changes what is written, or nothing. */
export type Heard =
  | { is: "answer"; answer: Answer }
  /** A text field: this is what it holds now. */
  | { is: "draft"; value: string }
  /** Not an answer: the question stays. */
  | { is: "unclear" };

/** The option a sentence names: by number, by place, or by its label. Null when none or several. */
export function optionSaid(said: string, options: readonly AskOption[]): AskOption | null {
  const words = normalise(said).split(" ").filter(Boolean);
  if (!words.length) return null;
  const text = words.join(" ");
  // Its label, said whole — before numbers, which a label may hold.
  const named = options.filter((o) => normalise(o.label) === text);
  if (named.length === 1) return named[0];
  // "the second one", "number two", "2", "option three".
  const filler = new Set(["the", "one", "number", "option", "choice", "please", "pick", "choose", "take", "i", "want", "ll", "go", "with"]);
  const meaningful = words.filter((w) => !filler.has(w));
  const place = (() => {
    // "one" is a filler after a place ("the second one") and a number alone ("option one").
    if (!meaningful.length) return words.includes("one") ? 1 : null;
    if (meaningful.length !== 1) return null;
    const word = meaningful[0];
    if (/^[1-9]$/.test(word)) return Number(word);
    return PLACES[word] ?? null;
  })();
  if (place != null) {
    const at = place === -1 ? options.length : place;
    return options[at - 1] ?? null;
  }
  // Part of one label and of no other: "the work one" for "Work — a@work.com".
  const partly = options.filter((o) => {
    const label = ` ${normalise(o.label)} ${normalise(o.hint ?? "")} `;
    return meaningful.length > 0 && meaningful.every((w) => label.includes(` ${w} `));
  });
  return partly.length === 1 ? partly[0] : null;
}

/**
 * What a sentence said while a question is on screen comes to. `draft`: what
 * the text field holds so far.
 */
export function readSaid(ask: Ask, said: string, draft = ""): Heard {
  const text = normalise(said);
  if (!text) return { is: "unclear" };
  if (DROP.has(text)) return { is: "answer", answer: { kind: "dropped" } };
  switch (ask.kind) {
    case "choice": {
      const option = optionSaid(said, ask.options);
      return option ? { is: "answer", answer: { kind: "choice", id: option.id } } : { is: "unclear" };
    }
    case "yes_no": {
      const yes = normalise(ask.yes ?? "");
      const no = normalise(ask.no ?? "");
      if (YES.has(text) || (yes && text === yes)) return { is: "answer", answer: { kind: "yes_no", yes: true } };
      if (NO.has(text) || (no && text === no)) return { is: "answer", answer: { kind: "yes_no", yes: false } };
      return { is: "unclear" };
    }
    case "text": {
      // Said alone, these are about the field; inside a sentence they are words of it.
      if (CONFIRM.has(text)) return draft.trim() ? { is: "answer", answer: { kind: "text", value: draft.trim() } } : { is: "unclear" };
      if (CLEAR.has(text)) return { is: "draft", value: "" };
      const spoken = said.trim();
      return { is: "draft", value: draft.trim() ? `${draft.trim()} ${spoken}` : spoken };
    }
  }
}

/** The answer a key gives: Ctrl+Shift+number, or Ctrl+Shift+Enter. Null when the key means nothing here. */
export function keyAnswer(ask: Ask, key: string, draft = ""): Answer | null {
  if (key === "enter") {
    return ask.kind === "text" && draft.trim() ? { kind: "text", value: draft.trim() } : null;
  }
  const number = Number(key);
  if (!Number.isInteger(number) || number < 1) return null;
  if (ask.kind === "choice") {
    const option = ask.options[number - 1];
    return option ? { kind: "choice", id: option.id } : null;
  }
  if (ask.kind === "yes_no") return number === 1 ? { kind: "yes_no", yes: true } : number === 2 ? { kind: "yes_no", yes: false } : null;
  return null;
}

/** The keys a question holds: how many number keys, and whether Enter. */
export function keysFor(ask: Ask | null): { numbers: number; enter: boolean } {
  if (!ask) return { numbers: 0, enter: false };
  if (ask.kind === "choice") return { numbers: Math.min(ask.options.length, MOST_OPTIONS), enter: false };
  if (ask.kind === "yes_no") return { numbers: 2, enter: false };
  return { numbers: 0, enter: true };
}

/** A question as it may be shown: trimmed, a choice of two to nine, or null when it is none. */
export function usable(ask: Ask): Ask | null {
  const question = ask.question.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!question) return null;
  if (ask.kind === "choice") {
    const options = ask.options
      .map((o) => ({ id: String(o.id), label: String(o.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80), ...(o.hint ? { hint: String(o.hint).slice(0, 80) } : {}) }))
      .filter((o) => o.id && o.label)
      .slice(0, MOST_OPTIONS);
    return options.length >= 2 ? { kind: "choice", question, options } : null;
  }
  return { ...ask, question };
}

/** What an answer was, in words — for the card, the memory and a model. */
export function answerLine(ask: Ask, answer: Answer): string {
  switch (answer.kind) {
    case "choice":
      return ask.kind === "choice" ? (ask.options.find((o) => o.id === answer.id)?.label ?? answer.id) : answer.id;
    case "yes_no":
      return answer.yes ? "yes" : "no";
    case "text":
      return answer.value;
    case "dropped":
      return "";
  }
}
