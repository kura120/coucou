// A question Mochi has on screen (voice/result.ts `Ask`), in one of three
// shapes: a numbered list, two buttons, or a text field that is dictated
// into and confirmed. One component for every question — the turn's, a
// tool's, a model's — so they all answer the same way: a click, the key shown
// beside it, or the voice.
//
// It shows and reports; it decides nothing. `onAnswer` gets the answer, and
// `onDraft` what the field holds when it is edited by hand.

import { t } from "../i18n/i18n";
import type { Answer, Ask } from "../voice/result";
import { h } from "./dom";

export interface AskView {
  el: HTMLElement;
  /** Shows this question, or nothing. `draft`: what the text field holds. */
  sync(ask: Ask | null, draft: string): void;
  /** Puts the caret in the text field, when there is one. */
  focus(): void;
  /** How tall the question is as shown, for the island to make room. */
  height(): number;
}

/** One line of a choice, in pixels: the island grows by this for each. */
export const ASK_ROW = 30;
/** Two buttons, or the field with its button. */
export const ASK_BAR = 40;

/** How much room a question needs under the line that asks it. */
export function askRoom(ask: Ask | null): number {
  if (!ask) return 0;
  return ask.kind === "choice" ? ask.options.length * ASK_ROW + 6 : ASK_BAR;
}

const key = (label: string) => h("kbd", { class: "ask-key", text: label });

export function buildAsk(onAnswer: (answer: Answer) => void, onDraft: (value: string) => void, onFocus: () => void): AskView {
  const el = h("div", { class: "ask" });
  let shown: Ask | null = null;
  let field: HTMLInputElement | null = null;

  const draw = (ask: Ask, draft: string) => {
    el.replaceChildren();
    field = null;
    el.dataset.kind = ask.kind;
    if (ask.kind === "choice") {
      ask.options.forEach((option, i) => {
        const row = h(
          "button",
          { class: "ask-option", type: "button", onclick: () => onAnswer({ kind: "choice", id: option.id }) },
          h("span", { class: "ask-number", text: String(i + 1) }),
          h("span", { class: "ask-label", text: option.label }),
          ...(option.hint ? [h("span", { class: "ask-hint", text: option.hint })] : []),
          key(`Ctrl+Shift+${i + 1}`),
        );
        el.append(row);
      });
    } else if (ask.kind === "yes_no") {
      el.append(
        h("button", { class: "ask-button primary", type: "button", onclick: () => onAnswer({ kind: "yes_no", yes: true }) },
          h("span", { text: ask.yes || t("Yes") }), key("Ctrl+Shift+1")),
        h("button", { class: "ask-button", type: "button", onclick: () => onAnswer({ kind: "yes_no", yes: false }) },
          h("span", { text: ask.no || t("No") }), key("Ctrl+Shift+2")),
      );
    } else {
      field = h("input", { class: "ask-field", type: "text", spellcheck: "false", placeholder: ask.placeholder ?? "" }) as HTMLInputElement;
      field.value = draft;
      field.addEventListener("input", () => onDraft(field?.value ?? ""));
      // The island has no keyboard until it is asked for: a click in the field asks.
      field.addEventListener("pointerdown", onFocus);
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && field?.value.trim()) onAnswer({ kind: "text", value: field.value.trim() });
        if (event.key === "Escape") onAnswer({ kind: "dropped" });
        event.stopPropagation();
      });
      const confirm = h("button", {
        class: "ask-button primary", type: "button",
        onclick: () => {
          if (field?.value.trim()) onAnswer({ kind: "text", value: field.value.trim() });
        },
      }, h("span", { text: t("Confirm") }), key("Ctrl+Shift+Enter"));
      el.append(field, confirm);
    }
  };

  return {
    el,
    sync(ask, draft) {
      el.classList.toggle("on", ask != null);
      if (!ask) {
        shown = null;
        return;
      }
      // Drawn again only for another question: what is being typed is not replaced under the hand.
      if (ask !== shown) {
        shown = ask;
        draw(ask, draft);
      } else if (field && field.value !== draft && document.activeElement !== field) {
        field.value = draft;
      } else if (field && field.value !== draft && draft.startsWith(field.value)) {
        // Dictated while the caret is in it: what was said is added.
        field.value = draft;
      }
    },
    focus() {
      field?.focus();
    },
    height: () => askRoom(shown),
  };
}
