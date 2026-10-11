// SAMPLE DATA ONLY. The four tools behind the web answer card and the email
// cards (views/websearch.ts, views/email.ts), as stubs: each waits a moment
// and returns a ToolResult (voice/result.ts) built from the fixed data below.
// Nothing here searches, reads a mailbox, sends, or touches the network —
// there is no fetch, no key and no account in this file. It exists so the
// cards can be driven and looked at while the real tools are designed
// (doc/voice-web-email-design.md).
//
// Three ways in:
// - a few fixed sentences (`previewSentence`): "search the web for …",
//   "check my emails", "write an email to …";
// - a model, as tools (`previewToolSchemas`, `openPreview` from voice/tools.ts);
// - the browser preview's console (`coucouPreview`, views/voice-cards.ts).
//
// A tool that needs to know more returns `ask`; the answer is put into its
// arguments and the tool is called again (`withAnswer`) — here by code, in
// the real thing by the model. In a voice turn the question goes up in the
// listening card (VoiceConversation.askUser: a click, Ctrl+Shift+number, or
// said); started from a card's own button, it is asked on that card.

import { t } from "../i18n/i18n";
import { normalise } from "./entity";
import { asks, done, failed, notFoundResult, type Answer, type Ask, type ToolResult } from "./result";
import type { BrainCall } from "./tools";

// ── The sample data ───────────────────────────────────────────────────────────

export interface MailAccount {
  id: string;
  /** What the user called it: "Work". */
  name: string;
  address: string;
}

export interface MailSummary {
  id: string;
  account: string;
  from: { name: string; address: string };
  subject: string;
  /** The first line of the text. */
  snippet: string;
  /** How long ago it arrived, in minutes: the card shows a time or a day. */
  minutesAgo: number;
  unread: boolean;
  /** The name of the attached file, if one is. */
  attachment?: string;
}

export interface MailMessage extends MailSummary {
  body: string;
}

export interface MailContact {
  name: string;
  address: string;
}

export interface WebSource {
  title: string;
  /** The host, as shown on the link. */
  site: string;
  url: string;
}

export const SAMPLE_ACCOUNTS: readonly MailAccount[] = [
  { id: "personal", name: "Personal", address: "alex@example.com" },
  { id: "work", name: "Work", address: "alex.martin@example.org" },
];

export const SAMPLE_CONTACTS: readonly MailContact[] = [
  { name: "Tana Rao", address: "tana.rao@example.com" },
  { name: "Tana Meyer", address: "tana.meyer@example.org" },
  { name: "Louis Bernard", address: "louis@example.com" },
  { name: "Priya Shah", address: "priya.shah@example.org" },
];

const HOUR = 60;
const DAY = 24 * HOUR;

export const SAMPLE_MESSAGES: readonly MailMessage[] = [
  {
    id: "m01", account: "work", from: { name: "Priya Shah", address: "priya.shah@example.org" },
    subject: "Release notes for 0.4.1", snippet: "Draft attached, can you read it before noon?", minutesAgo: 12, unread: true,
    attachment: "release-notes-0.4.1.md",
    body: "Hi Alex,\n\nThe draft of the release notes is attached. Can you read it before noon? The part about the phone link is the one I am least sure of.\n\nThanks,\nPriya",
  },
  {
    id: "m02", account: "personal", from: { name: "Tana Rao", address: "tana.rao@example.com" },
    subject: "Saturday", snippet: "Still on for the market at ten?", minutesAgo: 47, unread: true,
    body: "Still on for the market at ten? I can bring the big bag this time.\n\nTana",
  },
  {
    id: "m03", account: "work", from: { name: "GitHub", address: "notifications@example.org" },
    subject: "[coucou] Pull request #43 was approved", snippet: "louis approved this pull request.", minutesAgo: 2 * HOUR + 5, unread: true,
    body: "louis approved this pull request.\n\nMerge upstream: macOS 0.3.0, Windows and Linux 0.4.0, the phone link.",
  },
  {
    id: "m04", account: "personal", from: { name: "Louis Bernard", address: "louis@example.com" },
    subject: "Photos from the weekend, and a question about the invoice you sent me last month that I still cannot find anywhere in my inbox",
    snippet: "Here they are at last. About the invoice: was it the October one or the one before? I looked everywhere and could not find it, so if you could send it once more that would save me an afternoon.",
    minutesAgo: 5 * HOUR, unread: false, attachment: "weekend.zip",
    body: "Here they are at last.\n\nAbout the invoice: was it the October one or the one before? I looked everywhere and could not find it, so if you could send it once more that would save me an afternoon.\n\nAlso: the long walk is on again next month if the weather holds. Bring proper shoes this time, the path past the second bridge was under water for most of September and nobody had told us. I have asked the others; four have said yes, two maybe, and one has said nothing at all, which I take to be a no.\n\nLouis",
  },
  {
    id: "m05", account: "work", from: { name: "Tana Meyer", address: "tana.meyer@example.org" },
    subject: "Invoice 2026-104", snippet: "Please find the invoice for September attached.", minutesAgo: 8 * HOUR, unread: false,
    attachment: "invoice-2026-104.pdf",
    body: "Hello,\n\nPlease find the invoice for September attached. Payment is due within thirty days.\n\nKind regards,\nTana Meyer",
  },
  {
    id: "m06", account: "personal", from: { name: "سارة العلي", address: "sara@example.com" },
    subject: "موعد الأسبوع القادم", snippet: "مرحبا أليكس، هل يناسبك يوم الثلاثاء في الساعة الثالثة؟", minutesAgo: DAY + 2 * HOUR, unread: true,
    body: "مرحبا أليكس،\n\nهل يناسبك يوم الثلاثاء في الساعة الثالثة؟ المكان نفسه كالمرة السابقة.\n\nمع التحية،\nسارة",
  },
  {
    id: "m07", account: "work", from: { name: "Vercel", address: "notifications@example.org" },
    subject: "Deployment failed: coucou-site", snippet: "The build of main stopped at step 3 of 5.", minutesAgo: DAY + 6 * HOUR, unread: false,
    body: "The build of main stopped at step 3 of 5.\n\nError: Cannot find module './legal'.",
  },
  {
    id: "m08", account: "personal", from: { name: "City Library", address: "desk@example.com" },
    subject: "Two books are due on Friday", snippet: "You can renew them once from your account.", minutesAgo: 2 * DAY, unread: false,
    body: "Two books are due on Friday. You can renew them once from your account.",
  },
  {
    id: "m09", account: "personal", from: { name: "Tana Rao", address: "tana.rao@example.com" },
    subject: "Re: the recipe", snippet: "Twice the garlic, and it wants ten more minutes.", minutesAgo: 3 * DAY, unread: false,
    body: "Twice the garlic, and it wants ten more minutes than the book says.\n\nTana",
  },
  {
    id: "m10", account: "work", from: { name: "Priya Shah", address: "priya.shah@example.org" },
    subject: "Standup moved to 9:30", snippet: "From Monday, for the rest of the month.", minutesAgo: 4 * DAY, unread: false,
    body: "From Monday, for the rest of the month. Same room.",
  },
  {
    id: "m11", account: "personal", from: { name: "Rail Tickets", address: "tickets@example.com" },
    subject: "Your ticket for 24 October", snippet: "Coach 7, seat 42. Departure 08:14.", minutesAgo: 6 * DAY, unread: false,
    attachment: "ticket.pdf",
    body: "Coach 7, seat 42. Departure 08:14, arrival 10:52. Your ticket is attached.",
  },
  {
    id: "m12", account: "personal", from: { name: "Louis Bernard", address: "louis@example.com" },
    subject: "Happy birthday!", snippet: "A day late, as always.", minutesAgo: 9 * DAY, unread: false,
    body: "A day late, as always. Dinner is on me next time.\n\nLouis",
  },
];

/** What the web answer card shows; the answer is the same whatever was asked. */
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

export const SAMPLE_ANSWER =
  "This is a sample answer: no search was made. Mount Everest is 8,849 metres high, about 29,032 feet, by the survey China and Nepal published together in 2020.";
export const SAMPLE_MORE =
  "That figure counts the snow and ice on top; the rock underneath is a few metres lower. Earlier surveys gave 8,848 metres, and the summit still rises by a few millimetres a year as the Indian plate pushes north.";
export const SAMPLE_SOURCES: readonly WebSource[] = [
  { title: "Mount Everest", site: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Mount_Everest" },
  { title: "Mount Everest | Height, Location, Map, Facts", site: "britannica.com", url: "https://www.britannica.com/place/Mount-Everest" },
  { title: "Mount Everest (Q513)", site: "wikidata.org", url: "https://www.wikidata.org/wiki/Q513" },
];

/** "Open search" hands the question to the browser. Which engine is the user's to choose (design, question 2). */
export const searchUrl = (question: string) => `https://duckduckgo.com/?q=${encodeURIComponent(question)}`;

export type MailScope = { kind: "recent" } | { kind: "person"; who: string } | { kind: "topic"; topic: string };

export interface MailListData {
  account: MailAccount;
  scope: MailScope;
  messages: MailSummary[];
}

export interface MailDraft {
  from: MailAccount;
  to: string;
  /** The contact's name when the address came from one. */
  toName: string;
  subject: string;
  body: string;
  attachment?: string;
}

// ── The tools ─────────────────────────────────────────────────────────────────

export const PREVIEW_TOOL_NAMES = ["web_search", "check_email", "read_email", "draft_email"] as const;
export type PreviewToolName = (typeof PREVIEW_TOOL_NAMES)[number];

export const isPreviewTool = (name: string): name is PreviewToolName => (PREVIEW_TOOL_NAMES as readonly string[]).includes(name);

/** How long a stub pretends to work. The tests set it to 0. */
export const previewTiming = { delayMs: 900 };

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, previewTiming.delayMs));
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** A question, and which argument its answer fills (`needs`): what a model is told is missing. */
const needs = (argument: string, ask: Ask): ToolResult => ({ ...asks(ask), data: { needs: argument } });

/** Every result says it is a sample, so a model never passes one off as real. */
const SAMPLE_NOTE = "SAMPLE DATA: nothing was searched, read or sent.";

function fn(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const has = (spoken: string, words: readonly string[]) => words.some((w) => ` ${spoken} `.includes(` ${w} `));

/**
 * The sample tools a sentence may be about: those whose words it has, as
 * voice/tools-app.ts does for the app's own — a small model given every tool
 * for every sentence picks worse.
 */
export function previewToolsFor(said: string): unknown[] {
  const spoken = normalise(said);
  const wanted = new Set<string>();
  if (has(spoken, ["web", "internet", "online", "search", "look up", "google"])) wanted.add("web_search");
  if (has(spoken, ["email", "emails", "e mail", "e mails", "mail", "mails", "inbox"])) wanted.add("check_email").add("read_email").add("draft_email");
  return (previewToolSchemas() as { function: { name: string } }[]).filter((tool) => wanted.has(tool.function.name));
}

/** The four tools as a model is given them, in the format of voice/tools.ts. */
export function previewToolSchemas(): unknown[] {
  return [
    fn("web_search", "Look something up on the web and show a short answer with its sources. For questions about the world, not about this app.", {
      query: { type: "string", description: "What to look up, in the user's words." },
    }, ["query"]),
    fn("check_email", "Show the user's emails. Leave out what the user did not say: the tool asks which account, and whether recent emails, a person or a topic.", {
      account: { type: "string", enum: SAMPLE_ACCOUNTS.map((a) => a.id) },
      scope: { type: "string", enum: ["recent", "person", "topic"] },
      who: { type: "string", description: "The sender to look for, for scope 'person'." },
      topic: { type: "string", description: "The words to look for, for scope 'topic'." },
    }),
    fn("read_email", "Open one email from the list that check_email returned.", { id: { type: "string" } }, ["id"]),
    fn("draft_email", "Prepare an email on a card for the user to check. It is never sent by you: only a click on the card sends. Leave out what the user did not say.", {
      to: { type: "string", description: "A contact's name or an email address, as the user said it." },
      about: { type: "string", description: "What the email should say, in the user's words." },
      subject: { type: "string" },
      attachment: { type: "string", description: "The name of a file the user asked to attach." },
    }),
  ];
}

function webSearch(a: Record<string, unknown>): ToolResult {
  const question = str(a.query).slice(0, 200);
  if (!question) return needs("query", { kind: "text", question: t("What should I look up?") });
  // Two words make the other states reachable by voice: "search the web for nothing", "… for error".
  if (a.fail === true || /^(error|failure)$/.test(normalise(question))) {
    return failed(t("Couldn't search the web."), `${SAMPLE_NOTE} A failure was asked for.`);
  }
  const empty = /^(nothing|no results)$/.test(normalise(question));
  const data: WebAnswerData = empty
    ? { question, answer: "", more: "", sources: [], searchUrl: searchUrl(question) }
    : { question, answer: SAMPLE_ANSWER, more: SAMPLE_MORE, sources: [...SAMPLE_SOURCES], searchUrl: searchUrl(question) };
  const result = done(empty ? t("Nothing found for this search.") : SAMPLE_ANSWER, true, data);
  return { ...result, detail: SAMPLE_NOTE };
}

const accountOf = (said: string): MailAccount | undefined => {
  const wanted = normalise(said);
  return SAMPLE_ACCOUNTS.find((a) => a.id === wanted || normalise(a.name) === wanted || a.address === said.trim().toLowerCase());
};

const summary = ({ body: _body, ...rest }: MailMessage): MailSummary => rest;

function checkEmail(a: Record<string, unknown>): ToolResult {
  const account = accountOf(str(a.account));
  if (!account) {
    return needs("account", {
      kind: "choice",
      question: t("Which email account do you want to use?"),
      options: SAMPLE_ACCOUNTS.map(({ id, name, address }) => ({ id, label: name, hint: address })),
    });
  }
  const who = str(a.who).slice(0, 80);
  const topic = str(a.topic).slice(0, 80);
  const kind = str(a.scope) || (who ? "person" : topic ? "topic" : "");
  if (kind !== "recent" && kind !== "person" && kind !== "topic") {
    return needs("scope", {
      kind: "choice",
      question: t("Recent emails, or a person or a topic in particular?"),
      options: [
        { id: "recent", label: t("Recent emails") },
        { id: "person", label: t("From someone") },
        { id: "topic", label: t("About a topic") },
      ],
    });
  }
  if (kind === "person" && !who) return needs("who", { kind: "text", question: t("Who from?") });
  if (kind === "topic" && !topic) return needs("topic", { kind: "text", question: t("About what?") });
  if (a.fail === true) return failed(t("Couldn't reach {account}.", { account: account.name }), `${SAMPLE_NOTE} A failure was asked for.`);

  const scope: MailScope = kind === "person" ? { kind, who } : kind === "topic" ? { kind, topic } : { kind: "recent" };
  const has = (text: string, words: string) => normalise(text).includes(normalise(words));
  const messages = SAMPLE_MESSAGES
    .filter((m) => m.account === account.id)
    .filter((m) => scope.kind === "recent"
      || (scope.kind === "person" && (has(m.from.name, scope.who) || has(m.from.address, scope.who)))
      || (scope.kind === "topic" && (has(m.subject, scope.topic) || has(m.body, scope.topic))))
    .map(summary);
  const data: MailListData = { account, scope, messages };
  const line = messages.length ? t("Emails in {account}", { account: account.name }) : t("No emails match.");
  return { ...done(line, true, data), detail: SAMPLE_NOTE };
}

function readEmail(a: Record<string, unknown>): ToolResult {
  const message = SAMPLE_MESSAGES.find((m) => m.id === str(a.id));
  if (!message) return notFoundResult(t("Email not found"));
  return { ...done(message.subject, true, { message }), detail: SAMPLE_NOTE };
}

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** A sentence as one run of characters, with what is said for the signs of an address written as them. */
const joined = (said: string) =>
  ` ${said.toLowerCase()} `
    .replace(/ at /g, "@").replace(/ dot /g, ".").replace(/ (dash|hyphen) /g, "-").replace(/ underscore /g, "_")
    .replace(/\s+/g, "").replace(/[.,;:!?]+$/, "");

/** "tana at example dot com" → "tana@example.com"; null when it is no address (the Mac's `spokenEmail`). */
export function spokenAddress(said: string): string | null {
  const address = joined(said);
  return ADDRESS.test(address) ? address : null;
}

/** The contacts a spoken name may be: the whole name, else any of its words. */
export function contactsNamed(said: string): MailContact[] {
  const wanted = normalise(said);
  if (!wanted) return [];
  const exact = SAMPLE_CONTACTS.filter((c) => normalise(c.name) === wanted);
  if (exact.length) return exact;
  const words = wanted.split(" ");
  return SAMPLE_CONTACTS.filter((c) => words.every((w) => normalise(c.name).split(" ").includes(w)));
}

const sentence = (text: string) => {
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

function draftEmail(a: Record<string, unknown>): ToolResult {
  const to = str(a.to).slice(0, 120);
  if (!to) return needs("to", { kind: "text", question: t("Who is the email for?"), placeholder: "name@example.com" });
  let contact: MailContact | null = null;
  const address = spokenAddress(to);
  if (address) {
    contact = SAMPLE_CONTACTS.find((c) => c.address === address) ?? { name: "", address };
  } else {
    const found = contactsNamed(to);
    if (found.length > 1) {
      return needs("to", {
        kind: "choice",
        question: t("Which {name}?", { name: sentence(to).slice(0, -1) }),
        options: found.map((c) => ({ id: c.address, label: c.name, hint: c.address })),
      });
    }
    if (!found.length) {
      return needs("to", {
        kind: "text",
        question: t("I can't find {name}. What's the address?", { name: to.slice(0, 40) }),
        placeholder: "name@example.com",
      });
    }
    contact = found[0];
  }
  const about = str(a.about).slice(0, 600);
  if (!about) return needs("about", { kind: "text", question: t("What should it say?") });
  const from = accountOf(str(a.account)) ?? SAMPLE_ACCOUNTS[0];
  const first = contact.name.split(" ")[0];
  const draft: MailDraft = {
    from,
    to: contact.address,
    toName: contact.name,
    subject: str(a.subject).slice(0, 120) || sentence(about).slice(0, -1).slice(0, 60),
    body: `${first ? `Hi ${first},` : "Hi,"}\n\n${sentence(about)}\n\nBest,\nAlex`,
    ...(str(a.attachment) ? { attachment: str(a.attachment).slice(0, 80) } : {}),
  };
  return {
    ...done(t("Here's your email. Check it and click Send."), true, { draft }),
    detail: `${SAMPLE_NOTE} The card is open. Nothing is sent until the user clicks Send.`,
  };
}

/** One stub, after its pause. An unknown name is refused like any tool that is not in the table. */
export async function runPreviewTool(call: BrainCall): Promise<ToolResult> {
  const a = call.arguments ?? {};
  await wait();
  switch (call.name) {
    case "web_search": return webSearch(a);
    case "check_email": return checkEmail(a);
    case "read_email": return readEmail(a);
    case "draft_email": return draftEmail(a);
    default: return failed(t("Command not recognised"), `unknown tool ${call.name}`);
  }
}

/** The line a card shows while a stub works. */
export function workingLine(call: BrainCall): string {
  switch (call.name) {
    case "web_search": return t("Searching the web…");
    case "check_email": {
      const account = accountOf(str(call.arguments?.account));
      return account ? t("Checking {account}…", { account: account.name }) : t("Loading…");
    }
    case "draft_email": return t("Writing the email…");
    default: return t("Loading…");
  }
}

/**
 * The same call with the user's answer in the argument the question was for;
 * null when the question was dropped, or was no question. A model does this
 * itself in the real loop — here it is code, so the cards can be clicked through.
 */
export function withAnswer(call: BrainCall, result: ToolResult, answer: Answer): BrainCall | null {
  const argument = (result.data as { needs?: unknown } | undefined)?.needs;
  if (result.status !== "ask" || typeof argument !== "string" || answer.kind === "dropped") return null;
  const value = answer.kind === "choice" ? answer.id : answer.kind === "text" ? answer.value.trim() : answer.yes;
  if (value === "") return null;
  return { name: call.name, arguments: { ...call.arguments, [argument]: value } };
}

// ── The fixed sentences ───────────────────────────────────────────────────────

const WEB = /^(?:please )?(?:search|look|google|find)(?: up)?(?: (?:on|in))?(?: the)? (?:web|internet|online)(?: for| about)?(?: (.+))?$/;
const WEB_AFTER = /^(?:please )?(?:search|look up|google|find)(?: for)? (.+) (?:on|in) the (?:web|internet)$/;
const MAIL = "(?:e ?mails?|mails?|inbox)";
const CHECK = new RegExp(
  `^(?:please )?(?:check|read|show(?: me)?|any|do i have(?: any)?)(?: (?:my|the|new|latest|recent))* ${MAIL}(?: (from|about) (.+))?$`,
);
const DRAFT = new RegExp(
  `^(?:please )?(?:write|draft|compose|send|prepare)(?: (?:an?|the|new))* (?:e ?mail|mail)(?: to (.+?))?(?: (?:saying|about|that says|to say)(?: that)? (.+))?$`,
);
const ATTACHED = / with (?:an? |the )?(?:attachment|file)(?: (?:called |named )?(.+))?$/;

/**
 * One of the fixed sentences, as the call it means; null for any other. The
 * arguments are the sentence's own words, lower case and without punctuation
 * (`normalise`) — an address is better typed, or said as "… at … dot …".
 */
export function previewSentence(said: string): BrainCall | null {
  let s = normalise(said);
  const web = WEB.exec(s) ?? WEB_AFTER.exec(s);
  if (web) return { name: "web_search", arguments: { query: web[1] ?? "" } };
  const check = CHECK.exec(s);
  if (check) {
    const [, how, what] = check;
    const recent = /\b(recent|latest|new)\b/.test(s);
    return {
      name: "check_email",
      arguments: how === "from" ? { scope: "person", who: what } : how === "about" ? { scope: "topic", topic: what } : recent ? { scope: "recent" } : {},
    };
  }
  const attached = ATTACHED.exec(s);
  if (attached) s = s.slice(0, attached.index);
  const draft = DRAFT.exec(s);
  if (draft) {
    return {
      name: "draft_email",
      arguments: {
        ...(draft[1] ? { to: draft[1] } : {}),
        ...(draft[2] ? { about: draft[2] } : {}),
        ...(attached ? { attachment: attached[1] ? attached[1].replace(/ dot (\w+)$/, ".$1") : "notes.pdf" } : {}),
      },
    };
  }
  return null;
}

// ── Checking what a model proposes ────────────────────────────────────────────

/** Words that carry no meaning of their own, for comparing a query with a sentence. */
const SMALL = new Set(["the", "a", "an", "of", "for", "to", "in", "on", "is", "are", "what", "who", "how", "and", "or", "me", "my"]);

/**
 * A model's call, held to what was said — the rule of voice/tools.ts. A
 * search is made of the user's words: a query that is mostly the model's own
 * is replaced by the sentence. An email goes only to someone the sentence
 * names: any other recipient is dropped, and the tool asks.
 */
export function previewChecked(call: BrainCall, said: string): BrainCall {
  const a = { ...(call.arguments ?? {}) };
  const spoken = normalise(said);
  if (!spoken) return { name: call.name, arguments: a };
  const words = new Set(spoken.split(" "));
  if (call.name === "web_search") {
    const query = normalise(str(a.query)).split(" ").filter((w) => w && !SMALL.has(w));
    const own = query.filter((w) => words.has(w)).length;
    if (!query.length || own * 2 < query.length) a.query = previewSentence(said)?.arguments.query || said.trim();
  }
  if (call.name === "draft_email" && str(a.to)) {
    const to = str(a.to);
    const address = spokenAddress(to);
    // An address counts when the sentence holds it, written or said as "… at … dot …".
    const named = address ? joined(said).includes(address) : normalise(to).split(" ").some((w) => words.has(w));
    if (!named) delete a.to;
  }
  return { name: call.name, arguments: a };
}

// ── Showing it ────────────────────────────────────────────────────────────────

/** What shows a stub working and what came of it: the cards (views/voice-cards.ts). */
export interface PreviewHost {
  working(call: BrainCall): void;
  show(call: BrainCall, result: ToolResult): void;
}

let host: PreviewHost | null = null;
let turn = 0;

export function setPreviewHost(next: PreviewHost | null) {
  host = next;
}

/** How a voice turn asks and waits: without these, the tool's own card does both. */
export interface PreviewTurn {
  /** Puts a question in the listening card and waits for its answer (VoiceConversation.askUser). */
  ask?: (ask: Ask) => Promise<Answer>;
  /** The listening card turns gray with this line while a stub works. */
  waiting?: (line?: string) => void;
}

/**
 * Runs a stub and shows what came of it on its card. In a voice turn
 * (`how.ask`) its questions go up in the listening card, one after the
 * other, each answer put into the call and the tool run again; the card
 * opens on what there is to show at the end. A question that is dropped ends
 * it there. A newer call, or `dropPreview`, makes this one's result nobody's.
 */
export async function runPreview(call: BrainCall, how: PreviewTurn = {}): Promise<ToolResult> {
  const mine = ++turn;
  let current = call;
  for (;;) {
    if (how.ask) how.waiting?.(workingLine(current));
    else host?.working(current);
    const result = await runPreviewTool(current);
    if (mine !== turn) return result;
    if (result.status === "ask" && result.ask && how.ask) {
      const next = withAnswer(current, result, await how.ask(result.ask));
      if (mine !== turn || !next) return result;
      current = next;
      continue;
    }
    host?.show(current, result);
    return result;
  }
}

/** The card was closed: whatever is still on its way is shown nowhere. */
export function dropPreview() {
  turn += 1;
}

/**
 * From a sentence or a model's proposal: the stub's card opens and the voice
 * card has nothing left to show, which is what null means to the island
 * (voice/tools.ts `runProposal`).
 */
export async function openPreview(call: BrainCall, said = "", ask?: PreviewTurn["ask"]): Promise<null> {
  // Waited for when it asks in the listening card: the turn must still be there to hear the answer.
  const running = runPreview(previewChecked(call, said), { ask });
  if (ask) await running;
  return null;
}

/**
 * One of the fixed sentences: it is run, and its card opens — after its
 * questions, when the turn can ask them (`ask`). Null at once for any other
 * sentence; else a promise of null, which is "nothing left for the voice card".
 */
export function heardPreview(said: string, ask?: PreviewTurn["ask"], waiting?: PreviewTurn["waiting"]): Promise<null> | null {
  const call = previewSentence(said);
  if (!call) return null;
  const running = runPreview(call, { ask, waiting });
  return ask ? running.then(() => null) : Promise.resolve(null);
}
