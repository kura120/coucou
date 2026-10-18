// A question is on screen (voice/result.ts `Ask`): the keys it holds, the
// answer a key gives, and the shape a question must have to be shown. What a
// sentence said next answers is not read here: a text field takes the words
// as they are, and a choice or a yes/no is read by the local model
// (voice/turn.ts `answerSaid`).
//
// Pure: a key in, an answer out. island.ts shows the question and passes on
// clicks and keys; voice/turn.ts holds whoever is waiting for the answer.

import type { Answer, Ask } from "./result";

/** A choice is two to nine options: one key each. */
export const MOST_OPTIONS = 9;

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
    return options.length >= 2 ? { kind: "choice", question, options, ...(ask.about ? { about: ask.about } : {}) } : null;
  }
  return { ...ask, question };
}
