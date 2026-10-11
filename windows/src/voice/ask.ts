// "Open spy flight": no app by that name, so Mochi asks — "Open Spotify?", or
// "Spotify or Steam?" when two are as near — and listens again. A guess is
// never opened without the yes. The nearest apps come from Rust
// (src-tauri/src/voice/apps.rs `near`); what the answer means is read here.

import { t } from "../i18n/i18n";
import { normalise } from "./entity";
import type { VoiceResult } from "./runner";

/** The question Mochi asks about one app, or about two. */
export function openQuestion(names: readonly string[]): VoiceResult {
  const message = names.length > 1 ? t("{0} or {1}?", { 0: names[0], 1: names[1] }) : t("Open {0}?", { 0: names[0] });
  return { outcome: "question", message };
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
