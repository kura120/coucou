// The web answer card: the question, a wait, then a short answer with its
// sources as links, "Tell me more", and the search itself in the browser.
// Today it shows SAMPLE DATA (voice/tools-preview.ts): nothing is searched.
// The Mac shows a web answer as one spoken line on its result card; this card
// adds what a spoken line cannot carry — where the answer comes from.

import { clear, h } from "./dom";
import { State } from "../core/state";
import { t, tl } from "../i18n/i18n";
import type { Ask } from "../voice/result";
import type { WebAnswerData } from "../voice/tools-preview";
import { CARD_ICONS, buildShell, button, cardAsk, failure, waiting, type CardDriver } from "./sample";
import type { ViewActions, ViewHost } from "./views";

export type WebState =
  | { phase: "idle" }
  | { phase: "working"; question: string; line: string }
  /** "Search the web" with nothing after it: what for? */
  | { phase: "asking"; ask: Ask }
  /** An answer — or none, when `data.answer` is empty. */
  | { phase: "done"; data: WebAnswerData }
  | { phase: "failed"; question: string; line: string; detail: string };

/** At most this many sources are links; the rest are a count that opens the search. */
const MOST_SOURCES = 5;

/** What the card shows. Set it with `show`; the island redraws. */
export const WebCard = {
  state: { phase: "idle" } as WebState,
  /** "Tell me more" was clicked on the answer shown. */
  more: false,
  /** Changes with every `show`, so the card is drawn once per state and not on every frame. */
  version: 0,
  show(next: WebState) {
    this.state = next;
    this.more = false;
    this.version += 1;
    State.notify();
  },
};

const quoted = (question: string) => (question ? `“${question}”` : "");

export function buildWebAnswer(actions: ViewActions, driver: CardDriver): ViewHost {
  const shell = buildShell("web");
  const ask = cardAsk(
    () => State.view === "webAnswer" && State.mode === "expanded" && WebCard.state.phase === "asking",
    (answer) => driver.answer(answer),
  );
  let drawn = -1;

  const question = (text: string) => h("div", { class: "vc-question", dir: "auto", title: text, text: quoted(text) });
  const close = () => button(tl("Done"), "secondary", () => driver.close());

  function answered(data: WebAnswerData) {
    const answer = h("div", { class: WebCard.more ? "vc-answer more" : "vc-answer", dir: "auto" }, h("p", { text: data.answer }));
    if (WebCard.more && data.more) answer.append(h("p", { text: data.more }));

    const sources = h("div", { class: "vc-sources" });
    data.sources.slice(0, MOST_SOURCES).forEach((source, index) => {
      sources.append(h(
        "button",
        { class: "vc-source", title: `${source.title}\n${source.url}`, onclick: () => driver.open(source.url) },
        h("span", { class: "vc-source-n", text: String(index + 1) }),
        h("span", { class: "vc-source-site", text: source.site }),
      ));
    });
    const rest = data.sources.length - MOST_SOURCES;
    if (rest > 0) {
      sources.append(h("button", { class: "vc-source", onclick: () => driver.open(data.searchUrl) }, h("span", { text: `+${rest}` })));
    }

    const row = h("div", { class: "actions" });
    if (data.more && !WebCard.more) {
      row.append(button(tl("Tell me more"), "primary", () => {
        WebCard.more = true;
        WebCard.version += 1;
        driver.say(data.more);
        State.notify();
      }));
    }
    row.append(button(tl("Open search"), data.more && !WebCard.more ? "secondary" : "primary", () => driver.open(data.searchUrl)), close());
    shell.main.append(question(data.question), answer, sources, row);
  }

  function nothing(data: WebAnswerData) {
    shell.main.append(
      question(data.question),
      h("div", { class: "sub", text: tl("Nothing found for this search.") }),
      h("div", { class: "actions" }, button(tl("Open search"), "primary", () => driver.open(data.searchUrl)), close()),
    );
  }

  function draw() {
    const state = WebCard.state;
    clear(shell.main);
    ask.hide();
    shell.setTitle(CARD_ICONS.search, t("Web search"), 2);
    shell.setWash(state.phase === "failed" ? "red" : null);
    switch (state.phase) {
      case "idle":
        break;
      case "working":
        shell.main.append(question(state.question), waiting(state.line));
        break;
      case "asking":
        ask.show(state.ask);
        shell.main.append(ask.el);
        window.setTimeout(() => ask.focus(), 150);
        break;
      case "done":
        if (state.data.answer) answered(state.data);
        else nothing(state.data);
        break;
      case "failed":
        if (state.question) shell.main.append(question(state.question));
        shell.main.append(
          failure(state.line, state.detail),
          h(
            "div",
            { class: "actions" },
            button(tl("Retry"), "primary", () => driver.run({ name: "web_search", arguments: { query: state.question } })),
            close(),
          ),
        );
        break;
    }
    shell.fit("webAnswer", actions);
  }

  return {
    el: shell.el,
    sync() {
      // Drawn once per state: buttons rebuilt between a mouse-down and its mouse-up would swallow the click.
      if (drawn === WebCard.version) return;
      drawn = WebCard.version;
      draw();
    },
  };
}
