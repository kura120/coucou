// A name Mochi is not sure of is asked about, whatever it names (voice/resolve.ts):
// "Open Spotify?", "Remove Stripe?", or "Spotify or Steam?" when two or three
// are as near — and he listens again. A guess is never acted on without the
// yes. The questions are the contract's (`Ask`, doc/voice-turns.md): one
// candidate is a yes or no, several are a choice; what a spoken answer means
// is read here, and a click or Ctrl+Shift+number gives the same `Answer`.

import type { PillDefinition } from "../core/pills";
import { t } from "../i18n/i18n";
import { normalise } from "./entity";
import type { VoiceIntent } from "./intent";
import { certain, howNamed } from "./resolve";
import type { Answer, Ask } from "./result";
import type { VoiceResult, VoiceRunner } from "./runner";

/**
 * The question about what a name may be: yes or no for one candidate, a
 * choice between two or three. `one`: how the question about one is worded.
 */
export function askWhich(candidates: readonly { id: string; label: string }[], one: (label: string) => string): Ask {
  const [a, b, c] = candidates.map((candidate) => candidate.label);
  if (candidates.length < 2) return { kind: "yes_no", question: one(a) };
  const question = c ? t("{0}, {1} or {2}?", { 0: a, 1: b, 2: c }) : t("{0} or {1}?", { 0: a, 1: b });
  return { kind: "choice", question, options: candidates.slice(0, 3).map(({ id, label }) => ({ id, label })) };
}

export const openQuestion = (label: string) => t("Open {0}?", { 0: label });

/**
 * The question about a pill command whose pill was only nearly named:
 * "Remove Stripe?". `ids`: the pills in doubt; null when the intent is not
 * about pills.
 */
export function intentQuestion(intent: VoiceIntent, pills: readonly PillDefinition[]): string | null {
  const name = (id: string) => pills.find((p) => p.id === id)?.name ?? id;
  const names = (ids: readonly string[]) => ids.map(name).join(", ");
  switch (intent.kind) {
    case "pillAdd":
      return t("Add {0}?", { 0: name(intent.id) });
    case "pillAddMultiple":
      return t("Add {0}?", { 0: names(intent.ids) });
    case "pillRemove":
      return t("Remove {0}?", { 0: name(intent.id) });
    case "pillRemoveMultiple":
      return t("Remove {0}?", { 0: names(intent.ids) });
    case "pillSetMain":
      return t("Switch to {0}?", { 0: name(intent.id) });
    case "pillReplace":
      return t("Replace {0} with {1}?", { 0: name(intent.old), 1: name(intent.new) });
    case "pillOnly":
      return t("Keep only {0}?", { 0: names(intent.ids) });
    default:
      return null;
  }
}

/** The intent with one pill in place of another. */
export function renamed(intent: VoiceIntent, from: string, to: string): VoiceIntent {
  const swap = (id: string) => (id === from ? to : id);
  switch (intent.kind) {
    case "pillAdd":
    case "pillRemove":
    case "pillSetMain":
      return { ...intent, id: swap(intent.id) };
    case "pillAddMultiple":
    case "pillRemoveMultiple":
    case "pillOnly":
      return { ...intent, ids: intent.ids.map(swap) };
    case "pillReplace":
      return { ...intent, old: swap(intent.old), new: swap(intent.new) };
    default:
      return intent;
  }
}

/**
 * Of these pills, the ones a sentence said freely names only nearly: a letter
 * or two away and not the same sound, or by a word the speech model was not
 * sure of. A pill the sentence does not name at all is not in doubt here —
 * the checks refuse it elsewhere.
 */
export function nearlyNamed(said: string, ids: readonly string[], pills: readonly PillDefinition[]): string[] {
  return ids.filter((id) => {
    const how = howNamed(said, id, pills);
    return how != null && !certain(how);
  });
}

/**
 * For a pill command a model proposed: the question to ask when the sentence
 * only nearly names its pill ("get rid of strife" → "Remove Stripe?"), as a
 * function that asks it — or null when every pill is surely named.
 */
export function askNearlyNamed(
  intent: VoiceIntent,
  said: string,
  runner: VoiceRunner,
  pills: readonly PillDefinition[],
): (() => VoiceResult) | null {
  const doubtful = nearlyNamed(said, [...new Set(pillsOf(intent))], pills);
  const question = doubtful.length ? intentQuestion(intent, pills) : null;
  if (!question) return null;
  const label = (id: string) => pills.find((p) => p.id === id)?.name ?? id;
  const one = doubtful.length === 1 ? doubtful[0] : null;
  const candidates = one ? [{ id: one, label: label(one) }] : [{ id: "", label: doubtful.map(label).join(", ") }];
  const then = (id: string) => [one && id && id !== one ? renamed(intent, one, id) : intent];
  return () => runner.ask({ ask: { kind: "yes_no", question }, candidates, then, said, rounds: 1 });
}

/** The pills an intent names. */
export function pillsOf(intent: VoiceIntent): string[] {
  switch (intent.kind) {
    case "pillAdd":
    case "pillRemove":
    case "pillSetMain":
      return [intent.id];
    case "pillAddMultiple":
    case "pillRemoveMultiple":
    case "pillOnly":
      return intent.ids;
    case "pillReplace":
      return [intent.old, intent.new];
    default:
      return [];
  }
}

/**
 * What a spoken answer to a question means, as the contract's `Answer` — or
 * `unclear` ("yes" to a choice: which one is still not known), or `other`
 * (something else was said: another name, or another command).
 * `labels`: the candidate a yes-or-no question was about, by its name.
 */
export function answerOf(said: string, ask: Ask, labels: readonly string[] = []): Answer | { kind: "unclear" } | { kind: "other"; said: string } {
  if (ask.kind === "text") return said.trim() ? { kind: "text", value: said.trim() } : { kind: "dropped" };
  const names = ask.kind === "choice" ? ask.options.map((option) => option.label) : labels.slice(0, 1);
  const answer = readAnswer(said, names.length ? names : ["\u0000"]);
  switch (answer.kind) {
    case "no":
      return normalise(said) ? (ask.kind === "yes_no" ? { kind: "yes_no", yes: false } : { kind: "dropped" }) : { kind: "dropped" };
    case "unclear":
      return { kind: "unclear" };
    case "other":
      return answer;
    case "open":
      if (ask.kind === "yes_no") return { kind: "yes_no", yes: true };
      return { kind: "choice", id: ask.options[names.indexOf(answer.name)].id };
  }
}

export type OpenAnswer =
  /** Yes to the one app asked about, or one of the two was named. */
  | { kind: "open"; name: string }
  | { kind: "no" }
  /** "Yes" to "Spotify or Steam?": which one is still not known. */
  | { kind: "unclear" }
  /** Something else was said: another name, or another command. */
  | { kind: "other"; said: string };

const YES = new Set([
  "yes", "yeah", "yep", "yup", "ya", "yes please", "yeah please", "sure", "ok", "okay", "do it", "yes do it", "yeah do it", "go ahead",
  "go for it", "please", "please do", "open it", "yes open it", "yeah open it", "that one", "that s it", "that s right", "that s the one",
  "right", "correct", "exactly", "uh huh", "mhm", "i did", "i do", "yes i did", "yes i do", "of course",
]);
const NO = new Set([
  "no", "nope", "nah", "no thanks", "no thank you", "never mind", "cancel", "forget it", "neither", "none", "nothing", "not that",
  "don t", "do not", "stop", "leave it", "no don t",
]);
/** Before a name, in an answer: "no, Discord", "I meant the second one". */
const LEAD = /^(?:(?:yes|yeah|yep|no|nope|not|open|launch|i meant|i said|i mean|it s|the|that s|try) )+/;
const FIRST = /^(first|former|first one)$/;
const SECOND = /^(second|latter|second one|last one|other one|other)$/;

/** What an answer to "Open X?" or "X or Y?" means. */
export function readAnswer(said: string, names: readonly string[]): OpenAnswer {
  const answer = normalise(said);
  if (!answer || NO.has(answer)) return { kind: "no" };
  if (YES.has(answer)) return names.length === 1 ? { kind: "open", name: names[0] } : { kind: "unclear" };
  const rest = answer.replace(LEAD, "").replace(/ (please|one)$/, "");
  if (names.length > 1 && FIRST.test(rest)) return { kind: "open", name: names[0] };
  if (names.length > 1 && SECOND.test(rest)) return { kind: "open", name: names[1] };
  // One of them by its name, or by words only it has: "code" for Visual Studio Code.
  const words = rest.split(" ").filter(Boolean);
  const having = names.filter((name) => {
    const have = normalise(name).split(" ");
    return words.length > 0 && words.every((w) => have.includes(w));
  });
  const exact = names.find((name) => normalise(name) === rest);
  const one = exact ?? (having.length === 1 ? having[0] : null);
  if (one) return { kind: "open", name: one };
  // "Yes, yes.", "okay sure": said twice is still a yes to the one asked about.
  if (names.length === 1 && answer.split(" ").every((w) => /^(yes|yeah|yep|sure|okay|ok|please)$/.test(w))) return { kind: "open", name: names[0] };
  return { kind: "other", said: rest || answer };
}
