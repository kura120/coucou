// What the web answer card and the email cards share (views/websearch.ts,
// views/email.ts): the card with Mochi's place on its left, its head with the
// "Sample data" mark, the dots of a wait, and the island growing to what a
// card holds.

import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { VIEW_LAYOUTS, washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { State } from "../core/state";
import { language, tl, type Msg } from "../i18n/i18n";
import type { Answer, Ask } from "../voice/result";
import { buildAsk } from "./ask";
import type { BrainCall } from "../voice/tools";
import type { ViewActions } from "./views";

/** What a card asks of whoever runs the tools (views/voice-cards.ts). */
export interface CardDriver {
  /** Runs a tool and shows what comes of it. */
  run(call: BrainCall): void;
  /** The answer to the question on screen. */
  answer(answer: Answer): void;
  /** Closes the card; whatever was still on its way is dropped. */
  close(): void;
  /** Opens a link in the browser. */
  open(url: string): void;
  /** Mochi says it, when he speaks. */
  say(text: string): void;
}

/** The island's header and the insets around a card: a card is that much shorter than the island. */
const AROUND_CARD = 52;

/** The island grows or shrinks to a card of this height (the card's own, without the header). */
export function fit(view: IslandViewName, cardHeight: number, actions: ViewActions) {
  const height = Math.round(cardHeight) + AROUND_CARD;
  if (VIEW_LAYOUTS[view].height === height) return;
  VIEW_LAYOUTS[view].height = height;
  // Already on screen: the island moves to its new size.
  if (State.view === view && State.mode === "expanded") actions.setView(view);
}

export interface Shell {
  el: HTMLElement;
  /** Where the card's own content goes, under the head. */
  main: HTMLElement;
  /** The words at the left of the head: what the card is. */
  setTitle(icon: string, title: string | Msg, stroke?: number): void;
  setWash(wash: Wash): void;
  /** The island takes the height of what the card now holds. Call after drawing. */
  fit(view: IslandViewName, actions: ViewActions): void;
}

/** A card is never shorter than the island's usual one: Mochi needs the room. */
const SMALLEST_CARD = 108;
/** `.vc-body`'s padding and the gap under its head (voice-cards.css). */
const CARD_INSET = 12;
const HEAD_GAP = 8;

/**
 * A card as every sample card is laid out: a head — an icon, what the card
 * is, and "Sample data" at the far end — over the card's content, with room
 * on the left for Mochi.
 */
export function buildShell(name: string): Shell {
  const icon = h("span", { class: "vc-icon" });
  const title = h("span", { class: "vc-title" });
  const head = h("div", { class: "vc-head" }, icon, title, h("span", { class: "grow" }), sampleBadge());
  const main = h("div", { class: "vc-main" });
  const cardEl = h("div", { class: "card vc" }, h("div", { class: `vc-body ${name}` }, head, main));
  let shownIcon = "";
  // A field typed in while the island is still growing to its card is below
  // the island's edge, and the webview scrolls it into view — dragging the
  // header and the card up, for good. Nothing above a card ever scrolls.
  document.addEventListener?.(
    "scroll",
    (event) => {
      const scrolled = event.target as HTMLElement | null;
      if (scrolled?.scrollTop && typeof scrolled.contains === "function" && scrolled.contains(cardEl)) scrolled.scrollTop = 0;
    },
    true,
  );
  return {
    el: h("div", { class: "view" }, cardEl),
    main,
    setTitle(path, text, stroke) {
      if (path !== shownIcon) {
        shownIcon = path;
        clear(icon);
        icon.append(svg(path, 12, stroke ? { stroke } : {}));
      }
      const words = String(text);
      if (title.textContent !== words) title.textContent = words;
    },
    setWash(wash) {
      cardEl.classList.toggle("wash", wash != null);
      if (wash) cardEl.style.setProperty("--wash", washRGBA(wash));
    },
    fit(view, actions) {
      // What the card holds, as it is laid out: its width does not follow the island's.
      const inner = head.offsetHeight + main.offsetHeight;
      if (inner) fit(view, Math.max(SMALLEST_CARD, inner + HEAD_GAP + 2 * CARD_INSET), actions);
    },
  };
}

/** Said on every card that shows made-up data. */
export function sampleBadge(): HTMLElement {
  return h("span", { class: "vc-sample", text: tl("Sample data") });
}

/** Three dots that take turns, and a line beside them: something is being waited for. */
export function waiting(line: string): HTMLElement {
  return h(
    "div",
    { class: "vc-waiting" },
    h("span", { class: "vc-dots" }, h("i"), h("i"), h("i")),
    h("span", { class: "sub", text: line }),
  );
}

/** A red cross and what went wrong, as the voice result card says a failure. */
export function failure(line: string, detail = ""): HTMLElement {
  const mark = svg(ICONS.xmark, 13);
  mark.classList.add("vc-cross");
  return h(
    "div",
    { class: "vc-failure" },
    h("div", { class: "listening-head" }, mark, h("div", { class: "title", text: line })),
    detail ? h("div", { class: "detail", text: detail }) : null,
  );
}

export function button(label: string | Msg, kind: "primary" | "secondary", onClick: () => void, kbd?: string): HTMLButtonElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/**
 * When an email arrived, as short as it reads: the time for today, the day
 * of the week for the last six days, the date before that — in the
 * interface's language.
 */
export function whenShort(minutesAgo: number, now = new Date()): string {
  const at = new Date(now.getTime() - minutesAgo * 60_000);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const format = (options: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat(language(), options).format(at);
    } catch {
      return new Intl.DateTimeFormat("en", options).format(at);
    }
  };
  if (days <= 0) return format({ hour: "numeric", minute: "2-digit" });
  if (days < 7) return format({ weekday: "short" });
  return format({ day: "numeric", month: "short" });
}

/** The cards' own glyphs, on the 24 × 24 grid of views/icons.ts; all stroked. */
export const CARD_ICONS = {
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.4 15.4 20 20",
  mail: "M3.5 6.5h17v11h-17zM4 7l8 6.2L20 7",
  clip: "M19 11.6l-6.9 6.9a4 4 0 0 1-5.6-5.7l7.2-7.2a2.7 2.7 0 0 1 3.8 3.8l-7 7a1.3 1.3 0 0 1-1.9-1.9l6.3-6.3",
} as const;

/** Ctrl+Shift+1…9 on a list, Ctrl+Shift+1 / 2 on yes or no, Escape to drop: the answer a key means, or null. */
export function keyAnswer(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">, ask: Ask): Answer | null {
  if (event.key === "Escape") return { kind: "dropped" };
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null;
  const n = Number(/^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1] ?? 0);
  if (ask.kind === "choice") return ask.options[n - 1] ? { kind: "choice", id: ask.options[n - 1].id } : null;
  if (ask.kind === "yes_no") return n === 1 || n === 2 ? { kind: "yes_no", yes: n === 1 } : null;
  // A field confirms itself (views/ask.ts): Enter in it, or its button.
  return null;
}

export interface CardAsk {
  el: HTMLElement;
  show(ask: Ask): void;
  /** Nothing is asked any more: keys do nothing. */
  hide(): void;
  focus(): void;
}

/**
 * A question on a card itself, for a tool started from a card's own button
 * (Reply, Retry, Back) rather than by voice: the island's question component
 * (views/ask.ts) under the line that asks. In a voice turn the same question
 * goes up in the listening card instead, where it can also be answered aloud.
 * `up`: the card is on screen, so keys are meant for it.
 */
export function cardAsk(up: () => boolean, answer: (answer: Answer) => void): CardAsk {
  let current: Ask | null = null;
  /** Answers once: a second key or click on a question already answered does nothing. */
  const give = (given: Answer) => {
    if (!current) return;
    current = null;
    answer(given);
  };
  const question = h("div", { class: "vc-ask-question", dir: "auto" });
  const view = buildAsk(give, () => {}, () => {});
  window.addEventListener?.(
    "keydown",
    (event) => {
      if (!current || !up()) return;
      const given = keyAnswer(event, current);
      if (!given) return;
      event.preventDefault();
      event.stopPropagation();
      give(given);
    },
    true,
  );
  return {
    el: h("div", { class: "vc-ask" }, question, view.el),
    show(ask) {
      current = ask;
      question.textContent = ask.question;
      question.title = ask.question;
      view.sync(ask, ask.kind === "text" ? (ask.value ?? "") : "");
    },
    hide() {
      current = null;
    },
    focus: () => view.focus(),
  };
}
