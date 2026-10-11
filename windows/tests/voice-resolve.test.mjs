// Naming things (src/voice/resolve.ts, doc/voice-turns.md section 4): a name
// is surely something, may be one of a few, or is nothing — and what is only
// nearly named is asked about, whatever it names. Also what #42 left: a
// misheard verb, "that one", and a correction that swaps.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { availablePills } from "../src/core/pills.ts";
import { answerOf, askWhich, intentQuestion, nearlyNamed } from "../src/voice/ask.ts";
import { VoiceConversation } from "../src/voice/conversation.ts";
import { matchPill } from "../src/voice/entity.ts";
import { buildGrammar, sentences } from "../src/voice/grammar.ts";
import { parseIntent } from "../src/voice/intent.ts";
import { resolveRelative, withPronoun } from "../src/voice/memory.ts";
import { certain, heardWith, howNamed, likeness, provideNames, resolveName, sureOf } from "../src/voice/resolve.ts";
import { VoiceRunner } from "../src/voice/runner.ts";
import { applyVoice } from "../src/island/voice.ts";
import { names } from "../src/voice/tools.ts";

const PILLS = availablePills("windows");
const APPS = ["Spotify", "Steam", "Discord", "Figma", "Visual Studio Code", "Visual Studio 2022", "Claude"];
/** What Rust's `near` ranks for a name that is no app. */
const NEAR = { "spy flight": ["Spotify"], "this squad": ["Discord"], "st": ["Spotify", "Steam"], "this cord": ["Discord"] };
/** What Rust's `find` takes for an app by its sound. */
const FOUND = { "this cord": "Discord", "spotifi": "Spotify" };

const flat = (said) => said.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

async function appsNear(said) {
  const text = ` ${flat(said)} `;
  const found = APPS.find((a) => ` ${a.toLowerCase()} ` === text) ?? FOUND[text.trim()] ?? null;
  const named = APPS.filter((a) => text.includes(` ${a.toLowerCase()} `));
  if (named.length) return { found, names: named.slice(0, 3), scores: named.slice(0, 3).map(() => 1), clear: named.length === 1 };
  const heard = Object.keys(NEAR).find((key) => text.includes(` ${key} `));
  return heard ? { found, names: NEAR[heard], scores: NEAR[heard].map(() => 0.8), clear: NEAR[heard].length === 1 } : { found, names: [], scores: [], clear: false };
}

function setup({ brain = null, active = ["integration_github", "integration_stripe"], sessions = ["agent_codex"] } = {}) {
  const log = [];
  const asked = [];
  const pills = { active: [...active], main: "integration_claude" };
  const state = { playing: true, now: 1_000_000 };
  const runner = new VoiceRunner(
    {
      enabled: () => true, running: () => true, playing: () => state.playing, shuffle: () => false, repeat: () => false,
      playPause: () => {
        state.playing = !state.playing;
        log.push(state.playing ? "play" : "pause");
      },
      next: () => log.push("next"), previous: () => log.push("previous"),
      setShuffle: (on) => log.push(`shuffle:${on}`), setRepeat: (on) => log.push(`repeat:${on}`), open: () => log.push("openSpotify"),
    },
    {
      active: () => [...pills.active],
      main: () => pills.main,
      hasRoomFor: () => pills.active.length < 6,
      limit: () => 6,
      toggle: (id) => {
        const on = !pills.active.includes(id);
        pills.active = on ? [...pills.active, id] : pills.active.filter((x) => x !== id);
        log.push(`${on ? "+" : "-"}${id.replace(/^(integration|agent|ai)_/, "")}`);
      },
      setMain: (id) => {
        log.push(`main:${id.replace(/^(integration|agent|ai)_/, "")}`);
        pills.main = id;
      },
    },
    () => PILLS,
  );
  const world = {
    agents: () => sessions.map((id) => ({ id, name: id, state: "working", doing: "" })),
    openSession: (id) => (log.push(`session:${id}`), sessions.includes(id)),
    permission: () => null,
    showPermission: () => log.push("showPermission"),
    declinePermission: () => log.push("DECLINE"),
    timer: () => null,
    setTimer: () => {},
    cancelTimer: () => false,
    openApp: async (name) => {
      const app = APPS.find((a) => a.toLowerCase() === flat(name)) ?? FOUND[flat(name)] ?? null;
      if (app) log.push(`app:${app}`);
      return app;
    },
    appsNear,
    openFolder: async (name) => (/download/i.test(name) ? (log.push("folder:Downloads"), "Downloads") : null),
    openUrl: (url) => log.push(`url:${url}`),
    nowPlaying: () => null,
    reports: () => ({}),
  };
  const ask = brain
    ? async (system, said, tools, history) => {
        asked.push({ system, said, tools, history });
        return brain(said);
      }
    : null;
  const conversation = new VoiceConversation(runner, world, () => PILLS, () => ask, () => state.now);
  const card = (result) => (result ? { outcome: result.outcome, message: result.message } : result);
  return {
    log, asked, conversation, runner, state, pills,
    hear: async (said, how) => card(await conversation.hear(said, how)),
    full: (said, how) => conversation.hear(said, how),
    answer: async (given) => card(await conversation.answerAsked(given)),
  };
}

const call = (name, args = {}) => ({ name, arguments: args });
const question = (message) => ({ outcome: "question", message });
const done = (message) => ({ outcome: "success", message });

beforeEach(() => {
  heardWith("", null);
  provideNames({ apps: appsNear, pills: () => PILLS, sessions: () => [{ id: "agent_codex" }, { id: "integration_claude" }] });
});

// ── The resolver ──────────────────────────────────────────────────────────────

test("a name is surely something, may be one of a few, or is nothing — for every kind", async () => {
  const sure = (id, label) => ({ is: "sure", id, label });
  const labels = (resolved) => (resolved.is === "unsure" ? resolved.candidates.map((c) => c.label) : resolved.is);
  // Apps: Rust says which it is and which are near.
  assert.deepEqual(await resolveName("app", "Spotify"), sure("Spotify", "Spotify"));
  assert.deepEqual(await resolveName("app", "this cord"), sure("Discord", "Discord"));
  assert.deepEqual(labels(await resolveName("app", "spy flight")), ["Spotify"]);
  assert.deepEqual(labels(await resolveName("app", "st")), ["Spotify", "Steam"]);
  assert.deepEqual(await resolveName("app", "photoshop"), { is: "none" });
  // Pills: said as they are, or spelt by their sound, is sure; a letter or two away is not.
  assert.deepEqual(await resolveName("pill", "stripe"), sure("integration_stripe", "Stripe"));
  assert.deepEqual(await resolveName("pill", "versal"), sure("integration_vercel", "Vercel"));
  assert.deepEqual(await resolveName("pill", "get hub"), sure("integration_github", "GitHub"));
  assert.deepEqual(labels(await resolveName("pill", "strife")), ["Stripe"]);
  assert.deepEqual(labels(await resolveName("pill", "strike")), ["Stripe"]);
  assert.deepEqual(await resolveName("pill", "the weather"), { is: "none" });
  // The main pill is a workspace tool: Stripe is none.
  assert.deepEqual(await resolveName("workspace", "codex"), sure("agent_codex", "Codex"));
  assert.deepEqual(await resolveName("workspace", "stripe"), { is: "none" });
  // A session: only what has one.
  assert.deepEqual(await resolveName("session", "codex"), sure("agent_codex", "Codex"));
  assert.deepEqual(await resolveName("session", "cursor"), { is: "none" });
  // Folders: the user's own, by their everyday names.
  assert.deepEqual(await resolveName("folder", "my downloads folder"), sure("Downloads", "Downloads"));
  assert.deepEqual(await resolveName("folder", "document"), sure("Documents", "Documents"));
  assert.deepEqual(await resolveName("folder", "system32"), { is: "none" });
  // What only the caller can list: views, settings, contacts, playlists.
  const views = [{ id: "overview", label: "Overview" }, { id: "settings", label: "Settings" }, { id: "wardrobe", label: "Wardrobe", spoken: ["outfits", "clothes"] }];
  assert.deepEqual(await resolveName("view", "settings", views), sure("settings", "Settings"));
  assert.deepEqual(await resolveName("view", "the outfits", views), sure("wardrobe", "Wardrobe"));
  assert.deepEqual(labels(await resolveName("view", "war drove", views)), ["Wardrobe"]);
  assert.deepEqual(await resolveName("view", "the weather", views), { is: "none" });
  assert.deepEqual(await resolveName("view", "settings"), { is: "none" }, "nothing to choose among");
  const contacts = [{ id: "1", label: "Anna Martin" }, { id: "2", label: "Anne Martin" }, { id: "3", label: "Louis" }];
  assert.deepEqual(await resolveName("contact", "louis", contacts), sure("3", "Louis"));
  // Two as near as each other: both, to choose between.
  assert.deepEqual(labels(await resolveName("contact", "martin", contacts)), ["Anna Martin", "Anne Martin"]);
  assert.deepEqual(labels(await resolveName("contact", "ana martin", contacts)), ["Anna Martin", "Anne Martin"]);
  const playlists = [{ id: "a", label: "Deep Focus" }, { id: "b", label: "Discover Weekly" }];
  assert.deepEqual(await resolveName("playlist", "deep focus", playlists), sure("a", "Deep Focus"));
  assert.deepEqual(labels(await resolveName("playlist", "deep focused", playlists)), ["Deep Focus"]);
  for (const kind of ["app", "pill", "workspace", "folder", "session", "view"]) assert.deepEqual(await resolveName(kind, "  ... "), { is: "none" }, kind);
});

test("how alike two names are: letters, or how they sound", () => {
  assert.equal(likeness("spotify", "Spotify"), 1);
  assert.ok(likeness("strife", "stripe") >= 0.8);
  assert.ok(likeness("this squad", "discord") >= 0.75, "the same sounds but one");
  assert.equal(likeness("photoshop", "photos"), 0);
  assert.equal(likeness("ocean", "notion"), 0);
});

test("how sure the speech model was of a word comes with the sentence, and a name it doubted is asked about", async () => {
  // As Rust reports "Open this cord." — the name's words were a guess.
  applyVoice({ voiceHeard() {} }, { phase: "final", text: "Open this cord.", sure: [0.92, 0.4, 0.83] });
  assert.equal(sureOf("this cord"), 0.4);
  assert.equal(sureOf("open"), 0.92);
  assert.equal(sureOf("spotify"), null, "not in the sentence: nothing is known");
  // Found by its sound, but on words the model was unsure of: asked about.
  assert.deepEqual(await resolveName("app", "this cord"), { is: "unsure", candidates: [{ id: "Discord", label: "Discord", score: 0.9 }] });
  // The same words written surely: opened.
  heardWith("Open this cord.", [0.92, 0.9, 0.83]);
  assert.equal((await resolveName("app", "this cord")).is, "sure");
  // A name spelt as it is written is never questioned, however unsure the model was.
  heardWith("launch figma", [0.26, 0.34]);
  assert.equal((await resolveName("app", "figma")).is, "sure");
  heardWith("remove stripe", [0.3, 0.2]);
  assert.equal((await resolveName("pill", "stripe")).is, "sure");
  // "Kodaks" is Codex by its sound — unless the model itself doubted the word.
  heardWith("switch to kodaks", [0.97, 0.98, 0.62]);
  assert.equal((await resolveName("workspace", "kodaks")).is, "sure");
  heardWith("switch to kodaks", [0.97, 0.98, 0.3]);
  assert.equal((await resolveName("workspace", "kodaks")).is, "unsure");
  // No numbers, or not one for each word: nothing is known, which is not unsure.
  heardWith("switch to kodaks", [0.1]);
  assert.equal(sureOf("kodaks"), null);
  assert.equal((await resolveName("workspace", "kodaks")).is, "sure");
  heardWith("switch to kodaks", undefined);
  assert.ok(certain(matchPill("kodaks", PILLS)));
});

test("in a conversation: the app the model doubted is asked about, then opened on the yes", async () => {
  const s = setup();
  heardWith("Open this cord.", [0.92, 0.4, 0.83]);
  assert.deepEqual(await s.hear("Open this cord."), question("Open Discord?"));
  assert.deepEqual(s.log, []);
  assert.deepEqual(await s.hear("yes"), done("Discord opened"));
  // Heard surely, the same sentence opens it at once, as before.
  heardWith("Open this cord.", [0.92, 0.9, 0.83]);
  assert.deepEqual(await s.hear("Open this cord."), done("Discord opened"));
});

// ── Pills go through it too ───────────────────────────────────────────────────

test("a pill that was only nearly named is asked about: remove strife", async () => {
  const s = setup();
  assert.deepEqual(await s.hear("remove strife"), question("Remove Stripe?"));
  assert.deepEqual(s.log, [], "nothing is removed on a guess");
  assert.deepEqual(await s.hear("yes"), done("Stripe removed"));
  assert.deepEqual(s.log, ["-stripe"]);
  // No leaves it.
  assert.deepEqual(await s.hear("add strife"), question("Add Stripe?"));
  assert.deepEqual(await s.hear("no"), done("OK, leaving it as is"));
  assert.deepEqual(s.log, ["-stripe"]);
  // Another pill said instead takes its place.
  assert.deepEqual(await s.hear("add strike"), question("Add Stripe?"));
  assert.deepEqual(await s.hear("no, notion"), done("Notion added"));
  // The main pill, and two pills at once.
  assert.deepEqual(await s.hear("switch to cortex"), question("Switch to Codex?"));
  assert.deepEqual(await s.hear("yeah"), done("Main: Codex"));
  assert.deepEqual(await s.hear("add strife and nation"), question("Add Stripe, Notion?"));
  // The question is a yes or no, as the island's ask component takes it.
  const full = await setup().full("hide strife");
  assert.deepEqual(full.ask, { kind: "yes_no", question: "Remove Stripe?" });
});

test("a common command said as it is written is never questioned", async () => {
  // Everything the fixed grammar can hear, with every pill's every spoken form.
  const grammar = buildGrammar(PILLS, ["spotify", "discord", "visual studio code"]);
  let checked = 0;
  for (const command of grammar.commands) {
    for (const sentence of sentences(command, grammar.slots)) {
      const s = setup({ active: [] });
      // The worst case: the speech model unsure of every word.
      heardWith(sentence, sentence.split(" ").map(() => 0.1));
      const result = await s.hear(sentence);
      assert.notEqual(result?.outcome, "question", sentence);
      checked += 1;
    }
  }
  assert.ok(checked > 300, `${checked} sentences`);
  // And what a speech model writes for a name by its sound, when it says nothing of how sure it was.
  for (const [said, did] of [
    ["add versal", "Vercel added"], ["add get hub", "GitHub is already there"], ["switch to kodaks", "Main: Codex"], ["remove git hub", "GitHub removed"],
    ["add co pilot", "Copilot CLI added"], ["open spotify", "Spotify opened"], ["open my downloads", "Downloads opened"],
  ]) {
    heardWith("", null);
    assert.deepEqual(await setup().hear(said), done(did), said);
  }
});

test("a pill a model proposes for a sentence that only nearly names it is asked about", async () => {
  assert.equal(howNamed("get rid of strife please", "integration_stripe", PILLS).how, "near");
  assert.equal(howNamed("i want versal up there", "integration_vercel", PILLS).how, "sound");
  assert.equal(howNamed("the stripe one", "integration_stripe", PILLS).how, "said");
  assert.equal(howNamed("the weather", "integration_stripe", PILLS), null);
  assert.deepEqual(nearlyNamed("strife and github", ["integration_stripe", "integration_github"], PILLS), ["integration_stripe"]);

  const s = setup({ brain: () => ({ calls: [call("remove_pills", { pills: ["Stripe"] })], text: "" }) });
  assert.deepEqual(await s.hear("i do not want strife up there any more"), question("Remove Stripe?"));
  assert.deepEqual(s.log, []);
  assert.deepEqual(await s.hear("yes"), done("Stripe removed"));
  // Named as it is: done at once, as before.
  assert.deepEqual(await setup({ brain: () => ({ calls: [call("remove_pills", { pills: ["Stripe"] })], text: "" }) }).hear("i do not want stripe up there any more"), done("Stripe removed"));
  // Said to nobody: no question, nothing done.
  const quiet = setup({ brain: () => ({ calls: [call("remove_pills", { pills: ["Stripe"] })], text: "" }) });
  assert.equal(await quiet.hear("i do not want strife up there any more", { spokenTo: false }), null);
  assert.deepEqual(quiet.log, []);
  // A session is not brought forward on a nearly-said name.
  const session = setup({ brain: () => ({ calls: [call("open_session", { agent: "Codex" })], text: "" }) });
  assert.equal((await session.hear("show me the cortex terminal")).outcome, "failure");
  assert.deepEqual(session.log, []);
  assert.deepEqual(await setup({ brain: () => ({ calls: [call("open_session", { agent: "Codex" })], text: "" }) }).hear("show me the codex terminal"), done("Codex"));
});

// ── Questions and answers, as the contract types them ─────────────────────────

test("one candidate is a yes or no, several are a choice; an answer said or clicked is the same", async () => {
  const two = [{ id: "a", label: "Spotify" }, { id: "b", label: "Steam" }];
  assert.deepEqual(askWhich(two.slice(0, 1), (label) => `Open ${label}?`), { kind: "yes_no", question: "Open Spotify?" });
  const choice = askWhich(two, () => "");
  assert.deepEqual(choice, { kind: "choice", question: "Spotify or Steam?", options: two });
  assert.equal(askWhich([...two, { id: "c", label: "Slack" }], () => "").question, "Spotify, Steam or Slack?");
  // Said.
  assert.deepEqual(answerOf("the second one", choice), { kind: "choice", id: "b" });
  assert.deepEqual(answerOf("Steam.", choice), { kind: "choice", id: "b" });
  assert.deepEqual(answerOf("yes", choice), { kind: "unclear" });
  assert.deepEqual(answerOf("never mind", choice), { kind: "dropped" });
  assert.deepEqual(answerOf("", choice), { kind: "dropped" });
  const yesNo = { kind: "yes_no", question: "Open Spotify?" };
  assert.deepEqual(answerOf("yeah do it", yesNo, ["Spotify"]), { kind: "yes_no", yes: true });
  assert.deepEqual(answerOf("Spotify", yesNo, ["Spotify"]), { kind: "yes_no", yes: true });
  assert.deepEqual(answerOf("no", yesNo, ["Spotify"]), { kind: "yes_no", yes: false });
  assert.deepEqual(answerOf("", yesNo, ["Spotify"]), { kind: "dropped" });
  assert.deepEqual(answerOf("no, discord", yesNo, ["Spotify"]), { kind: "other", said: "discord" });
  assert.deepEqual(answerOf("dictated words", { kind: "text", question: "Subject?" }), { kind: "text", value: "dictated words" });
  // A yes never stands for anything about a permission.
  for (const said of ["yes allow it", "approve", "allow"]) assert.equal(answerOf(said, yesNo, ["Spotify"]).kind, "other", said);

  // A sentence about a permission is no answer: the question is dropped, and it is heard for what it is.
  const waiting = setup({ brain: () => ({ calls: [call("decline_permission")], text: "" }) });
  await waiting.hear("open spy flight");
  assert.equal((await waiting.hear("no decline that")).outcome, "failure", "nothing waits to be declined here");
  assert.ok(!waiting.runner.asking);
  assert.ok(waiting.asked.length >= 1, "the model was asked about that sentence");
  assert.deepEqual(waiting.asked[0].history, []);
  assert.deepEqual(waiting.log, []);

  // Clicked, or Ctrl+Shift+number: the same answer, without a word.
  const s = setup();
  const asked = await s.full("open st");
  assert.deepEqual(asked.ask, { kind: "choice", question: "Spotify or Steam?", options: [{ id: "Spotify", label: "Spotify" }, { id: "Steam", label: "Steam" }] });
  assert.deepEqual(await s.answer({ kind: "choice", id: "Steam" }), done("Steam opened"));
  await s.hear("remove strife");
  assert.deepEqual(await s.answer({ kind: "yes_no", yes: true }), done("Stripe removed"));
  await s.hear("open spy flight");
  assert.deepEqual(await s.answer({ kind: "dropped" }), done("OK, leaving it as is"));
  assert.equal(await s.answer({ kind: "yes_no", yes: true }), null, "nothing waits any more");
  assert.deepEqual(s.log, ["app:Steam", "-stripe"]);
});

// ── What #42 left ─────────────────────────────────────────────────────────────

test("a misheard verb: an app's name after a word or two nobody knows is asked about before any model", async () => {
  for (const said of ["Up in Spotify.", "upton spotify", "fine figma", "bunch figma", "open in discord"]) {
    const s = setup({ brain: () => assert.fail(`${said}: no model is asked`) });
    const app = APPS.find((a) => said.toLowerCase().includes(a.toLowerCase()));
    assert.deepEqual(await s.hear(said), question(`Open ${app}?`), said);
    assert.deepEqual(s.log, []);
    assert.deepEqual(await s.hear("yes"), done(`${app} opened`));
  }
  // Not that: a question about the app, something else to do with it, a longer sentence, a bare name.
  for (const said of ["is spotify playing", "close spotify", "what is claude doing right now", "i really do like using spotify", "spotify", "stop spotify", "not spotify"]) {
    const s = setup({ brain: () => ({ calls: [], text: "An answer." }) });
    assert.notEqual((await s.hear(said))?.outcome, "question", said);
  }
  // Nothing is asked of someone who was not talking to Mochi.
  assert.equal(await setup().hear("up in spotify", { spokenTo: false }), null);
});

test("that one, it: the pill the last command was about", async () => {
  const added = { kind: "add", ids: ["integration_github"] };
  assert.equal(withPronoun("take that one off", added, PILLS), "take github off");
  assert.equal(withPronoun("remove it again", added, PILLS), "remove github");
  assert.equal(withPronoun("take stripe off", added, PILLS), null, "no pronoun");
  assert.equal(withPronoun("take that one off", null, PILLS), null);
  assert.equal(withPronoun("take that one off", { kind: "open" }, PILLS), null);
  assert.equal(withPronoun("take them off", { kind: "add", ids: ["integration_github", "integration_vercel"] }, PILLS), null, "which of the two");
  // Never in a sentence about a permission, where "that" is the request.
  for (const said of ["no decline that", "allow it", "deny that one", "approve it"]) assert.equal(withPronoun(said, added, PILLS), null, said);
  // The verb around the name is a verb the parser knows.
  assert.deepEqual(parseIntent("take github off", PILLS), { kind: "pillRemove", id: "integration_github" });
  assert.deepEqual(parseIntent("put vercel back", PILLS), { kind: "pillAdd", id: "integration_vercel" });
  assert.deepEqual(parseIntent("get rid of stripe", PILLS), { kind: "pillRemove", id: "integration_stripe" });

  const s = setup();
  assert.deepEqual(await s.hear("add vercel"), done("Vercel added"));
  assert.deepEqual(await s.hear("take that one off"), done("Vercel removed"));
  assert.deepEqual(await s.hear("add it"), done("Vercel added"));
  assert.deepEqual(await s.hear("hide it again"), done("Vercel removed"));
  assert.deepEqual(s.log, ["+vercel", "-vercel", "+vercel", "-vercel"]);
  // A model's call for a sentence with a pronoun is checked against what the pronoun stands for.
  const model = setup({ brain: () => ({ calls: [call("remove_pills", { pills: ["Vercel"] })], text: "" }) });
  await model.hear("add vercel");
  assert.deepEqual(await model.hear("actually i changed my mind about that one"), done("Vercel removed"));
  // And still not against a pill nobody named, whatever the model says.
  const other = setup({ brain: () => ({ calls: [call("remove_pills", { pills: ["GitHub"] })], text: "" }) });
  await other.hear("add vercel");
  assert.equal((await other.hear("actually i changed my mind about that one")).outcome, "failure");
  assert.deepEqual(other.log, ["+vercel"]);
});

test("no, Vercel after add GitHub: a correction swaps, and also still adds", async () => {
  const relative = (said, last) => {
    const r = resolveRelative(said, last, PILLS);
    return r ? [r.intent, ...(r.also ? [r.also] : [])] : null;
  };
  const added = { kind: "add", ids: ["integration_github"] };
  const removed = { kind: "remove", ids: ["integration_github"] };
  for (const said of ["no, vercel", "I meant Vercel", "not that, vercel", "vercel instead", "no I said vercel"]) {
    assert.deepEqual(relative(said, added), [{ kind: "pillReplace", old: "integration_github", new: "integration_vercel" }], said);
  }
  assert.deepEqual(relative("no, vercel", removed), [{ kind: "pillAdd", id: "integration_github" }, { kind: "pillRemove", id: "integration_vercel" }]);
  // Not a correction: the same again.
  for (const said of ["and vercel too", "also vercel", "what about vercel", "same for vercel"]) {
    assert.deepEqual(relative(said, added), [{ kind: "pillAdd", id: "integration_vercel" }], said);
  }
  // The same pill again, or two pills before it: nothing to swap.
  assert.deepEqual(relative("no, github", added), [{ kind: "pillAdd", id: "integration_github" }]);
  assert.deepEqual(relative("no, stripe", { kind: "add", ids: ["integration_github", "integration_vercel"] }), [{ kind: "pillAdd", id: "integration_stripe" }]);

  const s = setup({ active: [] });
  assert.deepEqual(await s.hear("add github"), done("GitHub added"));
  assert.deepEqual(await s.hear("no, vercel"), done("GitHub → Vercel"));
  assert.deepEqual(s.pills.active, ["integration_vercel"]);
  assert.deepEqual(await s.hear("remove vercel"), done("Vercel removed"));
  await s.hear("add github");
  await s.hear("add stripe");
  assert.deepEqual(await s.hear("remove github"), done("GitHub removed"));
  assert.deepEqual(await s.hear("no, I meant stripe"), done("Stripe removed"));
  assert.deepEqual(s.pills.active, ["integration_github"]);
  // A correction whose name is only near is asked about like any other.
  const unsure = setup({ active: [] });
  await unsure.hear("add github");
  assert.deepEqual(await unsure.hear("no, strife"), question("Replace GitHub with Stripe?"));
  assert.deepEqual(await unsure.hear("yes"), done("GitHub → Stripe"));
  assert.equal(intentQuestion({ kind: "pillOnly", ids: ["integration_github"] }, PILLS), "Keep only GitHub?");
});

// ── On screen: the island's question component (conversation.askUser) ─────────

test("with a screen, a question about a name goes up, and the turn ends in what the answer led to", async () => {
  /** A conversation with something to show questions on, as the island gives it. */
  const screen = (options) => {
    const s = setup(options);
    const shown = [];
    s.conversation.onAsk = (ask) => shown.push(ask);
    return { ...s, shown, asked: () => s.conversation.asked };
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  // A click or its key: the answer the component gives.
  const s = screen();
  const turn = s.hear("open spy flight");
  await settled();
  assert.deepEqual(s.asked(), { kind: "yes_no", question: "Open Spotify?" });
  assert.ok(!s.runner.asking, "one place waits for the answer, not two");
  assert.deepEqual(s.log, []);
  assert.equal(s.conversation.answer({ kind: "yes_no", yes: true }), true);
  assert.deepEqual(await turn, done("Spotify opened"));
  assert.equal(s.asked(), null);
  assert.deepEqual(s.shown.map((ask) => ask?.kind ?? null), ["yes_no", null]);

  // A choice, by its option.
  const choice = s.hear("open st");
  await settled();
  assert.equal(s.asked().kind, "choice");
  s.conversation.answer({ kind: "choice", id: "Steam" });
  assert.deepEqual(await choice, done("Steam opened"));

  // Closed, timed out, "never mind": nothing is done.
  const dropped = s.hear("remove strife");
  await settled();
  assert.deepEqual(s.asked(), { kind: "yes_no", question: "Remove Stripe?" });
  s.conversation.answer({ kind: "dropped" });
  assert.deepEqual(await dropped, done("OK, leaving it as is"));
  assert.deepEqual(s.log, ["app:Spotify", "app:Steam"]);

  // Said: what answers such a question, which is more than yes and no.
  for (const [said, result] of [["yeah do it", "Stripe removed"], ["Stripe.", "Stripe removed"], ["no", "OK, leaving it as is"], ["no, github", "GitHub removed"], ["next track", "Next track"]]) {
    const again = screen();
    const pending = again.hear("remove strife");
    await settled();
    assert.equal(again.conversation.saidWhileAsked(said), true, said);
    assert.deepEqual(await pending, done(result), said);
    assert.equal(again.asked(), null);
  }
  // Another name for an app is tried; one that is only near is asked about in turn.
  const other = screen();
  const first = other.hear("open spy flight");
  await settled();
  assert.equal(other.conversation.saidWhileAsked("no, this squad"), true);
  await settled();
  assert.deepEqual(other.asked(), { kind: "yes_no", question: "Open Discord?" });
  assert.equal(other.conversation.saidWhileAsked("yes"), true);
  assert.deepEqual(await first, done("Discord opened"));
  // "Yes" to a choice says nothing: the question stays, for the island to read as it reads any.
  const stays = screen();
  const waiting = stays.hear("open st");
  await settled();
  assert.equal(stays.conversation.saidWhileAsked("yes"), false);
  assert.equal(stays.asked().kind, "choice");
  stays.conversation.answer({ kind: "dropped" });
  await waiting;
  // Not a question about a name: not this one's to read.
  assert.equal(stays.conversation.saidWhileAsked("yes"), false);
  const text = stays.conversation.askUser({ kind: "text", question: "Subject?" });
  assert.equal(stays.conversation.saidWhileAsked("hello there"), false);
  stays.conversation.answer({ kind: "dropped" });
  await text;

  // A sentence about a permission ends the question and is heard alone.
  const permission = screen({ brain: () => ({ calls: [], text: "It takes a click." }) });
  const open = permission.hear("open spy flight");
  await settled();
  assert.equal(permission.conversation.saidWhileAsked("yeah allow it"), true);
  assert.deepEqual(await open, done("It takes a click."));
  assert.deepEqual(permission.log, []);

  // A pill a model proposed for a sentence that only nearly names it: on screen too.
  const model = screen({ brain: (said) => (said.includes("strife") ? { calls: [call("remove_pills", { pills: ["Stripe"] })], text: "" } : { calls: [], text: "" }) });
  const proposed = model.hear("i do not want strife up there any more");
  await settled();
  assert.deepEqual(model.asked(), { kind: "yes_no", question: "Remove Stripe?" });
  model.conversation.answer({ kind: "yes_no", yes: true });
  assert.deepEqual(await proposed, done("Stripe removed"));
});

// ── Found by the evaluation of the app's own tools (2026-10-11) ───────────────

test("claude code is never Codex: words of another pill's name are that pill's", async () => {
  assert.equal(howNamed("put claude code in bypass permissions mode", "agent_codex", PILLS), null);
  assert.equal(howNamed("put claude code in bypass permissions mode", "integration_claude", PILLS).how, "said");
  assert.equal(names("put claude code in bypass permissions mode", "agent_codex", PILLS), false);
  assert.equal(names("put claude code in bypass permissions mode", "integration_claude", PILLS), true);
  // Said for itself, Codex is still Codex, and "code x" still sounds like it.
  assert.equal(names("switch claude code over to codex", "agent_codex", PILLS), true);
  assert.equal(names("use code x", "agent_codex", PILLS), true);
  assert.equal(names("add get hub", "integration_github", PILLS), true);
  // The model's call for it is refused: the main pill does not change for a sentence that named another tool.
  const s = setup({ brain: () => ({ calls: [call("set_main_pill", { pill: "Codex" })], text: "" }) });
  assert.equal((await s.hear("put claude code in bypass permissions mode")).outcome, "failure");
  assert.deepEqual(s.log, []);
  assert.equal(s.pills.main, "integration_claude");
});

test("stop, skip, next and back are the music's only in a short sentence or one about music", () => {
  const kind = (said) => parseIntent(said, PILLS).kind;
  for (const said of [
    "i would like you to stop answering out loud please", "let claude code skip all permissions", "can you stop the codex agent from running",
    "go back to the settings page for me", "what is the next thing on my list", "tell me when the next build is done please",
  ]) {
    assert.equal(kind(said), "unknown", said);
  }
  for (const [said, is] of [
    ["stop", "musicPause"], ["pause", "musicPause"], ["stop the music", "musicPause"], ["please stop it now", "musicPause"], ["skip", "musicNext"],
    ["skip this song", "musicNext"], ["next", "musicNext"], ["next track", "musicNext"], ["back", "musicPrevious"],
    ["go back to the last track", "musicPrevious"], ["could you skip to the next track for me", "musicNext"],
    ["i want you to pause the music right now", "musicPause"], ["previous song", "musicPrevious"],
  ]) {
    assert.equal(kind(said), is, said);
  }
});
