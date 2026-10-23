// Where the island sends the user to Settings: an idle card's "Settings…" opens
// the page about that pill (Integrations, Agents, Claude Code, Chat providers,
// Claude API), and Bridge.openSettingsWindow passes the page on. Every page
// named here must be a leaf id of the tree in src/settings/main.ts.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calls, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import { renderIntegrationCard, settingsPageFor } from "../src/views/integrations.ts";
import { Bridge } from "../src/core/bridge.ts";
import { PILL_CATALOG } from "../src/core/pills.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

installFakeDom();

// The leaf ids of TREE, read from the source: the settings window is not imported here.
const SETTINGS_SOURCE = readFileSync(new URL("../src/settings/main.ts", import.meta.url), "utf8");
const treeStart = SETTINGS_SOURCE.indexOf("const TREE");
const treeEnd = SETTINGS_SOURCE.indexOf("];\n", treeStart);
const LEAVES = [...SETTINGS_SOURCE.slice(treeStart, treeEnd).matchAll(/\["([a-z][a-z-]*)", /g)].map((m) => m[1]);

const task = (id) => ({
  id, name: id, color: "#ffffff", state: "idle", stepIndex: 0, steps: [], source: "n8n", isIntegration: true,
});

/** Renders the idle card of `id`, clicks its "Settings…" link, and returns every page it asked for. */
function pagesAskedBy(id) {
  const asked = [];
  const el = renderIntegrationCard(task(id), {
    detailOpen: false,
    openDetail() {},
    closeDetail() {},
    openSettings: (page) => asked.push(page),
  });
  const link = el.find("BUTTON").find((b) => b.textContent === "Settings…");
  if (link) link.fire("click");
  return asked;
}

beforeEach(() => {
  setLanguage("en");
  calls.length = 0;
  for (const id of Object.keys(State.integrations)) delete State.integrations[id];
  State.settings = { ...DEFAULT_SETTINGS };
});

test("the tree's leaf ids are read from the settings source", () => {
  assert.ok(LEAVES.includes("integrations"));
  assert.ok(LEAVES.includes("agents"));
  assert.ok(LEAVES.includes("claude-code"));
  assert.ok(LEAVES.includes("chat-providers"));
  assert.ok(LEAVES.includes("claude-api"));
  assert.equal(LEAVES.length, 18);
});

test("every pill sends the island to a leaf of the settings tree", () => {
  for (const pill of PILL_CATALOG) {
    assert.ok(LEAVES.includes(settingsPageFor(pill.id)), `${pill.id} -> ${settingsPageFor(pill.id)}`);
  }
});

test("an agent whose hooks are not installed asks for Agents", () => {
  assert.deepEqual(pagesAskedBy("agent_gemini"), ["agents"]);
  assert.deepEqual(pagesAskedBy("agent_codex"), ["agents"]);
  assert.deepEqual(pagesAskedBy("agent_cursor"), ["agents"]);
});

test("Claude Code's hooks ask for its own page, where they are installed", () => {
  assert.deepEqual(pagesAskedBy("integration_claude"), ["claude-code"]);
});

test("an integration with nothing connected asks for Integrations", () => {
  assert.deepEqual(pagesAskedBy("integration_stripe"), ["integrations"]);
  assert.deepEqual(pagesAskedBy("integration_resend"), ["integrations"]);
  assert.deepEqual(pagesAskedBy("integration_notion"), ["integrations"]);
  assert.deepEqual(pagesAskedBy("integration_n8n"), ["integrations"], "the n8n card with no run yet");
});

test("a chat provider without a key asks for Chat providers, Anthropic for Claude API", () => {
  assert.deepEqual(pagesAskedBy("ai_google"), ["chat-providers"]);
  assert.deepEqual(pagesAskedBy("ai_openai"), ["chat-providers"]);
  assert.deepEqual(pagesAskedBy("ai_anthropic"), ["claude-api"]);
});

test("a connected integration shows no Settings link, so it asks for nothing", () => {
  State.integrations.integration_resend = { data: {}, error: null, loaded: true, configured: true };
  assert.deepEqual(pagesAskedBy("integration_resend"), []);
});

test("Bridge.openSettingsWindow sends the page to Rust", async () => {
  await Bridge.openSettingsWindow("agents");
  assert.deepEqual(sent("open_settings_window"), [{ page: "agents" }]);
});
