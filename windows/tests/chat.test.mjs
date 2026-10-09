// The chat view (src/views/chat.ts) on a fake DOM, through the real bridge:
// the model switcher asks for a provider's models only once it is picked and
// has a key, picking saves the settings, and a streamed answer grows in place.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

/** What the mocked Rust side answers, by command. */
let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
beforeEach(() => {
  calls.length = 0;
  answers = {};
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const chips = () => view.el.find(".picker-chip").map((c) => c.textContent);
const models = () => view.el.find(".picker-model").map((m) => m.textContent);

test("the model button shows the active provider's model", () => {
  assert.equal($(".model-name").textContent, "claude-opus-5");
  State.settings = { ...State.settings, chatProvider: "google" };
  view.sync();
  assert.equal($(".model-name").textContent, "gemini-2.0-flash");
  State.settings = { ...State.settings, chatProvider: "ollama" };
  view.sync();
  assert.equal($(".model-name").textContent, "Choose a model");
});

test("a provider without a key is never asked for its models", async () => {
  answers.secret_present = false;
  $(".model-btn").fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("picking"));
  assert.deepEqual(chips(), ["Anthropic", "Claude Code", "Google", "OpenAI", "OpenRouter", "NVIDIA"]);
  assert.deepEqual(sent("secret_present"), [{ key: "anthropic-api-key" }]);
  assert.deepEqual(sent("chat_models"), []);
  assert.match($(".picker-status").textContent, /No API key/);
});

test("with a key, the models are listed and picking one saves it", async () => {
  answers.secret_present = true;
  answers.chat_models = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), [{ provider: "anthropic" }]);
  assert.deepEqual(models(), ["Claude Opus 5", "Claude Sonnet 5"]);
  view.el.find(".picker-model")[1].fire("click");
  assert.equal(State.settings.model, "claude-sonnet-5");
  assert.equal(sent("save_settings").at(-1).settings.model, "claude-sonnet-5");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  assert.equal($(".model-name").textContent, "claude-sonnet-5");
});

test("switching provider saves it and asks the new provider only", async () => {
  answers.secret_present = (args) => args.key === "google-api-key";
  answers.chat_models = (args) => (args.provider === "google" ? [{ id: "gemini-2.5-flash", label: "gemini-2.5-flash" }] : []);
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), []);
  view.el.find(".picker-chip")[2].fire("click");
  await flush();
  assert.equal(State.settings.chatProvider, "google");
  assert.deepEqual(sent("chat_models"), [{ provider: "google" }]);
  // The saved model was not offered: the flash one is kept instead, and saved.
  assert.equal(State.settings.chatModels.google, "gemini-2.5-flash");
  assert.equal(sent("save_settings").at(-1).settings.chatModels.google, "gemini-2.5-flash");
  assert.deepEqual(models(), ["gemini-2.5-flash"]);
});

test("a local answer streams into one reply, then the finished text replaces it", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const input = $(".chat-input");
  input.value = "hello";
  $(".send-btn").fire("click");
  await flush();
  view.sync(); // what State.notify() does in the island
  assert.ok($(".model-btn").disabled, "no switching mid-answer");
  assert.ok($(".typing"), "dots until the first visible text");

  emit("chat-delta", ""); // still thinking
  assert.ok($(".typing"));
  emit("chat-delta", "Hel");
  emit("chat-delta", "Hello **there**");
  view.sync(); // another view update mid-stream must not wipe the live answer
  assert.equal($(".typing"), null);
  const replies = view.el.find(".reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].find("STRONG")[0].textContent, "there");

  finish({ text: "Hello **there**!" });
  await flush();
  view.sync();
  assert.equal(view.el.find(".reply").length, 1);
  assert.equal(view.el.find(".reply")[0].textContent, "Hello there!");
  assert.deepEqual(State.chatHistory.map((m) => m.role), ["user", "assistant"]);
  assert.ok(!$(".model-btn").disabled);
});

test("Claude Code has its folder, effort and permissions under its models, and the island grows", async () => {
  answers.chat_models = [{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }];
  answers.pick_folder = "C:\\work\\app";
  $(".model-btn").fire("click");
  await flush();
  assert.equal(State.chatPicking, true);
  // Another provider has no such options.
  assert.equal(view.el.find(".picker-opt").length, 0);
  view.el.find(".picker-chip")[1].fire("click");
  await flush();
  assert.equal(State.settings.chatProvider, "claudecode");
  assert.deepEqual(sent("secret_present"), [{ key: "anthropic-api-key" }]); // never asked for a key of its own
  assert.deepEqual(models(), ["Claude Sonnet 5.5"]);
  const rows = () => view.el.find(".picker-opt");
  assert.equal(rows().length, 3);
  // No folder yet: a plain chat, and nothing to ask a permission for.
  assert.match($(".picker-path").textContent, /chat only/);
  assert.ok(rows()[2].classList.contains("off"));

  rows()[0].find(".picker-link")[0].fire("click");
  await flush();
  assert.equal(State.settings.claudeCodeDir, "C:\\work\\app");
  assert.equal($(".picker-path").textContent, "C:\\work\\app");
  assert.ok(!rows()[2].classList.contains("off"));

  rows()[1].find("button")[3].fire("click");
  rows()[2].find("button")[2].fire("click");
  assert.equal(State.settings.claudeCodeEffort, "high");
  assert.equal(State.settings.claudeCodeMode, "plan");
  const saved = sent("save_settings").at(-1).settings;
  assert.deepEqual(
    [saved.claudeCodeDir, saved.claudeCodeEffort, saved.claudeCodeMode],
    ["C:\\work\\app", "high", "plan"],
  );
  // Bypassing permissions is not on offer.
  assert.deepEqual(rows()[2].find("button").map((b) => b.textContent), ["Ask", "Accept edits", "Plan", "Auto"]);

  $(".model-btn").fire("click");
  assert.equal(State.chatPicking, false);
});

test("while Claude Code answers, the send button stops it", async () => {
  State.settings = { ...State.settings, chatProvider: "claudecode" };
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  $(".chat-input").value = "hello";
  $(".send-btn").fire("click");
  await flush();
  assert.ok($(".send-btn").classList.contains("stop"));
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_stop").length, 1);
  assert.equal(sent("chat_send").length, 1);
  finish({ text: "partial" });
  await flush();
  assert.ok(!$(".send-btn").classList.contains("stop"));
});

test("the chat keeps the height it was dragged to, within what the window shows", async () => {
  const { CHAT_MAX_H, CHAT_MIN_H, CHAT_PICKER_H, chatPromptHeight } = await import("../src/core/layout.ts");
  // Never dragged: it follows the conversation, as on the Mac.
  assert.equal(chatPromptHeight(0), 240);
  assert.equal(chatPromptHeight(9), 300);
  assert.equal(chatPromptHeight(0, true), CHAT_PICKER_H);
  // Dragged: that height, whatever the conversation; the picker never gets less than its own.
  assert.equal(chatPromptHeight(9, false, 520), 520);
  assert.equal(chatPromptHeight(0, true, 520), 520);
  assert.equal(chatPromptHeight(0, true, 260), CHAT_PICKER_H);
  assert.equal(chatPromptHeight(0, false, 5000), CHAT_MAX_H);
  assert.equal(chatPromptHeight(0, false, 10), CHAT_MIN_H);
});

test("the text field tells the island when it has the keyboard", async () => {
  $(".chat-input").fire("focus");
  assert.equal(State.chatTyping, true);
  $(".chat-input").fire("blur");
  assert.equal(State.chatTyping, false);
});

test("Claude Code's conversations are listed by folder, and opening one puts it back", async () => {
  const { groupByFolder, folderName } = await import("../src/views/chat.ts");
  assert.equal(folderName("C:\\dev\\coucou"), "coucou");
  assert.equal(folderName("/home/me/py-doc/"), "py-doc");
  const list = [
    { id: "a", title: "review the branch", provider: "claudecode", dir: "C:\\dev\\coucou", updated: 300 },
    { id: "b", title: "what is this?", provider: "claudecode", dir: "", updated: 200 },
    { id: "c", title: "plan review", provider: "claudecode", dir: "C:\\dev\\coucou", updated: 100 },
  ];
  assert.deepEqual(groupByFolder(list).map((g) => [g.dir, g.items.map((c) => c.id)]), [
    ["C:\\dev\\coucou", ["a", "c"]],
    ["", ["b"]],
  ]);

  // Another provider has no list.
  assert.equal($(".convo-btn").style.display, "none");
  State.settings = { ...State.settings, chatProvider: "claudecode" };
  view.sync();
  assert.equal($(".convo-btn").style.display, "");
  assert.equal($(".convo-name").textContent, "Conversations");

  answers.conversations_list = list;
  answers.conversation_open = ({ id }) => ({
    ...list.find((c) => c.id === id),
    model: "claude-opus-5-5",
    turns: [{ role: "user", content: "review the branch" }, { role: "assistant", content: "Looks good." }],
  });
  $(".convo-btn").fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("listing"));
  assert.equal(State.chatPicking, true);
  assert.deepEqual(view.el.find(".convo-group").map((g) => g.textContent), ["coucou", "No folder"]);
  assert.deepEqual(view.el.find(".convo-title").map((r) => r.textContent), ["review the branch", "plan review", "what is this?"]);

  view.el.find(".convo-row")[0].fire("click");
  await flush();
  assert.deepEqual(sent("conversation_open"), [{ id: "a" }]);
  assert.deepEqual(State.chatHistory.map((m) => [m.role, m.content]), [["user", "review the branch"], ["assistant", "Looks good."]]);
  assert.equal(State.conversationId, "a");
  assert.equal(State.settings.claudeCodeDir, "C:\\dev\\coucou");
  assert.equal(State.settings.chatModels.claudecode, "claude-opus-5-5");
  assert.ok(!$(".chat-body").classList.contains("listing"));
  assert.equal($(".convo-name").textContent, "review the branch");

  // "+" on a folder: a new conversation there, and the Rust side starts over.
  $(".convo-btn").fire("click");
  await flush();
  view.el.find(".convo-group")[1].find(".convo-icon")[0].fire("click");
  await flush();
  assert.equal(sent("chat_reset").length, 1);
  assert.deepEqual(State.chatHistory, []);
  assert.equal(State.conversationId, null);
  assert.equal(State.settings.claudeCodeDir, "");
});

test("an answer names the conversation it was saved in, and deleting it forgets that", async () => {
  State.settings = { ...State.settings, chatProvider: "claudecode" };
  answers.chat_send = { text: "hi", conversationId: "c9" };
  $(".chat-input").value = "hello";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(State.conversationId, "c9");

  answers.conversations_list = [{ id: "c9", title: "hello", provider: "claudecode", dir: "", updated: 1 }];
  $(".convo-btn").fire("click");
  await flush();
  assert.ok(view.el.find(".convo-row")[0].classList.contains("on"));
  answers.conversations_list = [];
  view.el.find(".convo-row")[0].find(".convo-icon")[0].fire("click");
  await flush();
  assert.deepEqual(sent("conversation_delete"), [{ id: "c9" }]);
  assert.equal(sent("conversation_open").length, 0); // the row itself was not clicked
  assert.equal(State.conversationId, null);
  assert.match($(".convos").textContent, /No conversations yet/);
});

test("a file Claude Code edits shows as a pill under the answer, and opens its diff", async () => {
  State.settings = { ...State.settings, chatProvider: "claudecode" };
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  $(".chat-input").value = "rename it";
  $(".send-btn").fire("click");
  await flush();
  emit("chat-edit", { tool: "Edit", input: { file_path: "/w/src/app.rs", old_string: "let a = 1;", new_string: "let b = 1;\nlet c = 2;" } });
  emit("chat-edit", { tool: "Bash", input: { command: "ls" } }); // not a file edit
  emit("chat-delta", "Renamed.");
  // While the answer is on its way the pill is already there.
  assert.deepEqual(view.el.find(".edit-name").map((n) => n.textContent), ["app.rs"]);
  finish({ text: "Renamed." });
  await flush();
  view.sync();

  const reply = State.chatHistory.at(-1);
  assert.equal(reply.edits.length, 1);
  assert.deepEqual([reply.edits[0].added, reply.edits[0].removed], [2, 1]);
  const pill = $(".edit-pill");
  assert.equal(pill.textContent, "app.rs+2−1");
  assert.equal(view.el.find(".edit-diff").length, 0);
  pill.fire("click");
  assert.deepEqual($(".edit-diff").find(".diff-line").map((l) => l.textContent), ["−let a = 1;", "+let b = 1;", "+let c = 2;"]);
  pill.fire("click");
  assert.equal(view.el.find(".edit-diff").length, 0);

  // The next turn starts with no edits of its own.
  answers.chat_send = { text: "Nothing to change." };
  $(".chat-input").value = "anything else?";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(State.chatHistory.at(-1).edits, undefined);
});

test("the folder's pull requests are listed in two halves, and only asked for when opened", async () => {
  // Pull requests belong to a folder: no folder, no list.
  State.settings = { ...State.settings, chatProvider: "claudecode" };
  view.sync();
  assert.equal($(".pull-btn").style.display, "none");
  State.settings = { ...State.settings, claudeCodeDir: "/w/app" };
  view.sync();
  assert.equal($(".pull-btn").style.display, "");
  assert.deepEqual(sent("repo_pulls"), []);

  answers.repo_pulls = {
    repo: "me/app",
    remote: [{ number: 7, title: "Add a thing", branch: "feat/thing", url: "https://github.com/me/app/pull/7", draft: true }],
    local: [{ branch: "wip", ahead: 2, pushed: false, current: true }, { branch: "idea", ahead: 1, pushed: true, current: false }],
    note: null,
  };
  $(".pull-btn").fire("click");
  await flush();
  assert.equal(sent("repo_pulls").length, 1);
  assert.equal(State.chatPicking, true);
  const list = $(".pulls");
  assert.deepEqual(list.find(".pull-group").map((g) => g.textContent), ["On GitHubme/app", "Local only"]);
  assert.deepEqual(list.find(".convo-row").map((r) => r.textContent), [
    "#7Add a thingDraftfeat/thing",
    "wipNot pushed2 commits",
    "idea1 commit",
  ]);
  list.find(".convo-row")[0].fire("click");
  assert.deepEqual(sent("open_url"), [{ url: "https://github.com/me/app/pull/7" }]);
  // A local branch opens nothing.
  list.find(".convo-row")[1].fire("click");
  assert.equal(sent("open_url").length, 1);

  // Opening the conversations closes it: one panel at a time.
  answers.conversations_list = [];
  $(".convo-btn").fire("click");
  await flush();
  assert.equal($(".pulls").style.display, "none");
  assert.equal($(".convos").style.display, "");

  // GitHub out of reach: its half says why, the local half still shows.
  answers.repo_pulls = { repo: "me/app", remote: [], local: [], note: "gh: not signed in" };
  $(".pull-btn").fire("click");
  await flush();
  assert.match($(".pulls").textContent, /gh: not signed in/);
  assert.match($(".pulls").textContent, /No local branch waiting/);
});
