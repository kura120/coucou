// How often does voice do the right thing for a sentence said freely? Runs the
// real path — the parser, then a real model with the real tools and checks
// (src/voice) — against a model server on this machine, with fake music and
// pills. A manual check, not a test: it needs a model and its answers vary.
//
//   node --import ./tests/setup.mjs scripts/voice-eval.mjs [model] [server]
//
// Defaults: qwen2.5:7b-instruct on http://127.0.0.1:11434 (Ollama).

import { availablePills } from "../src/core/pills.ts";
import { VoiceConversation } from "../src/voice/conversation.ts";
import { VoiceRunner } from "../src/voice/runner.ts";

const MODEL = process.argv[2] ?? "qwen2.5:7b-instruct";
const SERVER = (process.argv[3] ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const PILLS = availablePills("windows");
const WAITING = { agent: "Codex", request: "Bash: rm -rf dist" };
/** What is installed, as Rust's lookup would find it by name. */
const APPS = ["Figma", "Visual Studio Code", "Discord", "Spotify", "Steam", "Slack", "Notepad", "Calculator", "Google Chrome", "Terminal", "Claude"];
const FOLDERS = ["Downloads", "Desktop", "Documents", "Pictures"];
/** What a speech model wrote for a name, and the apps Rust's `near` ranks for it (voice/apps.rs has the real one, and its tests). */
const HEARD_AS = { "spy flight": ["Spotify"], "this squad": ["Discord"], "the squad": ["Discord"], "steem": ["Steam"], "visual studio": ["Visual Studio Code"] };

function setup() {
  const log = [];
  const pills = { active: ["integration_github", "integration_vercel", "integration_stripe", "integration_n8n"], main: "integration_claude" };
  const state = { permission: WAITING, timer: null, playing: true };
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
      const app = APPS.find((a) => a.toLowerCase() === name.toLowerCase());
      if (app) log.push(`app:${app.toLowerCase()}`);
      return app ?? null;
    },
    appsNear: async (said) => {
      const words = ` ${said.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()} `;
      const names = APPS.filter((a) => words.includes(` ${a.toLowerCase()} `));
      for (const [heard, apps] of Object.entries(HEARD_AS)) if (words.includes(` ${heard} `)) names.push(...apps.filter((a) => !names.includes(a)));
      return { names: names.slice(0, 3), clear: names.length === 1 };
    },
    openFolder: async (name) => {
      const folder = FOLDERS.find((f) => name.toLowerCase().split(" ").some((w) => w === f.toLowerCase() || `${w}s` === f.toLowerCase()));
      if (folder) log.push(`folder:${folder.toLowerCase()}`);
      return folder ?? null;
    },
    openUrl: (url) => log.push(`url:${new URL(url).hostname.replace(/^www\./, "")}`),
    nowPlaying: () => "Get Lucky — Daft Punk",
    reports: () => ({ GitHub: "main: passing, 2 open pull requests" }),
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
  const reply = await fetch(`${SERVER}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0, stream: false, tools, messages: messages(system, history, said, steps) }),
  });
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
 * What voice does with a sentence, or with several said one after the other:
 * the conversation the island runs (src/voice/conversation.ts).
 */
async function hear(sentences) {
  const { log, runner, world } = setup();
  const conversation = new VoiceConversation(runner, world, () => PILLS, () => ask);
  const before = asked;
  const started = performance.now();
  let result = null;
  for (const said of sentences) result = await conversation.hear(said);
  return { log, result, by: asked > before ? "model" : "parser", ms: performance.now() - started };
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
];

function judge(expected, { log, result }) {
  // Whatever else, a permission is never declined unless that was the point.
  if (log.includes("DECLINE") && !(Array.isArray(expected) && expected.includes("DECLINE"))) return "DANGER";
  if (Array.isArray(expected)) return JSON.stringify(log) === JSON.stringify(expected) ? "ok" : "wrong";
  if (expected === "nothing") return log.length === 0 ? "ok" : "wrong";
  if (log.length) return "wrong";
  if (expected.startsWith("ask:")) return result?.outcome === "question" && result.message.includes(expected.slice("ask:".length)) ? "ok" : "wrong";
  const words = expected.slice("answer:".length).split("|").filter(Boolean);
  const said = result?.outcome === "success" ? result.message.toLowerCase() : "";
  return said && (!words.length || words.some((w) => said.includes(w))) ? "ok" : "wrong";
}

await ask("Say hi.", "hi", []); // loads the model
const tally = { ok: 0, wrong: 0, DANGER: 0 };
const times = { parser: [], model: [] };
// The sentences this table had before there were turns and questions: a change must not lose one.
let first = 0;
for (const [said, expected] of CASES) {
  const sentences = Array.isArray(said) ? said : [said];
  const heard = await hear(sentences);
  const verdict = judge(expected, heard);
  tally[verdict] += 1;
  if (!Array.isArray(said) && verdict === "ok") first += 1;
  times[heard.by].push(heard.ms);
  if (WORDS && heard.by === "model") console.log(`  said   ${JSON.stringify(sentences)} -> ${JSON.stringify(heard.result?.message ?? null)}`);
  if (verdict !== "ok") {
    console.log(`  ${verdict.padEnd(6)} ${JSON.stringify(sentences)} [${heard.by}] did ${JSON.stringify(heard.log)} said ${JSON.stringify(heard.result?.message ?? null)}`);
  }
}
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
const single = CASES.filter(([said]) => !Array.isArray(said)).length;
console.log(`${MODEL}: ${tally.ok}/${CASES.length} right, ${tally.wrong} wrong, ${tally.DANGER} dangerous`);
console.log(`one sentence: ${first}/${single}; misheard names and follow-ups: ${tally.ok - first}/${CASES.length - single}`);
console.log(`worded by the model: ${wording.length} rounds, median ${(median(wording) / 1000).toFixed(2)} s, slowest ${(Math.max(0, ...wording) / 1000).toFixed(2)} s`);
console.log(`parser: ${times.parser.length} cases, ${median(times.parser).toFixed(1)} ms; model: ${times.model.length} cases, median ${(median(times.model) / 1000).toFixed(2)} s`);
