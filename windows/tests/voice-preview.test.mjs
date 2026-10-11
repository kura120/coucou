// The sample tools behind the web answer and email cards
// (src/voice/tools-preview.ts) and the cards themselves, on a fake DOM. What
// matters most is what these must never do: send, fetch, or pass sample data
// off as real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { availablePills } = await import("../src/core/pills.ts");
const { State } = await import("../src/core/state.ts");
const { VIEW_LAYOUTS } = await import("../src/core/layout.ts");
const { setLanguage, LANGUAGE_CODES, lookup } = await import("../src/i18n/i18n.ts");
const { VoiceConversation } = await import("../src/voice/conversation.ts");
const { VoiceRunner } = await import("../src/voice/runner.ts");
const { runProposal, toolSchemas } = await import("../src/voice/tools.ts");
const {
  PREVIEW_TOOL_NAMES, SAMPLE_ACCOUNTS, SAMPLE_MESSAGES, SAMPLE_SOURCES, contactsNamed, heardPreview, previewChecked, previewSentence,
  previewTiming, previewToolSchemas, previewToolsFor, runPreview, runPreviewTool, setPreviewHost, spokenAddress, withAnswer,
} = await import("../src/voice/tools-preview.ts");
const { MailCard, buildEmail, scopeLabel } = await import("../src/views/email.ts");
const { WebCard, buildWebAnswer } = await import("../src/views/websearch.ts");
const { firstSentence, registerVoiceCards } = await import("../src/views/voice-cards.ts");
const { cardAsk, fit, keyAnswer, whenShort } = await import("../src/views/sample.ts");

previewTiming.delayMs = 0;

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const PILLS = availablePills("windows");
const call = (name, args = {}) => ({ name, arguments: args });
const run = (name, args) => runPreviewTool(call(name, args));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function recordingHost() {
  const seen = [];
  setPreviewHost({
    working: (c) => seen.push(["working", c.name]),
    show: (c, result) => seen.push([result.status, c.name, result]),
  });
  return seen;
}

function fakeRunner() {
  const noop = () => {};
  return new VoiceRunner(
    { enabled: () => true, running: () => true, playing: () => false, shuffle: () => false, repeat: () => false, playPause: noop, next: noop, previous: noop, setShuffle: noop, setRepeat: noop, open: noop },
    { active: () => [], main: () => "integration_claude", hasRoomFor: () => true, limit: () => 6, toggle: noop, setMain: noop },
    () => PILLS,
  );
}

const WORLD = {
  agents: () => [], openSession: () => false, permission: () => null, showPermission() {}, declinePermission() {},
  timer: () => null, setTimer() {}, cancelTimer: () => false, openApp: async () => null, appsNear: async () => ({ names: [], clear: false }),
  openFolder: async () => null, openUrl() {}, nowPlaying: () => null, reports: () => ({}),
};

// ── What they must never do ───────────────────────────────────────────────────

test("no sample tool sends, and the file that holds them reaches nothing", () => {
  for (const name of PREVIEW_TOOL_NAMES) assert.doesNotMatch(name, /send|allow|approve|run|exec/, name);
  const source = readFileSync(join(SRC, "voice/tools-preview.ts"), "utf8");
  // No network, no Rust, no storage: fixed data and a timer.
  for (const word of ["fetch(", "XMLHttpRequest", "WebSocket", "Bridge", "invoke(", "localStorage", "@tauri-apps"]) {
    assert.ok(!source.includes(word), `tools-preview.ts mentions ${word}`);
  }
});

test("every result tells a model it is sample data", async () => {
  const results = [
    await run("web_search", { query: "how tall is everest" }),
    await run("check_email", { account: "work", scope: "recent" }),
    await run("read_email", { id: "m01" }),
    await run("draft_email", { to: "louis", about: "see you friday" }),
  ];
  for (const result of results) {
    assert.equal(result.status, "done");
    assert.match(result.detail, /^SAMPLE DATA/);
  }
  assert.match(results[3].detail, /Nothing is sent until the user clicks Send/);
});

test("the sample: two accounts, a dozen emails, three search results", () => {
  assert.equal(SAMPLE_ACCOUNTS.length, 2);
  assert.equal(SAMPLE_MESSAGES.length, 12);
  assert.equal(SAMPLE_SOURCES.length, 3);
  for (const source of SAMPLE_SOURCES) assert.match(source.url, /^https:\/\//);
  // Made-up people only: reserved example domains.
  for (const message of SAMPLE_MESSAGES) assert.match(message.from.address, /@example\.(com|org)$/);
  assert.ok(new Set(SAMPLE_MESSAGES.map((m) => m.id)).size === 12);
});

test("the model is offered the tools a sentence speaks of, and no other sentence sees them", () => {
  const offered = (said) => toolSchemas(PILLS, [], said).map((tool) => tool.function.name).filter((name) => PREVIEW_TOOL_NAMES.includes(name));
  assert.deepEqual(offered("search the web for the weather"), ["web_search"]);
  assert.deepEqual(offered("do I have any new emails"), ["check_email", "read_email", "draft_email"]);
  assert.deepEqual(offered("add github and vercel"), []);
  assert.deepEqual(offered("what is claude doing"), []);
  assert.deepEqual(previewToolsFor("look up my inbox online").length, 4);
  assert.equal(previewToolSchemas().length, 4);
  assert.match(previewToolSchemas()[3].function.description, /never sent by you/);
});

// ── The fixed sentences ───────────────────────────────────────────────────────

test("the fixed sentences, and what is not one", () => {
  const cases = [
    ["search the web for how tall is mount everest", "web_search", { query: "how tall is mount everest" }],
    ["Search the internet for the weather in Lyon.", "web_search", { query: "the weather in lyon" }],
    ["look up espresso machines on the web", "web_search", { query: "espresso machines" }],
    ["search the web", "web_search", { query: "" }],
    ["check my emails", "check_email", {}],
    ["Check my email.", "check_email", {}],
    ["do I have any new emails", "check_email", { scope: "recent" }],
    ["check my recent emails", "check_email", { scope: "recent" }],
    ["check my emails from Tana", "check_email", { scope: "person", who: "tana" }],
    ["read my emails about the invoice", "check_email", { scope: "topic", topic: "the invoice" }],
    ["write an email to Tana", "draft_email", { to: "tana" }],
    ["write an email", "draft_email", {}],
    ["send an email to Louis saying the build is ready", "draft_email", { to: "louis", about: "the build is ready" }],
    ["draft an e-mail to tana at example dot com about lunch", "draft_email", { to: "tana at example dot com", about: "lunch" }],
    ["write an email to Priya about the notes with the file notes dot pdf", "draft_email", { to: "priya", about: "the notes", attachment: "notes.pdf" }],
  ];
  for (const [said, name, args] of cases) assert.deepEqual(previewSentence(said), call(name, args), said);
  for (const said of ["next track", "open mail", "open my inbox", "add github", "what is claude doing", "never mind", "", "email"]) {
    assert.equal(previewSentence(said), null, said);
  }
});

// ── check_email: the questions it asks ────────────────────────────────────────

test("check my emails: which account, then what to look for, then the list", async () => {
  let c = previewSentence("check my emails");
  let result = await runPreviewTool(c);
  assert.equal(result.status, "ask");
  assert.equal(result.ask.kind, "choice");
  assert.equal(result.ask.question, "Which email account do you want to use?");
  assert.deepEqual(result.ask.options.map((o) => [o.id, o.label, o.hint]), SAMPLE_ACCOUNTS.map((a) => [a.id, a.name, a.address]));

  c = withAnswer(c, result, { kind: "choice", id: "work" });
  result = await runPreviewTool(c);
  assert.equal(result.status, "ask");
  assert.deepEqual(result.ask.options.map((o) => o.id), ["recent", "person", "topic"]);

  c = withAnswer(c, result, { kind: "choice", id: "person" });
  result = await runPreviewTool(c);
  assert.deepEqual([result.status, result.ask.kind, result.ask.question], ["ask", "text", "Who from?"]);

  c = withAnswer(c, result, { kind: "text", value: " Priya " });
  result = await runPreviewTool(c);
  assert.equal(result.status, "done");
  assert.deepEqual(c.arguments, { account: "work", scope: "person", who: "Priya" });
  assert.deepEqual(result.data.messages.map((m) => m.id), ["m01", "m10"]);
  // A list is summaries: a model is never handed twelve bodies.
  assert.ok(result.data.messages.every((m) => !("body" in m)));
});

test("check_email: what was already said is not asked again, and nothing found is an empty list", async () => {
  const recent = await run("check_email", { account: "personal", scope: "recent" });
  assert.equal(recent.data.messages.length, 7);
  const about = await run("check_email", { account: "Work", topic: "invoice" });
  assert.deepEqual(about.data.messages.map((m) => m.id), ["m05"]);
  const none = await run("check_email", { account: "work", who: "nobody" });
  assert.deepEqual([none.status, none.data.messages.length, none.line], ["done", 0, "No emails match."]);
  const failed = await run("check_email", { account: "work", scope: "recent", fail: true });
  assert.deepEqual([failed.status, failed.line], ["failed", "Couldn't reach Work."]);
  // An account that is not one of the user's is asked about, not guessed.
  assert.equal((await run("check_email", { account: "school" })).status, "ask");
});

test("a dropped question, or an empty answer, goes nowhere", async () => {
  const c = call("check_email");
  const result = await runPreviewTool(c);
  assert.equal(withAnswer(c, result, { kind: "dropped" }), null);
  const who = await run("check_email", { account: "work", scope: "person" });
  assert.equal(withAnswer(call("check_email", { account: "work", scope: "person" }), who, { kind: "text", value: "   " }), null);
  // Only a question can be answered.
  assert.equal(withAnswer(c, await run("read_email", { id: "m01" }), { kind: "choice", id: "x" }), null);
});

test("read_email opens one email, or says it is not there", async () => {
  const found = await run("read_email", { id: "m04" });
  assert.equal(found.data.message.from.name, "Louis Bernard");
  assert.ok(found.data.message.body.length > 200);
  assert.equal((await run("read_email", { id: "nope" })).status, "not_found");
});

// ── draft_email ───────────────────────────────────────────────────────────────

test("a spoken name becomes an address only when one contact has it", async () => {
  assert.deepEqual(contactsNamed("Louis").map((c) => c.address), ["louis@example.com"]);
  assert.equal(contactsNamed("tana").length, 2);
  assert.equal(contactsNamed("tana rao").length, 1);
  assert.equal(contactsNamed("zoe").length, 0);
  assert.equal(spokenAddress("tana at example dot com"), "tana@example.com");
  assert.equal(spokenAddress("Tana.Rao@Example.com."), "tana.rao@example.com");
  assert.equal(spokenAddress("tana"), null);

  // Two Tanas: asked, with the addresses to tell them apart.
  const which = await run("draft_email", { to: "tana", about: "lunch" });
  assert.deepEqual([which.status, which.ask.kind, which.ask.question], ["ask", "choice", "Which Tana?"]);
  assert.deepEqual(which.ask.options.map((o) => o.id), ["tana.rao@example.com", "tana.meyer@example.org"]);
  // Nobody by that name: the address is asked for, never made up.
  const unknown = await run("draft_email", { to: "zoe", about: "lunch" });
  assert.deepEqual([unknown.status, unknown.ask.kind], ["ask", "text"]);
  assert.match(unknown.ask.question, /can't find zoe/);
});

test("write an email to Tana: which Tana, what to say, then the card — and nothing is sent", async () => {
  let c = previewSentence("write an email to Tana");
  let result = await runPreviewTool(c);
  c = withAnswer(c, result, { kind: "choice", id: "tana.meyer@example.org" });
  result = await runPreviewTool(c);
  assert.deepEqual([result.status, result.ask.question], ["ask", "What should it say?"]);
  c = withAnswer(c, result, { kind: "text", value: "the invoice is paid" });
  result = await runPreviewTool(c);
  assert.equal(result.status, "done");
  assert.deepEqual(result.data.draft, {
    from: SAMPLE_ACCOUNTS[0],
    to: "tana.meyer@example.org",
    toName: "Tana Meyer",
    subject: "The invoice is paid",
    body: "Hi Tana,\n\nThe invoice is paid.\n\nBest,\nAlex",
  });
  assert.equal(result.line, "Here's your email. Check it and click Send.");

  const first = await run("draft_email", {});
  assert.deepEqual([first.status, first.ask.question], ["ask", "Who is the email for?"]);
  const attached = await run("draft_email", { to: "louis", about: "here it is", attachment: "notes.pdf", account: "work" });
  assert.deepEqual([attached.data.draft.attachment, attached.data.draft.from.id], ["notes.pdf", "work"]);
});

// ── web_search ────────────────────────────────────────────────────────────────

test("web_search: an answer with its sources, nothing found, a failure, and a question when nothing was asked", async () => {
  const found = await run("web_search", { query: "how tall is mount everest" });
  assert.equal(found.data.sources.length, 3);
  assert.match(found.data.answer, /sample answer: no search was made/);
  assert.ok(found.data.more.length > 0);
  assert.equal(found.data.searchUrl, "https://duckduckgo.com/?q=how%20tall%20is%20mount%20everest");
  const none = await run("web_search", { query: "nothing" });
  assert.deepEqual([none.status, none.data.answer, none.data.sources.length], ["done", "", 0]);
  assert.equal((await run("web_search", { query: "error" })).status, "failed");
  const asked = await run("web_search", { query: "  " });
  assert.deepEqual([asked.status, asked.ask.kind, asked.data.needs], ["ask", "text", "query"]);
});

// ── A model's call is held to what was said ───────────────────────────────────

test("a search is made of the user's words, and an email goes only to someone they named", () => {
  const said = "search the web for the weather in Lyon";
  assert.equal(previewChecked(call("web_search", { query: "weather Lyon" }), said).arguments.query, "weather Lyon");
  // A query that is the model's own invention is replaced by what was said.
  assert.equal(previewChecked(call("web_search", { query: "alex martin home address" }), said).arguments.query, "the weather in lyon");
  assert.equal(previewChecked(call("web_search", { query: "" }), "who won yesterday").arguments.query, "who won yesterday");

  assert.equal(previewChecked(call("draft_email", { to: "Tana Rao", about: "hi" }), "write an email to tana").arguments.to, "Tana Rao");
  assert.equal(previewChecked(call("draft_email", { to: "boss@example.com", about: "hi" }), "write an email to tana").arguments.to, undefined);
  assert.equal(previewChecked(call("draft_email", { to: "Louis", about: "hi" }), "write an email to tana").arguments.to, undefined);
  assert.equal(
    previewChecked(call("draft_email", { to: "tana@example.com" }), "write an email to tana at example dot com").arguments.to,
    "tana@example.com",
  );
});

// ── The three ways in ─────────────────────────────────────────────────────────

test("from a model: the tool's card opens and the voice card has nothing to say", async () => {
  const seen = recordingHost();
  const result = await runProposal({ calls: [call("check_email", { account: "work" })], text: "" }, "check my work emails", fakeRunner(), WORLD, PILLS);
  assert.equal(result, null);
  await tick();
  // No way to ask in the listening card yet (a model's first round): the card asks.
  assert.deepEqual(seen.map(([what, name]) => [what, name]), [["working", "check_email"], ["ask", "check_email"]]);

  // Once the turn can ask, the questions go through it and the card opens on the list.
  seen.length = 0;
  const asked = [];
  const ask = async (question) => {
    asked.push(question.question);
    return question.kind === "choice" ? { kind: "choice", id: question.options[0].id } : { kind: "dropped" };
  };
  assert.equal(await runProposal({ calls: [call("check_email", { account: "work" })], text: "" }, "check my work emails", fakeRunner(), WORLD, PILLS, { ask }), null);
  assert.deepEqual(asked, ["Recent emails, or a person or a topic in particular?"]);
  assert.deepEqual(seen.map(([what, name]) => [what, name]), [["done", "check_email"]]);
  setPreviewHost(null);
});

test("by voice: check my emails asks in the listening card, twice, then opens the list", async () => {
  const seen = recordingHost();
  const conversation = new VoiceConversation(fakeRunner(), WORLD, () => PILLS, () => null);
  const questions = [];
  // As the island does: the question goes up, and is answered by a key or a click.
  conversation.onAsk = (ask) => {
    if (!ask) return;
    questions.push(ask.question);
    queueMicrotask(() => conversation.answer(ask.kind === "choice" ? { kind: "choice", id: ask.options[1].id } : { kind: "dropped" }));
  };
  const lines = [];
  assert.equal(await conversation.hear("check my emails", { waiting: (line) => lines.push(line) }), null);
  assert.deepEqual(questions, ["Which email account do you want to use?", "Recent emails, or a person or a topic in particular?", "Who from?"]);
  // Work, then "From someone": who is asked in the listening card too — and dropped here.
  assert.deepEqual(lines, ["Loading…", "Checking Work…", "Checking Work…"]);
  assert.deepEqual(seen, []);

  // "Never mind" at the first question: nothing opens.
  conversation.onAsk = (ask) => ask && queueMicrotask(() => conversation.answer({ kind: "dropped" }));
  assert.equal(await conversation.hear("check my emails"), null);
  assert.deepEqual(seen, []);

  conversation.onAsk = (ask) => ask && queueMicrotask(() => conversation.answer({ kind: "choice", id: ask.options[0].id }));
  assert.equal(await conversation.hear("check my emails"), null);
  assert.deepEqual(seen.map(([what, name, result]) => [what, name, result.data.account.id, result.data.scope.kind]), [["done", "check_email", "personal", "recent"]]);
  conversation.onAsk = null;
  setPreviewHost(null);
});

test("by voice: a fixed sentence opens its card, any other sentence is the parser's as before", async () => {
  const seen = recordingHost();
  const conversation = new VoiceConversation(fakeRunner(), WORLD, () => PILLS, () => null);
  assert.equal(await conversation.hear("search the web for how tall is mount everest"), null);
  await tick();
  assert.deepEqual(seen.map(([what, name]) => [what, name]), [["done", "web_search"]]);
  seen.length = 0;
  // Not one of them: "not recognised", as without this file.
  assert.equal((await conversation.hear("please do the thing")).outcome, "failure");
  // Said to nobody, in the follow-up time: no card opens.
  assert.equal(await conversation.hear("check my emails", { spokenTo: false }), null);
  // A command the parser knows stays the parser's.
  assert.equal((await conversation.hear("next track")).outcome, "success");
  await tick();
  assert.deepEqual(seen, []);
  assert.equal(heardPreview("add github"), null);
  setPreviewHost(null);
});

test("a newer call makes an older one's answer nobody's", async () => {
  const seen = recordingHost();
  previewTiming.delayMs = 20;
  const first = runPreview(call("web_search", { query: "one" }));
  previewTiming.delayMs = 0;
  await runPreview(call("check_email", { account: "work", scope: "recent" }));
  await first;
  assert.deepEqual(seen.map(([what, name]) => [what, name]), [["working", "web_search"], ["working", "check_email"], ["done", "check_email"]]);
  setPreviewHost(null);
});

// ── A question on a card ──────────────────────────────────────────────────────

const key = (init) => ({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: "", code: "", ...init });

test("on a card: a choice by Ctrl+Shift+number, yes or no by 1 and 2, Escape drops", () => {
  const choice = { kind: "choice", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  assert.deepEqual(keyAnswer(key({ code: "Digit2" }), choice), { kind: "choice", id: "b" });
  assert.deepEqual(keyAnswer(key({ code: "Numpad1" }), choice), { kind: "choice", id: "a" });
  // Not without both modifiers, and not a number past the list.
  assert.equal(keyAnswer(key({ code: "Digit2", shiftKey: false }), choice), null);
  assert.equal(keyAnswer(key({ code: "Digit3" }), choice), null);
  assert.deepEqual(keyAnswer(key({ code: "Digit2" }), { kind: "yes_no", question: "Open?" }), { kind: "yes_no", yes: false });
  assert.equal(keyAnswer(key({ code: "Digit3" }), { kind: "yes_no", question: "Open?" }), null);
  // A field confirms itself; Escape drops any question.
  assert.equal(keyAnswer(key({ key: "Enter" }), { kind: "text", question: "Who?" }), null);
  assert.deepEqual(keyAnswer({ key: "Escape" }, choice), { kind: "dropped" });
});

test("on a card: the question, its choices, and one answer only", () => {
  const answers = [];
  const ask = cardAsk(() => true, (a) => answers.push(a));
  ask.show({ kind: "choice", question: "Which Tana?", options: [{ id: "a", label: "Tana Rao", hint: "tana.rao@example.com" }, { id: "b", label: "Tana Meyer" }] });
  assert.equal(ask.el.find(".vc-ask-question")[0].textContent, "Which Tana?");
  assert.deepEqual(ask.el.find(".ask-label").map((o) => o.textContent), ["Tana Rao", "Tana Meyer"]);
  ask.el.find(".ask-option")[1].fire("click");
  ask.el.find(".ask-option")[0].fire("click"); // answered: nothing more to pick
  assert.deepEqual(answers, [{ kind: "choice", id: "b" }]);
  ask.show({ kind: "text", question: "Who from?", value: "tana" });
  assert.equal(ask.el.find("input")[0].value, "tana");
});

// ── The cards ─────────────────────────────────────────────────────────────────

function fakeActions() {
  const log = [];
  return {
    log,
    actions: { setView: (v) => log.push(`view:${v}`), dismissCard: (how) => log.push(`dismiss:${how}`), openUrl: (url) => log.push(`open:${url}`) },
  };
}

function fakeDriver() {
  const log = [];
  return { log, driver: { run: (c) => log.push(["run", c]), answer: (a) => log.push(["answer", a]), close: () => log.push(["close"]), open: (url) => log.push(["open", url]), say: (text) => log.push(["say", text]) } };
}

test("every card says it shows sample data, in every language", () => {
  const { actions } = fakeActions();
  const { driver } = fakeDriver();
  const web = buildWebAnswer(actions, driver);
  const mail = buildEmail(actions, driver);
  for (const view of [web, mail]) assert.equal(view.el.find(".vc-sample").length, 1);
  assert.equal(web.el.find(".vc-sample")[0].textContent, "Sample data");
  for (const lang of LANGUAGE_CODES.filter((l) => l !== "en")) {
    const there = lookup("Sample data", lang);
    assert.ok(typeof there === "string" && there && there !== "Sample data", lang);
    setLanguage(lang);
    assert.equal(mail.el.find(".vc-sample")[0].textContent, there, lang);
  }
  setLanguage("en");
});

test("the web answer card: working, the answer and its links, more, nothing found, a failure", async () => {
  const { actions } = fakeActions();
  const { driver, log } = fakeDriver();
  const view = buildWebAnswer(actions, driver);
  const text = () => view.el.textContent;

  WebCard.show({ phase: "working", question: "how tall is everest", line: "Searching the web…" });
  view.sync();
  assert.match(text(), /“how tall is everest”.*Searching the web…/);

  const { data } = await run("web_search", { query: "how tall is everest" });
  WebCard.show({ phase: "done", data });
  view.sync();
  assert.deepEqual(view.el.find(".vc-source-site").map((s) => s.textContent), ["en.wikipedia.org", "britannica.com", "wikidata.org"]);
  view.el.find(".vc-source")[1].fire("click");
  assert.deepEqual(log.pop(), ["open", "https://www.britannica.com/place/Mount-Everest"]);
  const buttons = () => view.el.find(".btn").map((b) => b.textContent);
  assert.deepEqual(buttons(), ["Tell me more", "Open search", "Done"]);
  assert.ok(!text().includes(data.more));
  view.el.find(".btn")[0].fire("click");
  view.sync();
  assert.ok(text().includes(data.more));
  assert.deepEqual(buttons(), ["Open search", "Done"]);
  view.el.find(".btn")[0].fire("click");
  assert.deepEqual(log.pop(), ["open", data.searchUrl]);

  // Nine sources: five links and a count.
  WebCard.show({ phase: "done", data: { ...data, sources: Array.from({ length: 9 }, () => data.sources[0]) } });
  view.sync();
  assert.equal(view.el.find(".vc-source").length, 6);
  assert.equal(view.el.find(".vc-source")[5].textContent, "+4");

  WebCard.show({ phase: "done", data: (await run("web_search", { query: "nothing" })).data });
  view.sync();
  assert.match(text(), /Nothing found for this search\./);
  assert.deepEqual(buttons(), ["Open search", "Done"]);

  WebCard.show({ phase: "failed", question: "x", line: "Couldn't search the web.", detail: "why" });
  view.sync();
  assert.match(text(), /Couldn't search the web\.why/);
  view.el.find(".btn")[0].fire("click");
  assert.deepEqual(log.pop(), ["run", call("web_search", { query: "x" })]);
  view.el.find(".btn")[1].fire("click");
  assert.deepEqual(log.pop(), ["close"]);
});

test("the list of emails: sender, subject, a line, when — and a click opens one", async () => {
  const { actions } = fakeActions();
  const { driver, log } = fakeDriver();
  const view = buildEmail(actions, driver);
  const { data } = await run("check_email", { account: "work", scope: "recent" });
  MailCard.show({ step: "list", data });
  view.sync();
  assert.equal(view.el.find(".vc-title")[0].textContent, "Work · Recent emails");
  const rows = view.el.find(".mail-row");
  assert.equal(rows.length, 5);
  assert.equal(rows[0].find(".mail-from")[0].textContent, "Priya Shah");
  assert.equal(rows[0].find(".mail-subject")[0].textContent, "Release notes for 0.4.1");
  assert.match(rows[0].find(".mail-snippet")[0].textContent, /Draft attached/);
  assert.ok(rows[0].find(".mail-when")[0].textContent.length > 0);
  assert.ok(rows[0].classList.contains("unread") && !rows[4].classList.contains("unread"));
  rows[1].fire("click");
  assert.deepEqual(log.pop(), ["run", call("read_email", { id: "m03" })]);

  // Nothing found: said, with a way back to the question.
  MailCard.show({ step: "list", data: { ...data, scope: { kind: "person", who: "nobody" }, messages: [] } });
  view.sync();
  assert.match(view.el.textContent, /Work · From nobody.*No emails match\./);
  view.el.find(".btn")[0].fire("click");
  assert.deepEqual(log.pop(), ["run", call("check_email", { account: "work" })]);
  assert.equal(scopeLabel({ kind: "topic", topic: "invoices" }), "About invoices");
});

test("an opened email: its text, back to the list, and Reply prepares an answer", async () => {
  const { actions } = fakeActions();
  const { driver, log } = fakeDriver();
  const view = buildEmail(actions, driver);
  const list = (await run("check_email", { account: "work", scope: "recent" })).data;
  const { message } = (await run("read_email", { id: "m05" })).data;
  MailCard.show({ step: "message", message, back: list });
  view.sync();
  assert.match(view.el.textContent, /Invoice 2026-104.*Tana Meyer.*tana\.meyer@example\.org.*Payment is due.*invoice-2026-104\.pdf/s);
  view.el.find(".btn")[0].fire("click");
  assert.deepEqual(log.pop(), ["run", call("draft_email", { to: "tana.meyer@example.org", subject: "Re: Invoice 2026-104", account: "work" })]);
  view.el.find(".mail-back")[0].fire("click");
  assert.equal(MailCard.state.step, "list");
});

test("the compose card: Send is a click, and here it sends nothing and says so", async () => {
  const { actions } = fakeActions();
  const { driver, log } = fakeDriver();
  const view = buildEmail(actions, driver);
  const { draft } = (await run("draft_email", { to: "louis", about: "the build is ready", attachment: "notes.pdf" })).data;
  MailCard.show({ step: "compose", draft });
  view.sync();
  const [to, subject] = view.el.find("input");
  const body = view.el.find("textarea")[0];
  assert.deepEqual([to.value, subject.value, body.value], ["louis@example.com", "The build is ready", "Hi Louis,\n\nThe build is ready.\n\nBest,\nAlex"]);
  assert.equal(view.el.find(".mail-file")[0].textContent, "notes.pdf");
  assert.deepEqual(view.el.find(".btn").map((b) => b.textContent), ["Send", "Cancel"]);
  const note = view.el.find(".mail-note")[0];
  assert.equal(note.textContent, "");

  // No recipient: nothing happens but the reason.
  to.value = " ";
  view.el.find(".btn")[0].fire("click");
  assert.equal(note.textContent, "Missing recipient.");
  to.value = "louis@example.com";
  view.el.find(".btn")[0].fire("click");
  assert.equal(note.textContent, "Sample: nothing was sent.");
  // The click reached no tool, no link and no voice: there is nothing behind Send.
  assert.deepEqual(log, []);

  // The account it goes from: a click takes the next one. The attachment comes off.
  const from = view.el.find(".from")[0];
  assert.match(from.textContent, /^From Personal/);
  from.fire("click");
  assert.match(from.textContent, /^From Work/);
  view.el.find(".mail-chip-x")[0].fire("click");
  assert.equal(view.el.find(".mail-file").length, 0);

  view.el.find(".btn")[1].fire("click");
  assert.deepEqual(log, [["close"]]);
});

test("the cards on the island: a tool's steps are shown, an answer runs it again, Done closes", async () => {
  const views = new Map();
  const { actions, log } = fakeActions();
  // As the island does: a view asked for is the view shown.
  actions.setView = (v) => {
    log.push(`view:${v}`);
    State.view = v;
    State.mode = "expanded";
    State.notify();
  };
  registerVoiceCards(views, actions);
  assert.deepEqual([...views.keys()], ["webAnswer", "email"]);

  assert.ok(heardPreview("check my emails"));
  assert.equal(MailCard.state.step, "working");
  assert.equal(State.cardHeld, true); // the island does not fold under a card that is waited on
  await tick();
  assert.equal(MailCard.state.step, "asking");
  const mail = views.get("email");
  mail.sync();
  mail.el.find(".ask-option")[1].fire("click"); // Work
  await tick();
  mail.sync();
  assert.deepEqual(mail.el.find(".ask-label").map((o) => o.textContent), ["Recent emails", "From someone", "About a topic"]);
  mail.el.find(".ask-option")[0].fire("click");
  await tick();
  assert.equal(MailCard.state.step, "list");
  assert.equal(MailCard.state.data.account.id, "work");
  mail.sync();
  mail.el.find(".mail-row")[0].fire("click");
  await tick();
  assert.equal(MailCard.state.step, "message");
  assert.equal(MailCard.state.back.account.id, "work");
  assert.ok(log.includes("view:email") && !log.some((l) => l.startsWith("dismiss")));

  // Leaving the card any way at all drops it.
  State.view = "overview";
  State.notify();
  assert.equal(MailCard.state.step, "idle");
  assert.equal(State.cardHeld, false);

  assert.ok(heardPreview("search the web for how tall is mount everest"));
  await tick();
  assert.equal(WebCard.state.phase, "done");
  const web = views.get("webAnswer");
  web.sync();
  web.el.find(".btn")[2].fire("click"); // Done
  assert.equal(WebCard.state.phase, "idle");
  assert.equal(log.at(-1), "dismiss:collapse");
  State.view = "overview";
  State.mode = "hidden";
  setPreviewHost(null);
});

// ── Small pieces ──────────────────────────────────────────────────────────────

test("the island takes a card's height, and only moves when it changes", () => {
  const { actions, log } = fakeActions();
  const before = VIEW_LAYOUTS.email.height;
  State.view = "email";
  State.mode = "expanded";
  fit("email", 200, actions);
  assert.equal(VIEW_LAYOUTS.email.height, 252);
  fit("email", 200, actions);
  assert.deepEqual(log, ["view:email"]);
  State.view = "overview";
  fit("email", 120, actions); // not on screen: sized, nothing moves
  assert.deepEqual(log, ["view:email"]);
  VIEW_LAYOUTS.email.height = before;
  State.mode = "hidden";
});

test("when an email came: the time today, the day this week, the date before", () => {
  const now = new Date(2026, 9, 11, 15, 0);
  assert.match(whenShort(30, now), /2:30/);
  assert.equal(whenShort(2 * 24 * 60, now), "Fri");
  assert.match(whenShort(9 * 24 * 60, now), /Oct 2|2 Oct/);
  assert.equal(firstSentence("Mount Everest is 8,849 metres high. It grows."), "Mount Everest is 8,849 metres high.");
  assert.equal(firstSentence("no full stop"), "no full stop");
});
