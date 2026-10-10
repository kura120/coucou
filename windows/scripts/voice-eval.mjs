// How often does voice do the right thing for a sentence said freely? Runs the
// real path — the parser, then a real model with the real tools and checks
// (src/voice) — against a model server on this machine, with fake music and
// pills. A manual check, not a test: it needs a model and its answers vary.
//
//   node --import ./tests/setup.mjs scripts/voice-eval.mjs [model] [server]
//
// Defaults: qwen2.5:7b-instruct on http://127.0.0.1:11434 (Ollama).

import { availablePills } from "../src/core/pills.ts";
import { parseIntent, parseSeveral } from "../src/voice/intent.ts";
import { VoiceRunner } from "../src/voice/runner.ts";
import { describeState, runProposal, systemPrompt, toolSchemas } from "../src/voice/tools.ts";

const MODEL = process.argv[2] ?? "qwen2.5:7b-instruct";
const SERVER = (process.argv[3] ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const PILLS = availablePills("windows");
const WAITING = { agent: "Codex", request: "Bash: rm -rf dist" };

function setup() {
  const log = [];
  const pills = { active: ["integration_github", "integration_vercel", "integration_stripe", "integration_n8n"], main: "integration_claude" };
  const state = { permission: WAITING, timer: null };
  const runner = new VoiceRunner(
    {
      enabled: () => true, running: () => true, playing: () => true, shuffle: () => true, repeat: () => true,
      playPause: () => log.push("pause"), next: () => log.push("next"), previous: () => log.push("previous"),
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
    openApp: async (name) => (log.push(`app:${name.toLowerCase()}`), name),
    openFolder: async (name) => (log.push(`folder:${name.toLowerCase()}`), name),
    openUrl: (url) => log.push(`url:${new URL(url).hostname.replace(/^www\./, "")}`),
    nowPlaying: () => "Get Lucky — Daft Punk",
    reports: () => ({ GitHub: "main: passing, 2 open pull requests" }),
  };
  return { log, runner, world };
}

async function ask(system, said, tools) {
  const reply = await fetch(`${SERVER}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0, stream: false, tools,
      messages: [{ role: "system", content: system }, { role: "user", content: said }],
    }),
  });
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

/** What voice does with a sentence: the same steps as Island.voiceCommand. */
async function hear(said) {
  const { log, runner, world } = setup();
  const started = performance.now();
  const intent = parseIntent(said, PILLS);
  const several = parseSeveral(said, PILLS);
  let result;
  let by = "parser";
  if (intent.kind === "cancel") {
    result = null;
  } else if (intent.kind !== "unknown" || several) {
    const results = (several ?? [intent]).map((one) => runner.run(one, said));
    result = results.find((r) => r.outcome !== "success") ?? results[results.length - 1];
  } else {
    by = "model";
    const proposal = await ask(systemPrompt(describeState(world, runner, PILLS)), said, toolSchemas(PILLS));
    result = await runProposal(proposal, said, runner, world, PILLS);
  }
  return { log, result, by, ms: performance.now() - started };
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
];

function judge(expected, { log, result }) {
  // Whatever else, a permission is never declined unless that was the point.
  if (log.includes("DECLINE") && !(Array.isArray(expected) && expected.includes("DECLINE"))) return "DANGER";
  if (Array.isArray(expected)) return JSON.stringify(log) === JSON.stringify(expected) ? "ok" : "wrong";
  if (expected === "nothing") return log.length === 0 ? "ok" : "wrong";
  const words = expected.slice("answer:".length).split("|").filter(Boolean);
  const said = result?.outcome === "success" ? result.message.toLowerCase() : "";
  if (log.length) return "wrong";
  return said && (!words.length || words.some((w) => said.includes(w))) ? "ok" : "wrong";
}

await ask("Say hi.", "hi", []); // loads the model
const tally = { ok: 0, wrong: 0, DANGER: 0 };
const times = { parser: [], model: [] };
for (const [said, expected] of CASES) {
  const heard = await hear(said);
  const verdict = judge(expected, heard);
  tally[verdict] += 1;
  times[heard.by].push(heard.ms);
  if (verdict !== "ok") {
    console.log(`  ${verdict.padEnd(6)} "${said}" [${heard.by}] did ${JSON.stringify(heard.log)} said ${JSON.stringify(heard.result?.message ?? null)}`);
  }
}
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
console.log(`${MODEL}: ${tally.ok}/${CASES.length} right, ${tally.wrong} wrong, ${tally.DANGER} dangerous`);
console.log(`parser: ${times.parser.length} sentences, ${median(times.parser).toFixed(1)} ms; model: ${times.model.length} sentences, median ${(median(times.model) / 1000).toFixed(2)} s`);
