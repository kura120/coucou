// The web answer card and the email cards join the island here. A card's own
// button (Retry) asks for one of the app's capabilities, run as the
// interface's own call; a web search made in a voice turn is shown by the
// island when the turn ends (island.ts), through `showWebAnswer`.
//
// The email cards are in the tree and reachable from nowhere: email is not
// built yet, and nothing opens them.

import { Bridge, IS_TAURI } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { searchUrl } from "../core/search";
import { State } from "../core/state";
import { language, onLanguageChange } from "../i18n/i18n";
import { MAX_SPOKEN } from "../voice/result";
import type { CardDriver } from "./card";
import { MailCard, buildEmail } from "./email";
import type { ViewActions, ViewHost } from "./views";
import { WebCard, buildWebAnswer, webAnswer, type WebFound } from "./websearch";

/** The first sentence of a text: what Peika says of a longer answer. */
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return (end < 0 ? text : text.slice(0, end + 1)).trim();
}

/** The web answer card on what a search found. `answer`: what was made of the results, when someone read them. */
export function showWebAnswer(question: string, results: readonly WebFound[], answer = "") {
  WebCard.show({ phase: "done", data: webAnswer(question, results, answer, searchUrl(question, State.settings.searchEngine)) });
}

/** Adds the two views to the island's. */
export function registerVoiceCards(views: Map<IslandViewName, ViewHost>, actions: ViewActions) {
  /** One of the two cards is on screen with something on it. */
  const cardUp = () =>
    State.mode === "expanded" &&
    ((State.view === "webAnswer" && WebCard.state.phase !== "idle") || (State.view === "email" && MailCard.state.step !== "idle"));
  /** It asks something, or has fields: keys are meant for it. */
  const wantsKeys = () => State.view === "email" && (MailCard.state.step === "asking" || MailCard.state.step === "compose");
  let hasKeyboard = false;

  // A card with something on it keeps the island open — a list is not read
  // in ten seconds — and takes the keyboard while it asks or is typed in, as
  // the chat does. Leaving it any way at all (a tab, Escape, the wake phrase)
  // drops it: what was on it is gone, and the keyboard is given back.
  State.subscribe(() => {
    const up = cardUp();
    State.cardHeld = up;
    const keys = up && wantsKeys();
    if (keys !== hasKeyboard) {
      hasKeyboard = keys;
      void Bridge.focusWindow(keys);
    }
    if (up) return;
    if (WebCard.state.phase !== "idle" && State.view !== "webAnswer") WebCard.state = { phase: "idle" };
    if (MailCard.state.step !== "idle" && State.view !== "email") MailCard.state = { step: "idle" };
  });

  const driver: CardDriver = {
    run(call) {
      // Only the web search is behind a card's button; email is not built.
      if (call.name !== "web_search") return;
      const question = String(call.arguments.query ?? "");
      WebCard.show({ phase: "working", question, line: "" });
      void actions.capability(call).then((result) => {
        if (State.view !== "webAnswer" || WebCard.state.phase !== "working") return;
        if (result.status === "done") showWebAnswer(question, Array.isArray(result.data) ? (result.data as WebFound[]) : []);
        else WebCard.show({ phase: "failed", question, line: result.line, detail: result.detail && result.detail !== result.line ? result.detail : "" });
      });
    },
    answer() {},
    close() {
      WebCard.show({ phase: "idle" });
      MailCard.show({ step: "idle" });
      actions.dismissCard("collapse");
    },
    open(url) {
      if (!/^https?:\/\//i.test(url)) return;
      actions.openUrl(url);
      // No Rust in the browser preview: the link opens in a tab.
      if (!IS_TAURI) window.open(url, "_blank", "noopener");
    },
    say(text) {
      // English only, like the rest of Peika's voice (island/voice.ts `sayResult`).
      if (!State.settings.voice.speak || language() !== "en" || !text) return;
      void Bridge.voiceSay(text.slice(0, MAX_SPOKEN));
    },
  };

  views.set("webAnswer", buildWebAnswer(actions, driver));
  views.set("email", buildEmail(actions, driver));

  // What a card says in words of its own is drawn again in the new language.
  onLanguageChange(() => {
    WebCard.version += 1;
    MailCard.version += 1;
  });
}
