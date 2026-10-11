// The web answer card and the email cards join the island here, and the
// sample tools (voice/tools-preview.ts) are given somewhere to show: a tool
// starts → its card says it is working → what it returned is drawn — a
// question, a list, an email to check, a failure. This is a small stand-in
// for the turn loop (voice/loop.ts, the main session's): when the loop runs
// these tools, `host` below is what it replaces.
//
// In the browser preview, `coucouPreview` in the console shows every state
// without a microphone; see `previewConsole`.

import { Bridge, IS_TAURI } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { State } from "../core/state";
import { language, onLanguageChange, setLanguage, t, type Language } from "../i18n/i18n";
import type { Ask, ToolResult } from "../voice/result";
import { MAX_SPOKEN } from "../voice/result";
import type { BrainCall } from "../voice/tools";
import {
  SAMPLE_ACCOUNTS, SAMPLE_MESSAGES, SAMPLE_MORE, SAMPLE_SOURCES, dropPreview, heardPreview, isPreviewTool, previewTiming,
  runPreview, runPreviewTool, searchUrl, setPreviewHost, withAnswer, workingLine,
  type MailDraft, type MailListData, type MailMessage, type MailSummary, type WebAnswerData,
} from "../voice/tools-preview";
import { MailCard, buildEmail } from "./email";
import type { CardDriver } from "./sample";
import type { ViewActions, ViewHost } from "./views";
import { WebCard, buildWebAnswer } from "./websearch";

const viewOf = (tool: string): IslandViewName => (tool === "web_search" ? "webAnswer" : "email");

/** The first sentence of a text: what Mochi says of a longer answer. */
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return (end < 0 ? text : text.slice(0, end + 1)).trim();
}

/** Adds the two views to the island's, and wires the sample tools to them. */
export function registerVoiceCards(views: Map<IslandViewName, ViewHost>, actions: ViewActions) {
  /** The question on screen, and the call it was asked for. */
  let asked: { call: BrainCall; result: ToolResult } | null = null;
  /** The list a message was opened from, to go back to. */
  let lastList: MailListData | null = null;

  const open = (view: IslandViewName) => {
    if (State.view !== view || State.mode !== "expanded") actions.setView(view);
  };

  /** One of the two cards is on screen with something on it. */
  const cardUp = () =>
    State.mode === "expanded" &&
    ((State.view === "webAnswer" && WebCard.state.phase !== "idle") || (State.view === "email" && MailCard.state.step !== "idle"));
  /** It asks something, or has fields: keys are meant for it. */
  const wantsKeys = () =>
    (State.view === "webAnswer" && WebCard.state.phase === "asking") ||
    (State.view === "email" && (MailCard.state.step === "asking" || MailCard.state.step === "compose"));
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
    if (State.view !== "webAnswer" && State.view !== "email" && asked) {
      asked = null;
      dropPreview();
    }
  });

  const driver: CardDriver = {
    run: (call) => void runPreview(call),
    answer(answer) {
      const next = asked ? withAnswer(asked.call, asked.result, answer) : null;
      asked = null;
      if (next) void runPreview(next);
      else driver.close();
    },
    close() {
      dropPreview();
      asked = null;
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
      // English only, like the rest of Mochi's voice (island/voice.ts `sayResult`).
      if (!State.settings.voice.speak || language() !== "en" || !text) return;
      void Bridge.voiceSay(text.slice(0, MAX_SPOKEN));
    },
  };

  views.set("webAnswer", buildWebAnswer(actions, driver));
  views.set("email", buildEmail(actions, driver));

  setPreviewHost({
    working(call) {
      asked = null;
      const line = workingLine(call);
      // The view first: a card set while the island is elsewhere would be taken for one that was left.
      open(viewOf(call.name));
      if (call.name === "web_search") WebCard.show({ phase: "working", question: String(call.arguments?.query ?? ""), line });
      else MailCard.show({ step: "working", line });
    },
    show(call, result) {
      open(viewOf(call.name));
      asked = result.status === "ask" ? { call, result } : null;
      const data = (result.data ?? {}) as Record<string, unknown>;
      if (call.name === "web_search") {
        if (result.status === "ask" && result.ask) WebCard.show({ phase: "asking", ask: result.ask });
        else if (result.status === "done") {
          const answer = data as unknown as WebAnswerData;
          WebCard.show({ phase: "done", data: answer });
          driver.say(firstSentence(answer.answer) || result.line);
        } else {
          WebCard.show({ phase: "failed", question: String(call.arguments?.query ?? ""), line: result.line, detail: result.detail ?? "" });
        }
      } else if (result.status === "ask" && result.ask) {
        MailCard.show({ step: "asking", ask: result.ask });
        driver.say(result.ask.question);
      } else if (result.status !== "done") {
        MailCard.show({ step: "failed", line: result.line, detail: result.detail && result.detail !== result.line ? result.detail : "", retry: call });
      } else if (call.name === "check_inbox") {
        lastList = data as unknown as MailListData;
        MailCard.show({ step: "list", data: lastList });
        driver.say(result.line);
      } else if (call.name === "read_message") {
        MailCard.show({ step: "message", message: data.message as MailMessage, back: lastList });
      } else {
        MailCard.show({ step: "compose", draft: data.draft as MailDraft });
        driver.say(result.line);
      }
    },
  });

  // What a card says in words of its own is drawn again in the new language.
  onLanguageChange(() => {
    WebCard.version += 1;
    MailCard.version += 1;
  });

  if (!IS_TAURI && typeof window !== "undefined") {
    Object.assign(window, { coucouPreview: previewConsole(open) });
  }
}

// ── The browser preview's console ─────────────────────────────────────────────

const WEB_STATES = ["working", "ask", "done", "more", "long", "many", "rtl", "empty", "error"] as const;
const MAIL_STATES = [
  "accounts", "narrow", "who", "many-accounts", "loading", "list", "many", "empty", "error", "message", "long", "rtl",
  "which", "compose", "attachment", "long-compose", "sent",
] as const;

/** The email states the console draws itself; the others run a sample tool, which opens the card. */
const MAIL_SHOWN: ReadonlySet<string> = new Set(MAIL_STATES.filter((s) => !["accounts", "narrow", "who", "which", "error"].includes(s)));

const LONG = "The long walk is on again next month if the weather holds, and this sentence is here to be long. ";

function sampleList(scope: MailListData["scope"] = { kind: "recent" }, account = SAMPLE_ACCOUNTS[0]): MailListData {
  const messages: MailSummary[] = SAMPLE_MESSAGES.filter((m) => m.account === account.id).map(({ body: _body, ...rest }) => rest);
  return { account, scope, messages };
}

const sampleDraft = (extra: Partial<MailDraft> = {}): MailDraft => ({
  from: SAMPLE_ACCOUNTS[0],
  to: "tana.rao@example.com",
  toName: "Tana Rao",
  subject: "The build is ready",
  body: "Hi Tana,\n\nThe build is ready.\n\nBest,\nAlex",
  ...extra,
});

/**
 * `coucouPreview` in the browser preview's console. Nothing is heard and
 * nothing is fetched: these put a card in a state, or run the sample tools.
 *
 *   coucouPreview.say("check my emails")          a fixed sentence, as if heard
 *   coucouPreview.tool("write_draft", { to: "tana" })   a call, as a model makes one
 *   coucouPreview.web("done")       one of coucouPreview.states.web
 *   coucouPreview.email("list")     one of coucouPreview.states.email
 *   coucouPreview.language("ar")    the interface language (Arabic reads right to left)
 *   coucouPreview.delay(3000)       how long the stubs pretend to work, in ms
 */
function previewConsole(open: (view: IslandViewName) => void) {
  const web = (question: string, extra: Partial<WebAnswerData> = {}): WebAnswerData => ({
    question,
    answer: "This is a sample answer: no search was made. Mount Everest is 8,849 metres high, about 29,032 feet.",
    more: SAMPLE_MORE,
    sources: [...SAMPLE_SOURCES],
    searchUrl: searchUrl(question),
    ...extra,
  });
  const choice = (question: string, options: { id: string; label: string; hint?: string }[]): Ask => ({ kind: "choice", question, options });

  return {
    states: { web: WEB_STATES, email: MAIL_STATES },
    say: (sentence: string) => heardPreview(sentence),
    tool(name: string, args: Record<string, unknown> = {}) {
      if (!isPreviewTool(name)) return `not one of the sample tools: ${name}`;
      void runPreview({ name, arguments: args });
      return "ok";
    },
    /** The result a tool returns, without showing anything. */
    result: (name: string, args: Record<string, unknown> = {}) => runPreviewTool({ name, arguments: args }),
    language: (code: Language) => setLanguage(code),
    delay(ms: number) {
      previewTiming.delayMs = Math.max(0, Number(ms) || 0);
    },
    web(state: (typeof WEB_STATES)[number] = "done") {
      const question = "how tall is mount everest";
      if (state !== "ask" && state !== "error") open("webAnswer");
      switch (state) {
        case "working": WebCard.show({ phase: "working", question, line: workingLine({ name: "web_search", arguments: {} }) }); break;
        case "ask": void runPreview({ name: "web_search", arguments: {} }); return;
        case "done": WebCard.show({ phase: "done", data: web(question) }); break;
        case "more":
          WebCard.show({ phase: "done", data: web(question) });
          WebCard.more = true;
          break;
        case "long":
          WebCard.show({ phase: "done", data: web(`${question}, and how was that measured, and by whom, and has it changed since the first survey`, { answer: LONG.repeat(6), more: LONG.repeat(8) }) });
          break;
        case "many":
          WebCard.show({
            phase: "done",
            data: web(question, {
              sources: Array.from({ length: 9 }, (_, i) => ({ ...SAMPLE_SOURCES[i % 3], site: i % 2 ? SAMPLE_SOURCES[i % 3].site : `a-rather-long-host-name-${i + 1}.example.org` })),
            }),
          });
          break;
        case "rtl":
          WebCard.show({
            phase: "done",
            data: web("كم يبلغ ارتفاع جبل إيفرست", { answer: "هذه إجابة تجريبية: لم يُجرَ أي بحث. يبلغ ارتفاع جبل إيفرست 8,849 مترًا وفق المسح المشترك بين الصين ونيبال عام 2020.", more: "" }),
          });
          break;
        case "empty": WebCard.show({ phase: "done", data: web("nothing", { answer: "", more: "", sources: [] }) }); break;
        case "error": void runPreview({ name: "web_search", arguments: { query: question, fail: true } }); return;
      }
    },
    email(state: (typeof MAIL_STATES)[number] = "list") {
      const message = (id: string) => SAMPLE_MESSAGES.find((m) => m.id === id) as MailMessage;
      if (MAIL_SHOWN.has(state)) open("email");
      switch (state) {
        case "accounts": void runPreview({ name: "check_inbox", arguments: {} }); return;
        case "narrow": void runPreview({ name: "check_inbox", arguments: { account: "work" } }); return;
        case "who": void runPreview({ name: "check_inbox", arguments: { account: "work", scope: "person" } }); return;
        case "which": void runPreview({ name: "write_draft", arguments: { to: "tana" } }); return;
        case "error": void runPreview({ name: "check_inbox", arguments: { account: "work", scope: "recent", fail: true } }); return;
        case "many-accounts":
          MailCard.show({
            step: "asking",
            ask: choice(t("Which email account do you want to use?"), Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `Account ${i + 1}`, hint: `account.number.${i + 1}@example.com` }))),
          });
          break;
        case "loading": MailCard.show({ step: "working", line: workingLine({ name: "check_inbox", arguments: { account: "work" } }) }); break;
        case "list": MailCard.show({ step: "list", data: sampleList() }); break;
        case "many": {
          const base = sampleList();
          const messages = Array.from({ length: 40 }, (_, i) => ({ ...base.messages[i % base.messages.length], id: `x${i}`, minutesAgo: 30 + i * 400 }));
          MailCard.show({ step: "list", data: { ...base, messages } });
          break;
        }
        case "empty": MailCard.show({ step: "list", data: { ...sampleList({ kind: "person", who: "nobody" }), messages: [] } }); break;
        case "message": MailCard.show({ step: "message", message: message("m01"), back: sampleList({ kind: "recent" }, SAMPLE_ACCOUNTS[1]) }); break;
        case "long": MailCard.show({ step: "message", message: { ...message("m04"), body: `${message("m04").body}\n\n${LONG.repeat(12)}` }, back: sampleList() }); break;
        case "rtl": MailCard.show({ step: "message", message: message("m06"), back: sampleList() }); break;
        case "compose": MailCard.show({ step: "compose", draft: sampleDraft() }); break;
        case "attachment": MailCard.show({ step: "compose", draft: sampleDraft({ attachment: "release-notes-0.4.1.md" }) }); break;
        case "long-compose":
          MailCard.show({
            step: "compose",
            draft: sampleDraft({
              subject: LONG.repeat(2),
              body: `Hi Tana,\n\n${LONG.repeat(14)}\n\nBest,\nAlex`,
              attachment: "a-file-with-a-very-long-name-that-does-not-fit-on-one-line-of-the-card-2026-10-11.final.v3.pdf",
            }),
          });
          break;
        case "sent":
          MailCard.show({ step: "compose", draft: sampleDraft() });
          MailCard.note = { text: t("Sample: nothing was sent."), bad: false };
          break;
      }
    },
  };
}
