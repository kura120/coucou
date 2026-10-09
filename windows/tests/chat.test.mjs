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
  answers.pick_folder = "C:\work\app";
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
  assert.equal(State.settings.claudeCodeDir, "C:\work\app");
  assert.equal($(".picker-path").textContent, "C:\work\app");
  assert.ok(!rows()[2].classList.contains("off"));

  rows()[1].find("button")[3].fire("click");
  rows()[2].find("button")[2].fire("click");
  assert.equal(State.settings.claudeCodeEffort, "high");
  assert.equal(State.settings.claudeCodeMode, "plan");
  const saved = sent("save_settings").at(-1).settings;
  assert.deepEqual(
    [saved.claudeCodeDir, saved.claudeCodeEffort, saved.claudeCodeMode],
    ["C:\work\app", "high", "plan"],
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
