// The app behind the declarations (src/island/app.ts): the real host on the
// app's own state, with Rust stood in for (tests/tauri.mjs). No island is
// built: what the host needs of it is given as plain functions.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { calls, sent } from "./tauri.mjs";
import { createAppHost, createAppRegistry, guardHost, readSetting, registryWords, withSetting } from "../src/island/app.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { SETTINGS } from "../src/capabilities/settings.ts";
import { searchUrl } from "../src/core/search.ts";
import { VIEW_SCREENS } from "../src/island/screen.ts";

let went;
let paused;

function ports(over = {}) {
  went = [];
  paused = [];
  return {
    desktop: () => ({ supported: false, controller: { phase: "home", flyOutOrHome: async () => {}, flyHome: async () => {} } }),
    place: () => ({ view: State.view, open: State.mode === "expanded" }),
    goTo: (view) => went.push(view),
    showWaitingCard: () => State.pendingApproval != null,
    declineWaiting: () => {
      const waiting = State.pendingApproval != null;
      State.pendingApproval = null;
      return waiting;
    },
    answerWaiting: () => true,
    prefillChat: () => true,
    wearOutfit: (selection) => {
      State.settings.peikaOutfit = selection;
    },
    settingsChanged: () => {},
    setPaused: (on) => {
      paused.push(on);
      State.paused = on;
    },
    screen: () => ({ view: State.view, subjects: [] }),
    webSearched: () => {},
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  State.settings = structuredClone(DEFAULT_SETTINGS);
  State.pendingApproval = null;
  State.paused = false;
  State.view = "overview";
  State.mode = "compact";
});

test("a setting is read and written by its path, and nothing else is touched", () => {
  const before = structuredClone(DEFAULT_SETTINGS);
  const after = withSetting(before, "voice.followUp", 15);
  assert.equal(readSetting(after, "voice.followUp"), 15);
  assert.equal(readSetting(before, "voice.followUp"), DEFAULT_SETTINGS.voice.followUp);
  assert.equal(after.voice.speak, before.voice.speak);
  assert.equal(readSetting(withSetting(before, "soundEnabled", false), "soundEnabled"), false);
  assert.equal(readSetting(before, "nothing.here"), undefined);
});

test("every setting of the schema exists in the app's settings", () => {
  for (const spec of SETTINGS) assert.notEqual(readSetting(DEFAULT_SETTINGS, spec.key), undefined, spec.key);
});

test("a setting changed is saved, and reads back", async () => {
  const host = createAppHost(ports());
  assert.equal(await host.setSetting("voice.speak", true), true);
  assert.equal(host.setting("voice.speak"), true);
  assert.equal(sent("save_settings").length, 1);
});

test("the view is named as show_view takes it, and a view is asked of the island", () => {
  const host = createAppHost(ports());
  State.view = "prompt";
  State.mode = "expanded";
  assert.deepEqual(host.currentView(), { view: "chat", open: true });
  State.view = "empty";
  assert.equal(host.currentView().view, "overview");
  State.view = "approval";
  assert.equal(host.currentView().view, "approval");
  assert.equal(host.showView("chat"), true);
  assert.equal(host.showView("wardrobe"), true);
  assert.deepEqual(went, ["prompt", "wardrobe"]);
  assert.equal(host.showView("settings"), true);
  assert.equal(sent("open_settings_window").length, 1);
  State.paused = true;
  assert.equal(host.showView("chat"), false);
});

test("the displays include the main one and the one under the cursor", async () => {
  const host = createAppHost(ports());
  assert.deepEqual((await host.monitors()).map((m) => m.value), ["primary", "cursor"]);
});

test("pausing goes through the island, which hides", () => {
  const host = createAppHost(ports());
  host.setPaused(true);
  assert.deepEqual(paused, [true]);
  assert.equal(host.paused(), true);
});

test("the waiting card: a permission is read, a question is read, and declining is the island's", () => {
  const host = createAppHost(ports());
  assert.equal(host.permission(), null);
  State.pendingApproval = { requestId: "r1", sessionId: "s", pillId: "integration_claude", tool: "Bash", command: "rm -rf build" };
  assert.deepEqual(host.permission(), { agent: "VS Code", request: "Bash: rm -rf build" });
  assert.equal(host.agentQuestion(), null);
  assert.equal(host.declinePermission(), true);
  assert.equal(host.permission(), null);
  State.pendingApproval = {
    requestId: "r2", sessionId: "s", pillId: "integration_claude", tool: "AskUserQuestion", command: "",
    questions: [{ question: "Which one?", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }],
  };
  assert.equal(host.permission(), null);
  assert.equal(host.agentQuestion().questions[0].question, "Which one?");
});

test("the timer counts down in minutes and is cancelled", () => {
  const host = createAppHost(ports());
  assert.equal(host.timer(), null);
  host.setTimer(5, "tea");
  assert.deepEqual(host.timer(), { label: "tea", minutesLeft: 5 });
  assert.equal(host.cancelTimer(), true);
  assert.equal(host.cancelTimer(), false);
});

test("a web search that cannot be made says why, and opening one uses the engine chosen", async () => {
  const host = createAppHost(ports());
  // The stand-in for Rust answers null: no results came.
  const found = await host.webSearch("mount everest");
  assert.ok("results" in found || "error" in found);
  State.settings.searchEngine = "duckduckgo";
  host.openWebSearch("mount everest");
  assert.equal(sent("open_url").at(-1).url, "https://duckduckgo.com/?q=mount%20everest");
  assert.equal(searchUrl("a b", "nobody's"), "https://www.google.com/search?q=a%20b");
});

test("the registry of the app: every capability declared, and the screen is the island's", async () => {
  const registry = createAppRegistry(ports({ screen: () => ({ view: "prompt", subjects: [{ kind: "chat_model", id: "ollama/x", label: "x" }] }) }));
  assert.ok(registry.all().length >= 64);
  for (const name of ["pause_music", "show_view", "set_setting", "decline_permission", "undo", "more_tools", "escalate", "nothing"]) assert.ok(registry.get(name), name);
  // Approving a permission is nowhere: the one name for it only brings the card up, free, and asks nothing of Rust.
  assert.deepEqual(registry.all().filter((c) => /approve|allow/.test(c.name)).map((c) => [c.name, c.tier]), [["approve_permission_request", "free"]]);
  const snapshot = await registry.snapshot();
  assert.equal(snapshot.screen.view, "prompt");
});

test("the guard is a click on a toast: with nobody to click, it is no", async () => {
  assert.equal(await guardHost.confirm({ title: "Quit Peika?", change: "Peika closes.", action: "Quit" }), false);
  assert.equal(sent("toast_ask").length, 1);
});

test("the executor's lines are worded", () => {
  assert.equal(registryWords.which(["A", "B"]), "A or B?");
  assert.equal(registryWords.which(["A", "B", "C"]), "A, B or C?");
  assert.equal(registryWords.one("Spotify"), "Did you mean Spotify?");
  assert.ok(registryWords.notFound("x".repeat(100)).length < 60);
});

test("each view says what it shows, in the app's kinds", () => {
  State.pendingApproval = { requestId: "r1", sessionId: "s", pillId: "integration_claude", tool: "Bash", command: "npm test" };
  const shown = VIEW_SCREENS.approval();
  assert.deepEqual(shown.subjects, [{ kind: "session", id: "integration_claude", label: "VS Code" }]);
  assert.match(shown.summary, /Bash: npm test/);
  State.pendingApproval = null;
  assert.deepEqual(VIEW_SCREENS.approval().subjects, []);
  assert.equal(VIEW_SCREENS.wardrobe().subjects[0].kind, "outfit");
  assert.equal(VIEW_SCREENS.prompt().subjects[0].kind, "chat_model");
});
