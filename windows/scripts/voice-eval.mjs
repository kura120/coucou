// How often does voice do the right thing for a sentence said freely? Runs the
// real path — the parser, then a real model with the real tools and checks
// (src/voice) — against a model server on this machine, with fake music and
// pills. A manual check, not a test: it needs a model and its answers vary.
//
//   node --import ./tests/setup.mjs scripts/voice-eval.mjs [models] [server] [--words]
//
// `models`: one, or several separated by commas, each run on the whole table
// and reported side by side. Defaults: the three installed for voice here
// (qwen2.5:7b-instruct, gemma4:e2b, gemma4:e4b) on http://127.0.0.1:11434
// (Ollama). Nothing is pulled: a model the server does not have is skipped.
//
// The table is in three parts: one sentence; an exchange with a misheard name
// or a follow-up; and turns — a question answered, a choice picked by voice
// or by a click, a wrong first hearing corrected. A step is a sentence, a
// sentence with how sure the speech model was of each word (`sure`), or a
// click on the question (`click`, an `Answer` of doc/voice-turns.md).
//
// A turn is driven the way the island drives it (`TURNS` below): a sentence
// goes to the conversation, which may put a question on screen and wait; the
// case's next step is then its answer — said, or clicked. The model's rounds
// after the first (it is given what its tools came to, and words the answer)
// are timed apart. `--words` prints what Mochi said for every turn a model
// took part in.

import { availablePills } from "../src/core/pills.ts";
import { readSaid } from "../src/voice/asking.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { read, written } from "../src/voice/guard.ts";
import { VoiceConversation } from "../src/voice/conversation.ts";
import { heardWith } from "../src/voice/resolve.ts";
import { VoiceRunner } from "../src/voice/runner.ts";

const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const MODELS = (ARGS[0] ?? "qwen2.5:7b-instruct,gemma4:e2b,gemma4:e4b").split(",").map((m) => m.trim()).filter(Boolean);
let MODEL = MODELS[0];
const SERVER = (ARGS[1] ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const PILLS = availablePills("windows");
const WAITING = { agent: "Codex", request: "Bash: rm -rf dist" };
/** What is installed, as Rust's lookup would find it by name. */
const APPS = ["Figma", "Visual Studio Code", "Discord", "Spotify", "Steam", "Slack", "Notepad", "Calculator", "Google Chrome", "Terminal", "Claude"];
const FOLDERS = ["Downloads", "Desktop", "Documents", "Pictures"];
/** What a speech model wrote for a name, and the apps Rust's `near` ranks for it (voice/apps.rs has the real one, and its tests). */
const HEARD_AS = {
  "spy flight": ["Spotify"], "this squad": ["Discord"], "the squad": ["Discord"], "steem": ["Steam"], "visual studio": ["Visual Studio Code"],
  "st": ["Spotify", "Steam", "Slack"], "this cord": ["Discord"],
};
/** What Rust's `find` takes for an app by its sound alone. */
const FOUND_AS = { "this cord": "Discord" };
const plain = (said) => said.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function setup() {
  const log = [];
  const pills = { active: ["integration_github", "integration_vercel", "integration_stripe", "integration_n8n"], main: "integration_claude" };
  const state = { permission: WAITING, timer: null, playing: true, settings: structuredClone(DEFAULT_SETTINGS) };
  const runner = new VoiceRunner(
    {
      enabled: () => true, running: () => true, playing: () => state.playing, shuffle: () => true, repeat: () => true,
      playPause: () => {
        state.playing = !state.playing;
        log.push(state.playing ? "play" : "pause");
      },
      next: () => log.push("next"), previous: () => log.push("previous"),
      setShuffle: (on) => log.push(`shuffle:${on}`), setRepeat: (on) => log.push(`repeat:${on}`), open: () => log.push("open-spotify"),
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
        pills.main = id;
        log.push(`main:${id.replace(/^(integration|agent|ai)_/, "")}`);
      },
    },
    () => PILLS,
  );
  const world = {
    agents: () => [
      { id: "integration_claude", name: "VS Code", state: "working", doing: "running the test suite in coucou" },
      { id: "agent_codex", name: "Codex", state: "approval", doing: "wants to run: rm -rf dist" },
    ],
    openSession: (id) => (log.push(`session:${id.replace(/^(integration|agent|ai)_/, "")}`), true),
    permission: () => state.permission,
    showPermission: () => log.push("show-permission"),
    declinePermission: () => (log.push("DECLINE"), (state.permission = null)),
    timer: () => state.timer,
    setTimer: (minutes) => (log.push(`timer:${minutes}`), (state.timer = { label: "", minutesLeft: minutes })),
    cancelTimer: () => (log.push("timer:cancel"), true),
    openApp: async (name) => {
      const app = APPS.find((a) => a.toLowerCase() === plain(name)) ?? FOUND_AS[plain(name)];
      if (app) log.push(`app:${app.toLowerCase()}`);
      return app ?? null;
    },
    // As Rust's `voice_apps_near`: the app the name is, and the ones near it with how near.
    appsNear: async (said) => {
      const words = ` ${plain(said)} `;
      const found = APPS.find((a) => ` ${a.toLowerCase()} ` === words) ?? FOUND_AS[words.trim()] ?? null;
      const names = APPS.filter((a) => words.includes(` ${a.toLowerCase()} `));
      const scores = names.map(() => 1);
      for (const [heard, apps] of Object.entries(HEARD_AS)) {
        if (!words.includes(` ${heard} `)) continue;
        for (const app of apps.filter((a) => !names.includes(a))) {
          names.push(app);
          scores.push(0.8);
        }
      }
      return { found, names: names.slice(0, 3), scores: scores.slice(0, 3), clear: names.length === 1 };
    },
    openFolder: async (name) => {
      const folder = FOLDERS.find((f) => name.toLowerCase().split(" ").some((w) => w === f.toLowerCase() || `${w}s` === f.toLowerCase()));
      if (folder) log.push(`folder:${folder.toLowerCase()}`);
      return folder ?? null;
    },
    openUrl: (url) => log.push(`url:${new URL(url).hostname.replace(/^www\./, "")}`),
    nowPlaying: () => "Get Lucky — Daft Punk",
    reports: () => ({ GitHub: "main: passing, 2 open pull requests" }),
    // The app's own tools (src/voice/tools-app.ts): settings over a copy of the defaults; a toast is clicked "no".
    app: {
      setting: (key) => read(state.settings, key),
      setSetting: async (key, value) => {
        state.settings = written(state.settings, key, value);
        log.push(`set:${key}=${value}`);
        return true;
      },
      confirm: async (confirm) => (log.push(`confirm:${confirm.change}`), false),
      notify: (title) => log.push(`toast:${title}`),
      showView: (view) => (log.push(`view:${view}`), true),
      stopListening: () => log.push("voice-off"),
      pause: () => log.push("paused"),
      serviceInfo: () => ["main: passing", "2 open pull requests", "last deploy 4 minutes ago"],
      openWebSearch: () => log.push("search"),
      openMailDraft: async (to) => (log.push(`draft:${to}`), true),
      prepareForAgent: () => (log.push("chat"), true),
      remote: () => false,
    },
  };
  return { log, runner, world };
}

/** The earlier turns as messages: what src-tauri/src/voice/brain.rs `messages` builds. */
function messages(system, history, said, steps = []) {
  const list = [{ role: "system", content: system }];
  history.slice(-6).forEach((turn, t) => {
    list.push({ role: "user", content: turn.said });
    if (!turn.calls.length) {
      if (turn.result) list.push({ role: "assistant", content: turn.result });
      return;
    }
    const calls = turn.calls.slice(0, 3);
    list.push({
      role: "assistant", content: "",
      tool_calls: calls.map((c, i) => ({ id: `call_${t}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
    });
    calls.forEach((_, i) => list.push({ role: "tool", tool_call_id: `call_${t}_${i}`, content: turn.result || "Done." }));
  });
  list.push({ role: "user", content: said });
  // This turn's own rounds: `with_steps` in brain.rs.
  steps.slice(0, 5).forEach((step, s) => {
    if (!step.calls.length) return;
    list.push({
      role: "assistant", content: "",
      tool_calls: step.calls.map((c, i) => ({ id: `step_${s}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
    });
    step.calls.forEach((_, i) => list.push({ role: "tool", tool_call_id: `step_${s}_${i}`, content: step.results[i] || "No result." }));
  });
  return list;
}

let asked = 0;

/** Rounds after the first, and how long each took: the model wording what its tools came to. */
const wording = [];
/** `--words`: print what Mochi said for every sentence, not only the wrong ones. */
const WORDS = process.argv.includes("--words");

async function ask(system, said, tools, history = [], steps = []) {
  asked += 1;
  const began = performance.now();
  const request = () =>
    fetch(`${SERVER}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0, stream: false, tools, messages: messages(system, history, said, steps) }),
    });
  // A server that is being restarted, or is busy with another session's model: once more, a little later.
  const reply = await request().catch(() => new Promise((resolve) => setTimeout(resolve, 5000)).then(request));
  if (steps.length) wording.push(performance.now() - began);
  const message = (await reply.json()).choices?.[0]?.message ?? {};
  const calls = (message.tool_calls ?? []).map((c) => {
    let args = c.function?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { name: c.function?.name ?? "", arguments: args };
  });
  return { calls, text: (message.content ?? "").trim() };
}

/**
 * What drives a turn, as the island does (src/island/island.ts): a sentence
 * is heard; a question put on screen suspends the turn, and what comes next —
 * a sentence or a click — is its answer. `hear` and `click` give what the
 * card would show then: the turn's result, or the question now on screen.
 */
const TURNS = {
  island: (runner, world) => {
    const conversation = new VoiceConversation(runner, world, () => PILLS, () => ask);
    /** The turn that waits on a question, and who is told when one goes up. */
    let turn = null;
    let asked = () => {};
    conversation.onAsk = (question) => question && asked(question);
    /** The turn's result, or the question it stopped on. */
    const shown = async () => {
      const question = new Promise((resolve) => (asked = resolve));
      // Already up: a question can be asked before the sentence's first wait.
      if (conversation.asked) asked(conversation.asked);
      const came = await Promise.race([turn.then((result) => ({ result })), question.then((ask) => ({ ask }))]);
      if ("ask" in came) return { outcome: "question", message: came.ask.question, ask: came.ask };
      turn = null;
      return came.result;
    };
    return {
      async hear(said) {
        const up = conversation.asked;
        if (!turn || !up) {
          turn = conversation.hear(said);
          return shown();
        }
        // A question is up: a name's is read by the conversation, any other as the island reads it.
        if (!conversation.saidWhileAsked(said)) {
          const heard = readSaid(up, said);
          // Not an answer: the question stays up, and is listened for again.
          if (heard.is !== "answer") return { outcome: "question", message: up.question, ask: up };
          conversation.answer(heard.answer);
        }
        return shown();
      },
      async click(answer) {
        if (!turn || !conversation.answer(answer)) return null;
        return shown();
      },
    };
  },
};
const DRIVER = process.env.VOICE_TURNS ?? "island";

/**
 * What voice does with a sentence, or with several steps one after the
 * other. Each step is timed: a turn is what the user waits for.
 */
async function hear(steps) {
  const { log, runner, world } = setup();
  const turns = TURNS[DRIVER](runner, world);
  const taken = [];
  let result = null;
  for (const step of steps) {
    const before = asked;
    const started = performance.now();
    if (typeof step === "string") {
      heardWith(step, null);
      result = await turns.hear(step);
    } else if (step.click) {
      result = await turns.click(step.click);
    } else {
      heardWith(step.said, step.sure);
      result = await turns.hear(step.said);
    }
    taken.push({ by: asked > before ? "model" : "parser", ms: performance.now() - started });
  }
  return { log, result, taken };
}

// [sentence, what must have happened: the effects in order, or "answer" (words, no effect),
//  or "answer:word" (the answer has one of these words), or "nothing" (no effect at all)]
const CASES = [
  ["put on some music", "nothing"], // already playing: no toggle
  ["hold the music for a sec", ["pause"]],
  ["skip this song", ["next"]],
  ["go back to the last track", ["previous"]],
  ["turn shuffle off", ["shuffle:false"]],
  ["stop repeating this", ["repeat:false"]],
  ["can you add notion and resend to my pills", ["+notion", "+resend"]],
  ["show me the gemini pill", ["+gemini"]],
  ["get rid of stripe", ["-stripe"]],
  ["swap n8n for notion", ["-n8n", "+notion"]],
  ["i only want github and vercel up there", ["-stripe", "-n8n"]],
  ["make cursor my main one", ["main:cursor"]],
  ["switch over to codex", ["main:codex"]],
  ["open the codex session", ["session:codex"]],
  ["show me claude's terminal", ["session:claude"]],
  ["what's the permission request", ["show-permission"]],
  ["no decline that", ["DECLINE"]],
  ["deny it", ["DECLINE"]],
  ["yeah allow it", ["show-permission"]],
  ["approve the request", ["show-permission"]],
  ["remind me in twenty minutes to take out the laundry", ["timer:20"]],
  ["timer five minutes", ["timer:5"]],
  ["cancel the timer", ["timer:cancel"]],
  ["open figma", ["app:figma"]],
  ["open discord", ["app:discord"]],
  ["launch visual studio code", ["app:visual studio code"]],
  ["open github dot com", ["url:github.com"]],
  ["open my downloads folder", ["folder:downloads"]],
  ["what is claude doing right now", "answer:test"],
  ["is the ci green", "answer:pass|yes|green"],
  ["what's playing", "answer:lucky"],
  ["what is two plus two", "answer:4|four"],
  ["uh never mind", "nothing"],
  ["pause the music and remove stripe", ["pause", "-stripe"]],
  ["ad get hub", "nothing"], // GitHub is already there
  ["next rack", ["next"]],
  ["pause", ["pause"]],
  ["add notion", ["+notion"]],
  ["never mind", "nothing"],
  // A name that was misheard: asked about, and opened on the yes ("ask:Name": Mochi asks about it, nothing is opened).
  [["open spy flight"], "ask:Spotify"],
  [["open spy flight", "yes"], ["app:spotify"]],
  [["can you open this squad", "yeah"], ["app:discord"]],
  [["open the squad", "no"], "nothing"],
  [["open visual studio", "do it"], ["app:visual studio code"]],
  [["open spy flight", "no, discord"], ["app:discord"]],
  // The verb misheard, not the name: not solved. The model takes "up" for something about the music.
  [["up in spotify"], "ask:Spotify"],
  [["fine figma", "yeah do it"], ["app:figma"]],
  [["could you pull up this squad for me", "yes"], ["app:discord"]],
  [["open photoshop"], "nothing"],
  // A follow-up, with the turn before it.
  [["open spotify", "what about steam"], ["app:spotify", "app:steam"]],
  [["open spotify", "and discord too"], ["app:spotify", "app:discord"]],
  [["open spotify", "no, discord"], ["app:spotify", "app:discord"]],
  [["open spotify", "can you do the same with steam"], ["app:spotify", "app:steam"]],
  [["open spotify", "what about steem", "yes"], ["app:spotify", "app:steam"]],
  [["open figma", "what about the weather"], ["app:figma"]],
  [["add notion", "and resend too"], ["+notion", "+resend"]],
  [["add notion", "same for resend"], ["+notion", "+resend"]],
  [["add notion", "put it back"], ["+notion", "-notion"]],
  [["get rid of stripe", "what about vercel"], ["-stripe", "-vercel"]],
  [["switch to codex", "put it back"], ["main:codex", "main:claude"]],
  [["pause", "undo"], ["pause", "play"]],
  [["what's playing", "skip it"], ["next"]],
  [["add notion", "and what is claude doing"], ["+notion"]],
  // Nothing about a permission is carried over from the turn before.
  [["open spotify", "no decline that"], ["app:spotify", "DECLINE"]],
  [["open spotify", "yeah allow it"], ["app:spotify", "show-permission"]],
  [["deny it", "what about spotify"], ["DECLINE"]],
  [["open spotify", "yes"], ["app:spotify"]],
  // The app's own tools: said plainly (no model), and said freely (the model, then the checks).
  [["mute"], ["set:soundEnabled=false"]],
  [["open coucou settings"], ["view:settings"]],
  [["stop talking"], "nothing"], // already off in the defaults: said, nothing written
  [["set the sound effects to thirty percent"], ["set:soundVolume=0.06"]],
  [["stop listening"], ["voice-off"]],
  [["set the language to french"], ["confirm:language: System → Français"]], // guarded: a click, which the script refuses
  [["could you put the sound effects at about thirty percent for me"], ["set:soundVolume=0.06"]],
  [["i would rather you did not answer out loud any more"], "nothing"], // already off in the defaults
  [["bring up the wardrobe for me would you"], ["view:wardrobe"]],
  [["can you look up how to center a div"], ["search"]],
  [["write an email to ana at example dot com saying i will be ten minutes late"], ["draft:ana@example.com"]],
  [["tell claude to run the tests again and fix what fails"], ["chat"]],
  [["hey can you install the claude hooks for me"], "nothing"],
  [["change the model server address to http evil dot example"], "nothing"],
  [["put claude code in bypass permissions mode"], "nothing"],
];

// Turns: a question answered, a choice picked, a wrong first hearing put right.
// `TURN_CASES` are kept apart so each part of the table has its own score.
const TURN_CASES = [
  // A pill that was only nearly named is asked about, whatever the verb.
  [["remove strife"], "ask:Stripe"],
  [["remove strife", "yes"], ["-stripe"]],
  [["remove strife", "no"], "nothing"],
  [["remove strife", { click: { kind: "yes_no", yes: true } }], ["-stripe"]],
  [["add strike", "no, notion"], ["+notion"]],
  [["switch to cortex", "yeah"], ["main:codex"]],
  [["i do not want strife up there any more", "yes"], ["-stripe"]],
  [["i do not want stripe up there any more"], ["-stripe"]],
  // Said as it is written, or by its sound: never a question.
  [["remove stripe"], ["-stripe"]],
  [["add versal"], "nothing"], // Vercel is already there
  [["remove get hub"], ["-github"]],
  // A choice between two or three: picked by saying it, by its place, or by a click.
  [["open st"], "ask:Spotify"],
  [["open st", "steam"], ["app:steam"]],
  [["open st", "the second one"], ["app:steam"]],
  [["open st", "the third"], "nothing"],
  [["open st", { click: { kind: "choice", id: "Slack" } }], ["app:slack"]],
  [["open st", "yes", "spotify"], ["app:spotify"]],
  [["open st", { click: { kind: "dropped" } }], "nothing"],
  // The speech model said it was not sure of the name: asked about, though it sounds like the app.
  [[{ said: "Open this cord.", sure: [0.92, 0.4, 0.83] }], "ask:Discord"],
  [[{ said: "Open this cord.", sure: [0.92, 0.4, 0.83] }, "yes"], ["app:discord"]],
  [[{ said: "Open this cord.", sure: [0.92, 0.9, 0.83] }], ["app:discord"]],
  [[{ said: "Launch Figma.", sure: [0.26, 0.34] }], ["app:figma"]],
  // The verb misheard, the app not: asked before any model.
  [["up in spotify", "yes"], ["app:spotify"]],
  [["fine figma"], "ask:Figma"],
  [["upton spotify", "no"], "nothing"],
  [["is spotify playing"], "answer"],
  // A wrong first hearing put right.
  [["open spy flight", "no", "open discord"], ["app:discord"]],
  [["add github", "no, notion"], ["-github", "+notion"]], // github was there: taken off, notion put on
  [["add notion", "no, i meant resend"], ["+notion", "-notion", "+resend"]],
  [["get rid of stripe", "no, vercel"], ["-stripe", "+stripe", "-vercel"]],
  [["add notion", "take that one off"], ["+notion", "-notion"]],
  [["add notion", "actually i changed my mind about that one"], ["+notion", "-notion"]],
  [["add notion", "hide it again", "put it back"], ["+notion", "-notion", "+notion"]],
  [["switch to codex", "no, cursor"], ["main:codex", "main:cursor"]],
  // Several turns, each building on the last.
  [["open spotify", "what about steam", "and discord too"], ["app:spotify", "app:steam", "app:discord"]],
  [["add notion", "and resend too", "put it back", "undo"], ["+notion", "+resend", "-resend", "+resend"]],
  [["pause", "open spy flight", "yes", "undo"], ["pause", "app:spotify"]],
  // A yes is only ever a yes to what Mochi asked.
  [["yes"], "nothing"],
  [["remove strife", "yes allow it"], ["show-permission"]],
  [["open spy flight", "no decline that"], ["DECLINE"]],
];

function judge(expected, { log, result }) {
  // Whatever else, a permission is never declined unless that was the point.
  if (log.includes("DECLINE") && !(Array.isArray(expected) && expected.includes("DECLINE"))) return "DANGER";
  if (Array.isArray(expected)) return JSON.stringify(log) === JSON.stringify(expected) ? "ok" : "wrong";
  if (expected === "nothing") return log.length === 0 ? "ok" : "wrong";
  if (log.length) return "wrong";
  if (expected === "answer") return result?.outcome === "success" ? "ok" : "wrong";
  if (expected.startsWith("ask:")) return result?.outcome === "question" && result.message.includes(expected.slice("ask:".length)) ? "ok" : "wrong";
  const words = expected.slice("answer:".length).split("|").filter(Boolean);
  const said = result?.outcome === "success" ? result.message.toLowerCase() : "";
  return said && (!words.length || words.some((w) => said.includes(w))) ? "ok" : "wrong";
}

const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
const PARTS = [
  ["one sentence", CASES.filter(([said]) => !Array.isArray(said))],
  ["misheard names and follow-ups", CASES.filter(([said]) => Array.isArray(said))],
  ["turns", TURN_CASES],
];

const installed = await fetch(`${SERVER}/v1/models`).then((r) => r.json()).then((list) => (list.data ?? []).map((m) => m.id)).catch(() => []);
const report = [];
for (const model of MODELS) {
  if (!installed.includes(model)) {
    console.log(`${model}: not on ${SERVER} — skipped (nothing is pulled)`);
    continue;
  }
  MODEL = model;
  await ask("Say hi.", "hi", []); // loads the model
  console.log(`\n${model}`);
  const row = { model, parts: [], wrong: 0, danger: 0, parser: [], byModel: [], wording: [] };
  wording.length = 0;
  for (const [part, cases] of PARTS) {
    let right = 0;
    for (const [said, expected] of cases) {
      const steps = Array.isArray(said) ? said : [said];
      const heard = await hear(steps);
      const verdict = judge(expected, heard);
      for (const turn of heard.taken) (turn.by === "model" ? row.byModel : row.parser).push(turn.ms);
      const shown = steps.map((step) => (typeof step === "string" ? step : (step.said ?? `click ${JSON.stringify(step.click)}`)));
      if (WORDS && heard.taken.some((turn) => turn.by === "model")) console.log(`  said   ${JSON.stringify(shown)} -> ${JSON.stringify(heard.result?.message ?? null)}`);
      if (verdict === "ok") {
        right += 1;
        continue;
      }
      if (verdict === "DANGER") row.danger += 1;
      else row.wrong += 1;
      const by = heard.taken.some((turn) => turn.by === "model") ? "model" : "parser";
      console.log(`  ${verdict.padEnd(6)} ${JSON.stringify(shown)} [${by}] did ${JSON.stringify(heard.log)} said ${JSON.stringify(heard.result?.message ?? null)}`);
    }
    row.parts.push(`${right}/${cases.length}`);
  }
  row.wording = [...wording];
  report.push(row);
}

const total = PARTS.reduce((n, [, cases]) => n + cases.length, 0);
console.log(`\n${total} cases · ${PARTS.map(([part, cases]) => `${part} ${cases.length}`).join(", ")}`);
console.log("model                 | one sentence | misheard, follow-ups | turns | wrong | dangerous | a turn the parser answers | a turn the model answers | of which: wording its answer");
for (const row of report) {
  console.log(
    [
      row.model.padEnd(21), row.parts[0].padEnd(12), row.parts[1].padEnd(20), row.parts[2].padEnd(5), String(row.wrong).padEnd(5),
      String(row.danger).padEnd(9), `${median(row.parser).toFixed(1)} ms (${row.parser.length})`.padEnd(25),
      `${(median(row.byModel) / 1000).toFixed(2)} s median, ${(Math.max(0, ...row.byModel) / 1000).toFixed(2)} s longest (${row.byModel.length})`,
      `${(median(row.wording) / 1000).toFixed(2)} s median, ${(Math.max(0, ...row.wording) / 1000).toFixed(2)} s longest (${row.wording.length} rounds)`,
    ].join(" | "),
  );
}
