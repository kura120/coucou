// The web answer card: the question, a wait, then a short answer with its
// sources as links, "Tell me more", and the search itself in the browser.
// It shows what the `web_search` capability found (capabilities/web.ts): the
// answer is the model's, made from those results, and the links are theirs.
// The Mac shows a web answer as one spoken line on its result card; this card
// adds what a spoken line cannot carry — where the answer comes from.

import { clear, h } from "./dom";
import { State } from "../core/state";
import { t, tl } from "../i18n/i18n";
import { CARD_ICONS, buildShell, button, failure, waiting, type CardDriver } from "./card";
import type { ViewActions, ViewHost } from "./views";

export interface WebSource {
  title: string;
  /** The host, as shown on the link. */
  site: string;
  url: string;
}

/** What the web answer card shows. */
export interface WebAnswerData {
  question: string;
  /** Two or three sentences: shown, and the first is spoken. */
  answer: string;
  /** What "Tell me more" adds. */
  more: string;
  sources: WebSource[];
  /** Where "Open search" goes: the question in the browser. */
  searchUrl: string;
}

/** A search result as the capability gives it. */
export interface WebFound {
  title: string;
  url: string;
  snippet: string;
}

/** The host of an address, without its "www."; the address itself when it is none. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * What the card shows for a search: `answer` is what was made of the results
 * (a model's words), or the first result's own words when nobody read them;
 * "Tell me more" adds what the other results say.
 */
export function webAnswer(question: string, results: readonly WebFound[], answer: string, searchUrl: string): WebAnswerData {
  const said = answer.trim();
  const rest = (said ? results : results.slice(1)).filter((r) => r.snippet.trim());
  return {
    question,
    answer: said || (results[0]?.snippet.trim() ?? ""),
    more: rest.slice(0, 3).map((r) => `${r.title} — ${r.snippet.trim()}`).join("\n\n"),
    sources: results.filter((r) => /^https?:\/\//i.test(r.url)).map((r) => ({ title: r.title, site: siteOf(r.url), url: r.url })),
    searchUrl,
  };
}

export type WebState =
  | { phase: "idle" }
  | { phase: "working"; question: string; line: string }
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
  let drawn = -1;

  const question = (text: string) => h("div", { class: "vc-question", dir: "auto", title: text, text: quoted(text) });
  const close = () => button(tl("Done"), "secondary", () => driver.close());

  function answered(data: WebAnswerData) {
    const answer = h("div", { class: WebCard.more ? "vc-answer more" : "vc-answer", dir: "auto" }, h("p", { text: data.answer }));
    if (WebCard.more && data.more) for (const part of data.more.split("\n\n")) answer.append(h("p", { text: part }));

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
    shell.setTitle(CARD_ICONS.search, t("Web search"), 2);
    shell.setWash(state.phase === "failed" ? "red" : null);
    switch (state.phase) {
      case "idle":
        break;
      case "working":
        shell.main.append(question(state.question), waiting(state.line));
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
