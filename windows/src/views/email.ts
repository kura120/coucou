// The email cards, one view with a step at a time: which account, what to
// look for, the list, one message, and the card an email is prepared on.
// Today they show SAMPLE DATA (voice/tools-preview.ts): no mailbox is read
// and Send sends nothing — it says so.
//
// The compose card is the Mac's (MailView in IslandViewContent.swift): "New
// email", To, Subject, the text, Send and Cancel, plus which account it goes
// from and the attached file as a chip. Reading mail the Mac does not have.
// An email is only ever sent by a click on Send: no key, no word.

import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { t, tl } from "../i18n/i18n";
import type { Ask } from "../voice/result";
import type { BrainCall } from "../voice/tools";
import { SAMPLE_ACCOUNTS, type MailDraft, type MailListData, type MailMessage, type MailScope, type MailSummary } from "../voice/tools-preview";
import { CARD_ICONS, buildShell, button, cardAsk, failure, waiting, whenShort, type CardDriver } from "./sample";
import type { ViewActions, ViewHost } from "./views";

export type MailState =
  | { step: "idle" }
  | { step: "working"; line: string }
  /** Which account, recent or someone or a topic, who, what about, who to, what to say. */
  | { step: "asking"; ask: Ask }
  /** The emails found — none, when `data.messages` is empty. */
  | { step: "list"; data: MailListData }
  /** One email, opened. `back`: the list it was opened from. */
  | { step: "message"; message: MailMessage; back: MailListData | null }
  | { step: "compose"; draft: MailDraft }
  | { step: "failed"; line: string; detail: string; retry: BrainCall | null };

/** What the cards show. Set it with `show`; the island redraws. */
export const MailCard = {
  state: { step: "idle" } as MailState,
  /** Under the compose card's fields: what Send did, or why it did not. */
  note: { text: "", bad: false },
  /** Changes with every `show`, so a card is drawn once per state and not on every frame. */
  version: 0,
  show(next: MailState) {
    this.state = next;
    this.note = { text: "", bad: false };
    this.version += 1;
    State.notify();
  },
};

export function scopeLabel(scope: MailScope): string {
  if (scope.kind === "person") return t("From {name}", { name: scope.who });
  if (scope.kind === "topic") return t("About {topic}", { topic: scope.topic });
  return t("Recent emails");
}

export function buildEmail(actions: ViewActions, driver: CardDriver): ViewHost {
  const shell = buildShell("mail");
  const ask = cardAsk(
    () => State.view === "email" && State.mode === "expanded" && MailCard.state.step === "asking",
    (answer) => driver.answer(answer),
  );
  let drawn = -1;

  const close = (label = tl("Done")) => button(label, "secondary", () => driver.close());
  const clip = () => {
    const icon = svg(CARD_ICONS.clip, 11, { stroke: 2 });
    icon.classList.add("mail-clip");
    return icon;
  };

  // ── The list ────────────────────────────────────────────────────────────────

  function row(message: MailSummary): HTMLElement {
    return h(
      "button",
      {
        class: message.unread ? "mail-row unread" : "mail-row",
        title: message.subject,
        onclick: () => driver.run({ name: "read_email", arguments: { id: message.id } }),
      },
      h("span", { class: "mail-dot" }),
      h(
        "span",
        { class: "mail-lines" },
        h(
          "span",
          { class: "mail-top" },
          h("span", { class: "mail-from", dir: "auto", text: message.from.name || message.from.address }),
          message.attachment ? clip() : null,
          h("span", { class: "mail-when", text: whenShort(message.minutesAgo) }),
        ),
        h(
          "span",
          { class: "mail-bottom", dir: "auto" },
          h("span", { class: "mail-subject", text: message.subject }),
          h("span", { class: "mail-snippet", text: ` — ${message.snippet}` }),
        ),
      ),
    );
  }

  function list(data: MailListData) {
    shell.setTitle(CARD_ICONS.mail, `${data.account.name} · ${scopeLabel(data.scope)}`, 2);
    if (!data.messages.length) {
      shell.main.append(
        h("div", { class: "title", text: tl("No emails match.") }),
        h("div", { class: "sub vc-ltr", text: data.account.address }),
        h(
          "div",
          { class: "actions" },
          // Asks again what to look for, in the same account.
          button(tl("Back"), "primary", () => driver.run({ name: "check_email", arguments: { account: data.account.id } })),
          close(),
        ),
      );
      return;
    }
    const rows = h("div", { class: data.messages.length > 4 ? "mail-list fade" : "mail-list" }, ...data.messages.map(row));
    shell.main.append(rows);
  }

  // ── One message ─────────────────────────────────────────────────────────────

  function opened(message: MailMessage, back: MailListData | null) {
    const account = SAMPLE_ACCOUNTS.find((a) => a.id === message.account);
    shell.setTitle(CARD_ICONS.mail, account?.name ?? t("Email"), 2);
    const goBack = () => (back ? MailCard.show({ step: "list", data: back }) : driver.close());
    shell.main.append(
      h(
        "div",
        { class: "mail-open-head" },
        h("button", { class: "icon-btn mail-back", title: tl("Back"), onclick: goBack }, svg(ICONS.chevronLeft, 9, { stroke: 2.6 })),
        h("div", { class: "title one-line", dir: "auto", title: message.subject, text: message.subject }),
      ),
      h(
        "div",
        { class: "mail-meta" },
        h("span", { class: "mail-from", dir: "auto", text: message.from.name }),
        h("span", { class: "mail-address vc-ltr", text: message.from.address }),
        h("span", { class: "grow" }),
        h("span", { class: "mail-when", text: whenShort(message.minutesAgo) }),
      ),
      h("div", { class: "mail-text", dir: "auto", text: message.body }),
    );
    if (message.attachment) {
      shell.main.append(h("div", { class: "mail-chips" }, h("span", { class: "mail-chip" }, clip(), h("span", { class: "mail-file", text: message.attachment }))));
    }
    shell.main.append(
      h(
        "div",
        { class: "actions" },
        button(tl("Reply"), "primary", () =>
          driver.run({
            name: "draft_email",
            arguments: { to: message.from.address, subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, account: message.account },
          })),
        close(),
      ),
    );
  }

  // ── Preparing an email ──────────────────────────────────────────────────────

  function compose(draft: MailDraft) {
    shell.setTitle(CARD_ICONS.mail, t("New email"), 2);
    let from = draft.from;
    const fromChip = h("button", { class: "mail-chip from" });
    const showFrom = () => {
      clear(fromChip);
      fromChip.append(h("span", { text: t("From {name}", { name: from.name }) }), h("span", { class: "mail-address vc-ltr", text: from.address }));
    };
    // Another account: the next one, round and round.
    fromChip.addEventListener("click", () => {
      from = SAMPLE_ACCOUNTS[(SAMPLE_ACCOUNTS.findIndex((a) => a.id === from.id) + 1) % SAMPLE_ACCOUNTS.length];
      showFrom();
    });
    showFrom();

    const field = (label: ReturnType<typeof tl>, value: string, placeholder: string) => {
      const input = h("input", { class: "mail-input", type: "text", dir: "auto", spellcheck: "false", placeholder });
      input.value = value;
      return { input, el: h("label", { class: "mail-field" }, h("span", { class: "mail-label", text: label }), input) };
    };
    const to = field(tl("To"), draft.to, "name@example.com");
    if (draft.toName) to.input.title = draft.toName;
    const subject = field(tl("Subject"), draft.subject, "");
    const body = h("textarea", { class: "mail-body", dir: "auto", spellcheck: "false" });
    body.value = draft.body;

    const chips = h("div", { class: "mail-chips" }, fromChip);
    if (draft.attachment) {
      const chip = h("span", { class: "mail-chip" }, clip(), h("span", { class: "mail-file", text: draft.attachment }));
      chip.append(h(
        "button",
        { class: "mail-chip-x", title: tl("Remove attachment"), onclick: () => chip.remove() },
        svg(ICONS.xmark, 8),
      ));
      chips.append(chip);
    }

    const note = h("div", { class: "mail-note" });
    const say = (text: string, bad: boolean) => {
      MailCard.note = { text, bad };
      note.textContent = text;
      note.classList.toggle("bad", bad);
      shell.fit("email", actions);
    };
    // The one thing that could ever send: a click here. In this build it says what it is.
    const send = button(tl("Send"), "primary", () => {
      if (!to.input.value.trim()) return say(t("Missing recipient."), true);
      say(t("Sample: nothing was sent."), false);
    });

    shell.main.append(to.el, subject.el, body, chips, note, h("div", { class: "actions" }, send, close(tl("Cancel"))));
    if (MailCard.note.text) say(MailCard.note.text, MailCard.note.bad);
  }

  function draw() {
    const state = MailCard.state;
    clear(shell.main);
    ask.hide();
    shell.setTitle(CARD_ICONS.mail, t("Email"), 2);
    shell.setWash(state.step === "failed" ? "red" : null);
    switch (state.step) {
      case "idle":
        break;
      case "working":
        shell.main.append(waiting(state.line));
        break;
      case "asking":
        ask.show(state.ask);
        shell.main.append(ask.el);
        window.setTimeout(() => ask.focus(), 150);
        break;
      case "list":
        list(state.data);
        break;
      case "message":
        opened(state.message, state.back);
        break;
      case "compose":
        compose(state.draft);
        break;
      case "failed": {
        const retry = state.retry;
        shell.main.append(
          failure(state.line, state.detail),
          h("div", { class: "actions" }, ...(retry ? [button(tl("Retry"), "primary", () => driver.run(retry))] : []), close()),
        );
        break;
      }
    }
    shell.fit("email", actions);
  }

  return {
    el: shell.el,
    sync() {
      // Drawn once per state: a field rebuilt while it is typed in would lose its text.
      if (drawn === MailCard.version) return;
      drawn = MailCard.version;
      draw();
    },
  };
}
