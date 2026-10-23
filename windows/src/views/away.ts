// "While you were away": one card, shown once when the user comes back after a
// while, telling which sessions finished, which failed and which asked for
// them — and whether that request is still waiting or went back to its
// terminal. Each line opens its pill. What it tells comes from the record in
// island/away.ts, which keeps names and states and nothing else.

import { h, clear, dot } from "./dom";
import type { ViewActions, ViewHost } from "./views";
import { washRGBA } from "../core/layout";
import { State } from "../core/state";
import { Away, type AwayEvent } from "../island/away";
import { onLanguageChange, t, tl } from "../i18n/i18n";
import { formatDuration } from "../recap/summary";

/** Lines shown; the rest are counted. */
export const MAX_LINES = 4;

/** What happened to a pill, as the line says it after the pill's name. */
export function whatHappened(kind: AwayEvent["kind"]): string {
  switch (kind) {
    case "finished": return t("finished");
    case "error": return t("stopped on an error");
    case "approval": return t("asked for your approval");
    case "question": return t("asked you a question");
  }
}

/** For a request: still on the island, or handed back to the terminal it came from. */
export function requestStatus(event: AwayEvent): string | null {
  if (event.kind !== "approval" && event.kind !== "question") return null;
  return State.approvals.hasPill(event.id) ? t("still waiting") : t("back in its terminal");
}

export function buildAway(actions: ViewActions): ViewHost {
  const card = h("div", { class: "card wash away-card" });
  card.style.setProperty("--wash", washRGBA("cyan"));
  const el = h("div", { class: "view" }, card);

  /** What was drawn: the same report, requests and language redraw nothing. */
  let drawn = "";
  let language = 0;
  onLanguageChange(() => (language += 1));

  const exists = (event: AwayEvent) => State.tasks.some((task) => task.id === event.id);

  /** OK: a request still waiting gets its card back, else the island folds. */
  const done = () => (State.pendingApproval ? actions.setView(State.defaultView()) : actions.collapse());

  /** A line opens its pill (one with a request still waiting opens on its card). */
  const open = (event: AwayEvent) => {
    if (!exists(event)) return;
    actions.setFocus(event.id);
    if (State.view === "away") actions.setView("overview");
  };

  function line(event: AwayEvent): HTMLElement {
    const status = requestStatus(event);
    return h("button", { class: exists(event) ? "away-line" : "away-line gone", onclick: () => open(event) },
      dot(event.color, 8),
      h("span", { class: "n", text: event.name }),
      h("span", { class: "what", text: whatHappened(event.kind) }),
      status ? h("span", { class: "status", text: status }) : null,
    );
  }

  function sync() {
    const report = Away.report;
    if (!report) return;
    const signature = JSON.stringify([
      language,
      report.minutes,
      report.events.map((e) => [e.id, e.kind, State.approvals.hasPill(e.id), exists(e)]),
    ]);
    if (signature === drawn) return;
    drawn = signature;

    const shown = report.events.slice(0, MAX_LINES);
    const more = report.events.length - shown.length;
    clear(card);
    card.append(
      h("div", { class: "stack away-stack" },
        h("div", { class: "away-head" },
          h("span", { class: "away-title", text: t("While you were away") }),
          h("span", { class: "away-range", text: t("Away for {time}", { time: formatDuration(report.minutes) }) }),
          h("span", { class: "grow" }),
          h("div", { class: "actions" },
            h("button", { class: "btn secondary", onclick: done }, h("span", { text: tl("OK") })),
          ),
        ),
        ...shown.map(line),
        more > 0 ? h("div", { class: "away-more", text: t("and {count} more", { count: more }) }) : null,
      ),
    );
  }

  return { el, sync };
}
