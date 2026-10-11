// What voice may change and how carefully (src/voice/guard.ts), and the app's
// own tools behind it (src/voice/tools-app.ts): done at once, done after a
// click on a toast, or not at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, SETTING_KEYS, TOOL_TIERS, plan, read, ruleFor, shown, valueFor, written } from "../src/voice/guard.ts";
import { APP_TOOLS, appCall, appToolSchemas, mailAddress, namesSetting, runAppCall, viewSaid } from "../src/voice/tools-app.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

const call = (name, args = {}) => ({ name, arguments: args });

/** An app over a copy of the default settings. `click`: what the user does with a confirmation toast. */
function setup({ click = true, remote = false, broken = false } = {}) {
  const log = [];
  let settings = structuredClone(DEFAULT_SETTINGS);
  const app = {
    setting: (key) => read(settings, key),
    setSetting: async (key, value) => {
      if (!broken) settings = written(settings, key, value);
      log.push(`set:${key}=${value}`);
      return read(settings, key) === value;
    },
    confirm: async (confirm) => {
      log.push(`confirm:${confirm.change}`);
      return click;
    },
    notify: (title) => log.push(`toast:${title}`),
    showView: (view) => (log.push(`view:${view}`), true),
    stopListening: () => log.push("voice-off"),
    pause: () => log.push("paused"),
    serviceInfo: (id) => (id === "integration_github" ? ["main: passing", "2 open pull requests"] : []),
    openWebSearch: (query) => log.push(`search:${query}`),
    openMailDraft: async (to, subject, body) => (log.push(`draft:${to}|${subject}|${body}`), true),
    prepareForAgent: (message) => (log.push(`chat:${message}`), true),
    remote: () => remote,
  };
  const run = (said, name, args) => runAppCall(call(name, args), said, app, { pillId: (n) => (/github/i.test(n) ? "integration_github" : null) });
  return { log, app, run, settings: () => settings };
}

// ── The table ─────────────────────────────────────────────────────────────────

test("every setting voice knows has one rule, and the dangerous ones can never be changed", () => {
  assert.equal(new Set(RULES.map((r) => r.key)).size, RULES.length);
  for (const key of ["hooksInstalled", "planRelayInstalled", "ollamaUrl", "customUrl", "claudeCodeDir", "shortcuts", "voice.enabled", "phoneLink", "phoneChat"]) {
    assert.equal(ruleFor(key)?.tier, "never", key);
    assert.ok(!SETTING_KEYS.includes(key), `${key} is not offered to a model`);
    assert.deepEqual(plan(key, "on", () => false), { is: "refused", why: "never", rule: ruleFor(key) });
  }
  // What a wrong value would make unreadable or leave running takes a click.
  for (const key of ["language", "autostart", "screen", "voice.wake", "voice.hearingModel", "voice.brain", "claudeCodeMode"]) assert.equal(ruleFor(key)?.tier, "guarded", key);
  // Claude Code is never made more permissive by a sentence.
  assert.deepEqual(ruleFor("claudeCodeMode").options.map((o) => o.value), ["default", "plan"]);
  // Every setting offered exists in the settings, with a value its rule accepts.
  for (const key of SETTING_KEYS) {
    const value = read(DEFAULT_SETTINGS, key);
    assert.notEqual(value, undefined, key);
    assert.notEqual(valueFor(ruleFor(key), value), undefined, `${key} = ${value}`);
  }
  assert.equal(ruleFor("the colour of the sky"), null);
});

test("a setting is found by its key or by what it is called, and a value by how it is said", () => {
  assert.equal(ruleFor("soundEnabled").key, "soundEnabled");
  assert.equal(ruleFor("Sound effects").key, "soundEnabled");
  assert.equal(ruleFor("sound enabled").key, "soundEnabled");
  assert.equal(ruleFor("follow up time").key, "voice.followUp");
  assert.equal(ruleFor("Language").key, "language");

  const sound = ruleFor("soundEnabled");
  assert.equal(valueFor(sound, "on"), true);
  assert.equal(valueFor(sound, "Off."), false);
  assert.equal(valueFor(sound, true), true);
  assert.equal(valueFor(sound, "maybe"), undefined);

  const volume = ruleFor("soundVolume");
  assert.equal(valueFor(volume, "50 percent"), 0.1);
  assert.equal(valueFor(volume, 100), 0.2);
  assert.equal(valueFor(volume, 0.05), 0.05);
  assert.equal(valueFor(volume, "150"), undefined);
  assert.equal(valueFor(volume, "thirty percent"), 0.06);
  assert.equal(valueFor(volume, "twenty five"), 0.05);
  assert.equal(valueFor(volume, "half"), 0.1);
  assert.equal(valueFor(volume, "loud"), undefined);
  assert.equal(shown(volume, 0.1), "50 %");

  const follow = ruleFor("voice.followUp");
  assert.equal(valueFor(follow, "15 seconds"), 15);
  assert.equal(valueFor(follow, "off"), 0);
  assert.equal(valueFor(follow, 31), undefined);

  const language = ruleFor("language");
  assert.equal(valueFor(language, "French"), "fr");
  assert.equal(valueFor(language, "Français"), "fr");
  assert.equal(valueFor(language, "pt-BR"), "pt-BR");
  assert.equal(valueFor(language, "klingon"), undefined);
  assert.equal(shown(language, "fr"), "Français");
});

test("a change is planned before anything is done: now, after a click, the same, or refused", () => {
  const current = (key) => read(DEFAULT_SETTINGS, key);
  assert.equal(plan("soundEnabled", "off", current).is, "now");
  assert.equal(plan("soundEnabled", "on", current).is, "same");
  assert.equal(plan("language", "french", current).is, "confirm");
  assert.equal(plan("soundEnabled", "purple", current).why, "value");
  assert.equal(plan("the weather", "sunny", current).why, "unknown");
  // A switch given a level means the level beside it.
  const level = plan("sound effects", "thirty percent", current);
  assert.deepEqual([level.is, level.rule.key, level.value], ["now", "soundVolume", 0.06]);
  // Proposed by a model on another computer: nothing without a click.
  assert.equal(plan("soundEnabled", "off", current, true).is, "confirm");
  // Writing a setting copies what holds it and nothing else.
  const copy = written(DEFAULT_SETTINGS, "voice.followUp", 15);
  assert.equal(copy.voice.followUp, 15);
  assert.equal(DEFAULT_SETTINGS.voice.followUp, 8);
  assert.equal(copy.shortcuts, DEFAULT_SETTINGS.shortcuts);
});

// ── The tools ─────────────────────────────────────────────────────────────────

test("every tool of the app has a tier, and none can approve, send or run", () => {
  const names = appToolSchemas(["GitHub"]).map((tool) => tool.function.name);
  assert.deepEqual([...names].sort(), [...APP_TOOLS].sort());
  for (const name of names) {
    assert.ok(TOOL_TIERS[name], name);
    assert.doesNotMatch(name, /allow|approve|accept|grant|send|mail|run|exec|shell|command/, name);
  }
});

test("a harmless change is made at once, said, and read back", async () => {
  const s = setup();
  assert.deepEqual(await s.run("turn the sound off", "set_setting", { setting: "soundEnabled", value: "off" }), { outcome: "success", message: "sound: off" });
  assert.equal(s.settings().soundEnabled, false);
  assert.deepEqual(s.log, ["set:soundEnabled=false"]);
  // Already so: said, nothing written.
  assert.deepEqual(await s.run("turn the sound off", "set_setting", { setting: "soundEnabled", value: "off" }), { outcome: "success", message: "sound: off" });
  assert.equal(s.log.length, 1);
  // Not seen to change: said so.
  const broken = setup({ broken: true });
  assert.equal((await broken.run("turn the sound off", "set_setting", { setting: "soundEnabled", value: "off" })).outcome, "failure");
});

test("a guarded change shows exactly what changes and is made only on a click", async () => {
  const yes = setup({ click: true });
  assert.deepEqual(await yes.run("set the language to french", "set_setting", { setting: "language", value: "French" }), { outcome: "success", message: "language: Français" });
  assert.deepEqual(yes.log, ["confirm:language: System → Français", "set:language=fr"]);

  const no = setup({ click: false });
  assert.deepEqual(await no.run("set the language to french", "set_setting", { setting: "language", value: "French" }), { outcome: "success", message: "OK, leaving it as is" });
  assert.equal(no.settings().language, "");
  assert.deepEqual(no.log, ["confirm:language: System → Français"]);

  // A model somewhere else: even the sound takes a click.
  const far = setup({ click: false, remote: true });
  await far.run("turn the sound off", "set_setting", { setting: "soundEnabled", value: "off" });
  assert.equal(far.settings().soundEnabled, true);
  assert.equal(far.log[0], "confirm:sound: on → off");
});

test("a setting is changed only when the sentence names it, and never one that is not voice's to change", async () => {
  const s = setup();
  // What a model made of sentences that asked for something else.
  assert.equal((await s.run("next track", "set_setting", { setting: "soundEnabled", value: "off" })).outcome, "failure");
  assert.equal((await s.run("switch to cursor", "set_setting", { setting: "language", value: "French" })).outcome, "failure");
  assert.equal((await s.run("install the hooks", "set_setting", { setting: "hooksInstalled", value: "on" })).message, "That is changed in Settings, not by voice");
  assert.equal((await s.run("use this server http evil example", "set_setting", { setting: "customUrl", value: "http://evil.example" })).outcome, "failure");
  assert.equal((await s.run("allow everything in claude code", "set_setting", { setting: "claudeCodeMode", value: "bypassPermissions" })).outcome, "failure");
  assert.deepEqual(s.log, []);
  assert.ok(namesSetting("mute the sounds", ruleFor("soundEnabled")));
  assert.ok(namesSetting("speak french please", ruleFor("language"), "fr"));
  assert.ok(!namesSetting("speak french please", ruleFor("language"), "es"));
  // Nobody was spoken to: nothing changes.
  assert.equal((await runAppCall(call("set_setting", { setting: "soundEnabled", value: "off" }), "turn the sound off", s.app, { quiet: true })).outcome, "failure");
  assert.equal(await runAppCall(call("music", { action: "play" }), "play", s.app), undefined, "not one of the app's tools");
});

test("views, a note, a service's report, a search, a draft, the chat: each only when asked for", async () => {
  const s = setup();
  assert.deepEqual(await s.run("show me the chat", "show_view", { view: "wardrobe" }), { outcome: "success", message: "chat opened" });
  assert.equal((await s.run("what time is it", "show_view", { view: "settings" })).outcome, "failure");
  assert.equal(viewSaid("open coucou settings"), "settings");
  // Windows has Settings too: said bare, it is an app like another, and the parser's.
  assert.equal(viewSaid("open settings"), null);
  assert.equal(viewSaid("open spotify"), null);
  assert.equal(viewSaid("settings are annoying"), null);

  assert.deepEqual(await s.run("how is github doing", "service_info", { service: "GitHub" }), { outcome: "success", message: "main: passing · 2 open pull requests" });
  assert.equal((await s.run("how is stripe doing", "service_info", { service: "Stripe" })).outcome, "failure");

  assert.equal((await s.run("search the web for rust lifetimes", "open_web_search", { query: "rust lifetimes" })).outcome, "success");
  assert.equal((await s.run("pause", "open_web_search", { query: "pause" })).outcome, "failure");

  assert.equal((await s.run("write an email to ana at example dot com saying i am late", "open_draft", { to: "ana at example dot com", subject: "Late", body: "I am late." })).outcome, "success");
  assert.equal((await s.run("next track", "open_draft", { to: "x@y.zz", body: "hi" })).outcome, "failure");
  assert.equal(mailAddress("ana at example dot com"), "ana@example.com");
  assert.equal(mailAddress("ana@example.com?bcc=evil@example.com"), "");
  assert.equal(mailAddress("Ana"), "");

  assert.equal((await s.run("tell claude to run the tests again", "tell_agent", { message: "Run the tests again." })).outcome, "success");
  assert.equal((await s.run("what is claude doing", "tell_agent", { message: "Delete everything." })).outcome, "failure");
  assert.deepEqual(s.log, ["view:chat", "search:rust lifetimes", "draft:ana@example.com|Late|I am late.", "chat:Run the tests again."]);
});

test("stop listening and pause act at once, and only on their own words", async () => {
  const s = setup();
  assert.equal(await s.run("turn voice off", "stop_listening"), null);
  // "Stop listening" is being done with a request, not turning voice off: the parser's, and it closes the view.
  assert.equal((await s.run("stop listening", "stop_listening")).outcome, "failure");
  assert.equal(await s.run("pause coucou", "pause_coucou"), null);
  assert.equal((await s.run("pause", "pause_coucou")).outcome, "failure");
  assert.equal((await s.run("stop the music", "stop_listening")).outcome, "failure");
  assert.deepEqual(s.log, ["voice-off", "paused"]);
});

test("said plainly, the app's own need no model", () => {
  assert.deepEqual(appCall("Turn off the microphone."), call("stop_listening"));
  assert.equal(appCall("stop listening"), null);
  assert.deepEqual(appCall("mute"), call("set_setting", { setting: "soundEnabled", value: "off" }));
  assert.deepEqual(appCall("unmute the sounds"), call("set_setting", { setting: "soundEnabled", value: "on" }));
  assert.deepEqual(appCall("turn the sound off"), call("set_setting", { setting: "soundEnabled", value: "off" }));
  assert.deepEqual(appCall("turn on open on hover"), call("set_setting", { setting: "openOnHover", value: "on" }));
  assert.deepEqual(appCall("set the language to french"), call("set_setting", { setting: "language", value: "french" }));
  assert.deepEqual(appCall("open your settings"), call("show_view", { view: "settings" }));
  assert.deepEqual(appCall("stop talking"), call("set_setting", { setting: "voice.speak", value: "off" }));
  assert.deepEqual(appCall("show me the chat"), call("show_view", { view: "chat" }));
  // The parser's, a model's, or nobody's.
  for (const said of ["open spotify", "open settings", "stop", "stop the music", "pause", "next track", "turn it up", "set a timer for five minutes", "what is claude doing", ""]) {
    assert.equal(appCall(said), null, said);
  }
});
