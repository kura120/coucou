// One sentence in, what Mochi makes of it out (doc/voice-brain.md, 3.4). The
// app declared what it can do (core/capabilities); here a sentence is turned
// into calls to it, by the cheapest of three tiers that can:
//
//   instant  an embedding model alone says which capability the sentence is,
//            and it runs with no model call
//   local    the model server chosen for voice is given the app's state, the
//            last turns and a few capabilities as tools; its calls are run and
//            their results given back, for a few rounds
//   cloud    when the user allowed it, what the local model handed up or
//            could not answer goes to the provider chosen for the chat
//
// Before any of them: was the sentence said to Coucou? The wake phrase settles
// it. Without it — the few seconds after a turn — the local model decides,
// and only one on this computer: it is given the sentence with the turn
// before, and calls `nothing` for what was said to someone else. Nothing
// shows unless it calls something else, and such a sentence never reaches
// the cloud. (The ranking cannot tell: voice/rank.ts `directed`.)
//
// Nothing here reads a word of what was said. A sentence is embedded whole or
// handed to a model whole; what it means is theirs to work out, and what may
// be done is the executor's to decide (the capability's tier, a click for
// `confirm`). The texts below are instructions to a model, not rules about
// wording. Nothing said is written to disk or logged.

import type { Answer, Ask, Capability, Registry, RunContext, ToolResult } from "../core/capabilities/types";
import { usable } from "./asking";
import { VoiceMemory, type ModelCall, type VoiceTurn } from "./memory";
import { ALWAYS_SHOWN, CapabilityIndex, indexText, instant, SHORTLIST, shortlist, type Embed, type Ranked } from "./rank";
import { forModel, spoken, type VoiceResult } from "./result";

export type { ModelCall } from "./memory";

/** An earlier turn, as a model is given it: the sentence, what was called, what came of it. */
export type ModelTurn = Pick<VoiceTurn, "said" | "calls" | "result">;

/** One round of this turn, as a model is given it back: its calls and what each came to. */
export interface ModelStep {
  calls: ModelCall[];
  results: string[];
}

/** The model server chosen for voice; null when it cannot be asked or does not answer. */
export type LocalModel = (
  system: string,
  said: string,
  tools: unknown[],
  history: ModelTurn[],
  steps?: ModelStep[],
) => Promise<{ calls: ModelCall[]; text: string } | null | undefined>;

/**
 * The provider chosen for the chat. It reaches the capabilities by itself
 * (`cloudCall` answers each one) and gives back its last words; null when it
 * cannot be asked or did not answer.
 */
export type CloudModel = (system: string, said: string, history: ModelTurn[]) => Promise<{ text: string } | null | undefined>;

/** A turn is at most this many rounds of the model calling capabilities. */
export const MOST_MODEL_ROUNDS = 5;
/** At most this many calls are run for one round. */
export const MOST_CALLS = 4;
/** Past this, a turn says what it has with the capabilities' own lines. */
export const TURN_BUDGET_MS = 8000;
/** How long the model is waited for once something was done: its words are a nicety. */
export const WORDING_MS = 2500;
/** How long the model that reads a spoken answer is waited for. */
export const ANSWER_MS = 4000;
/** How long the cloud tier may take, as Rust allows it (voice_cloud): it is for what is worth waiting for. */
export const CLOUD_BUDGET_MS = 150_000;
/** After the embedding model did not answer, it is not asked again for this long. */
export const EMBED_RETRY_MS = 60_000;

const MORE_TOOLS = "more_tools";
/** Putting the last change back is about the conversation, whatever it was about: shown whatever the sentence is. */
const UNDO = "undo";
const NOTHING = "nothing";
const ESCALATE = "escalate";

/** The lines the turn itself shows, worded and translated by its maker. */
export interface TurnWords {
  /** No model server is chosen for voice. */
  noModel(): string;
  /** The model was asked and did not answer. */
  silent(): string;
  /** The model answered and nothing came of it. */
  notUnderstood(): string;
  /** Handed up, and there is no cloud model to hand it to. */
  beyond(): string;
  /** While the cloud model works. */
  askingCloud(): string;
}

export interface TurnOptions {
  registry: Registry;
  /** The embedding model; answers null when there is none. */
  embed: Embed;
  /** The model server chosen for voice, or null when none is. */
  local: () => LocalModel | null;
  /** The cloud model, or null unless the user turned it on. */
  cloud: () => CloudModel | null;
  /**
   * Whether a sentence said without the wake phrase may be given to the local
   * model, to decide whether it was meant for Coucou: only when the model
   * server is this computer. False: such a sentence is for nobody.
   */
  followUp?: () => boolean;
  /** Gives the cloud model's endpoint the capabilities it may ask for. */
  publish?: (tools: unknown[]) => void;
  words: TurnWords;
  now?: () => number;
}

export interface Hearing {
  /** False for a sentence said without the wake phrase: the local model decides whether it was for Coucou. */
  wake?: boolean;
  /** How sure the speech model was of each word, when it says. */
  sure?: readonly number[];
  /** The sentence is taken as said to Coucou: called before anything shows or runs. Not called for one that is ignored. */
  taken?: () => void;
  /** The answer has to be waited for. `line`: what is being done, when known. `ms`: for how long at most, when it is long. */
  waiting?: (line?: string, ms?: number) => void;
  /** Something was done and there is more to come: the line to show meanwhile. */
  working?: (line: string) => void;
  /** Asked before anything is done after a wait: false when nobody waits for it any more. */
  wanted?: () => boolean;
}

/** What a sentence came to. */
export interface Heard {
  /** For the card; null when there is nothing to show. */
  result: VoiceResult | null;
  /** False for a sentence that was not for Coucou: nothing was done and nothing is shown. */
  taken: boolean;
  /** The user is done talking: nothing more is listened for until the wake phrase. */
  rest: boolean;
  /** Said in place of an answer to a question, and a request of its own: to be heard as the next turn. */
  next?: string;
}

/** What a sentence said while a question is on screen does to it. */
export type AnswerHeard =
  /** It answered the question. */
  | { is: "answer" }
  /** A text field: this is what it holds now. */
  | { is: "draft"; value: string }
  /** Not an answer: the question stays. */
  | { is: "unclear" };

/** One capability that ran in a turn, and what it said. */
interface Ran {
  call: ModelCall;
  result: ToolResult;
  capability: Capability | undefined;
}

/** A turn while it runs. */
interface Running {
  said: string;
  how: Hearing;
  ran: Ran[];
  /** When the time a turn may take started; set again after the user answered a question. */
  started: number;
  /** Taken as said to Coucou: by the wake phrase, or by the local model calling something. */
  taken: boolean;
  /** The app's things the sentence names, or perhaps names (Registry.named). */
  named: readonly { kind: string; id: string; label: string; near?: boolean }[];
}

const IGNORED: Heard = { result: null, taken: false, rest: false };

// ── What a model is told ──────────────────────────────────────────────────────

const INTRO = "You are the voice of Coucou, a small desktop app: its user has just said one sentence to it, and you act for them through the app's own capabilities, given to you as tools.";

/** Said after the app's state: a small model follows best what it read last. */
const ROLE = [
  "How to act:",
  "- Do what was asked by calling capabilities. Several things asked are several calls.",
  "- Names: write each name in the arguments in the user's own words, as it was heard, even when it looks misheard, cut short or unlike anything in the state (\"open st\" is the app \"st\", \"open this squad\" the app \"this squad\"). The app looks it up and asks the user when it is not sure. A name you do not know is never a reason to do nothing. Never write a name or an address the user did not say.",
  "- A sentence that goes on from the turn before (\"and Discord too\", \"what about Steam\") asks for the same again, for what it names now.",
  "- A correction of the turn before (\"no, I meant Resend\", \"take that one off\") is a request: put the last change back with undo, then do what is meant now, if anything.",
  "- When the user says not to do something, or never to, do not do it: call the capability named nothing.",
  "- Some capabilities wait for the user's click before anything happens. That is the app's doing: call them when they are what was asked.",
  "- A question about the app is answered from its state, below, or by a capability that reads.",
  "- When what was heard asks nothing of Coucou, call the capability named nothing.",
  "- When no capability does what was asked, say so in words. Never call one that does something else instead.",
  "- Never say something was done unless a capability's result says so.",
  "- When you answer in words: one or two short sentences, plain text, no lists.",
].join("\n");

/**
 * With no embedding model, the areas come first: the model is asked, with
 * nothing else to do, which part of the app the sentence is about. Each area
 * is a line of what it holds, written as plain words: given the capabilities'
 * names as they are called, a small model calls one before it has it.
 */
const AREAS_FIRST = [
  "The user of the desktop app Coucou has just said one sentence to it. Say which parts of the app the sentence is about, by calling the tool named about, once.",
  "The app's areas, and what each can do:",
  "{areas}",
  "Give the three areas the sentence is most likely about: the most likely as first, then second and third. When the sentence asks nothing of the app, give none for all three.",
].join("\n");

const SHORTLISTED = "Your tools are the capabilities nearest to what was said. When none of them is what was asked, call more_tools with an area to be given that area's.";

const BY_AREA = "Your tools are the capabilities of the areas the sentence is about. When none of them is what was asked, call more_tools with another area to be given that area's.";

/** Told to the model of a sentence said without the wake phrase. */
const ASIDE =
  "This sentence was said without Coucou's name, a few seconds after the turn above: it may have been said to someone else in the room. Unless it plainly asks Coucou for something, call the capability named nothing.";

const AFTER_CALLS =
  "The results of your calls are above. If what was asked needs another capability, call it now. Otherwise say what happened in one short sentence, from the results alone.";

/** Said when the model answered with nothing at all. */
const EMPTY = "Your last answer was empty. Call the capability that does what was asked, or the one named nothing, or answer in words.";

/** Once the app's capabilities ran, the model only decides what else to call: its words are not what Mochi says. */
const AFTER_RAN = "The results of your calls are above. If what was asked needs another capability, call it now. Otherwise reply with the one word: done.";

/**
 * What only read the app is put in words by a model given those results and
 * nothing else — not the sentence, not the turns before, no tools — so that
 * it has nothing to say but what they hold.
 */
const REPORT = [
  "An assistant has just read parts of a desktop app's state for its user, through the app's own capabilities. What each read gave back is below, as JSON.",
  "{results}",
  "Tell the user what they hold, as if you had looked yourself: one or two short sentences of plain text that keep every fact, a state such as passing or failing above all. Only what is in the results: add nothing, guess nothing, offer nothing, ask nothing. Do not mention the app, the reads or the results.",
].join("\n\n");

/** The user's message of that call: the results are in the system's. */
const REPORT_ASKED = "What did the app read?";

const READ_ANSWER = [
  "The user of a desktop app was asked a question on screen and has just answered out loud. Read their answer and call the tool named answer, once.",
  "Question: {question}",
  "Options:",
  "{options}",
].join("\n");

/** `tools`: how the tools the model is shown were chosen. */
function systemPrompt(snapshot: Record<string, unknown>, tools: string): string {
  return [INTRO, `The app's state now, as JSON:\n${JSON.stringify(snapshot)}`, ROLE, tools].join("\n\n");
}

// ── The turns ─────────────────────────────────────────────────────────────────

export class VoiceTurns {
  readonly memory = new VoiceMemory();

  private registry: Registry;
  private index: CapabilityIndex;
  private embed: Embed;
  private local: () => LocalModel | null;
  private cloud: () => CloudModel | null;
  private publish: (tools: unknown[]) => void;
  private followUp: () => boolean;
  private words: TurnWords;
  private now: () => number;

  /** What the index was last given, to see that the capabilities changed. */
  private indexed = "";
  /** When the embedding model last failed to answer. */
  private embedFailedAt = -Infinity;
  /** What the cloud's endpoint was last given. */
  private published = "";
  /** The turn the cloud model is working on: its calls are run for this one and for nothing else. */
  private cloudTurn: Running | null = null;
  /** Said while a question was on screen, and a request of its own. */
  private nextSaid: string | null = null;

  constructor(options: TurnOptions) {
    this.registry = options.registry;
    this.embed = options.embed;
    this.index = new CapabilityIndex(options.embed);
    this.local = options.local;
    this.cloud = options.cloud;
    this.publish = options.publish ?? (() => {});
    this.followUp = options.followUp ?? (() => false);
    this.words = options.words;
    this.now = options.now ?? (() => Date.now());
  }

  /** Voice was turned off, or the conversation is over: nothing is remembered. */
  forget() {
    this.memory.clear();
    this.nextSaid = null;
    this.answer({ kind: "dropped" });
  }

  /** The embedding model may have changed (Settings): the capabilities are embedded again, from nothing. */
  resync() {
    this.index = new CapabilityIndex(this.embed);
    this.indexed = "";
    this.embedFailedAt = -Infinity;
  }

  // ── A question on screen (voice/result.ts `Ask`) ────────────────────────────

  /** Told when a question goes up, and with null when it is answered or dropped. */
  onAsk: ((ask: Ask | null) => void) | null = null;

  private waitingFor: { ask: Ask; resolve: (answer: Answer) => void } | null = null;

  /** The question waiting for its answer, if one is. */
  get asked(): Ask | null {
    return this.waitingFor?.ask ?? null;
  }

  /**
   * Puts a question on screen and waits for the answer: a click, a key, or
   * what is said next. One at a time: a question asked over another drops the
   * first. A question that cannot be shown is dropped at once.
   */
  askUser(ask: Ask): Promise<Answer> {
    const shown = usable(ask);
    if (!shown) return Promise.resolve({ kind: "dropped" });
    this.answer({ kind: "dropped" });
    return new Promise((resolve) => {
      this.waitingFor = { ask: shown, resolve };
      this.onAsk?.(shown);
    });
  }

  /** The answer to the question on screen, by a click or a key. False when none was waiting. */
  answer(answer: Answer): boolean {
    const waiting = this.waitingFor;
    if (!waiting) return false;
    this.waitingFor = null;
    this.onAsk?.(null);
    waiting.resolve(answer);
    return true;
  }

  /**
   * What was said while a question is on screen. A text field is dictated
   * into: the words are taken as they are, and a key or a click confirms. A
   * choice or a yes/no is read by the local model, which is given the question
   * and its options as one tool and nothing else. `draft`: what the field holds.
   */
  async answerSaid(said: string, draft = ""): Promise<AnswerHeard> {
    const ask = this.asked;
    const sentence = said.trim();
    if (!ask || !sentence) return { is: "unclear" };
    if (ask.kind === "text") return { is: "draft", value: draft.trim() ? `${draft.trim()} ${sentence}` : sentence };
    const local = this.local();
    if (!local) return { is: "unclear" };

    const options = ask.kind === "choice"
      ? ask.options.map((option, i) => ({ value: String(i + 1), label: option.hint ? `${option.label} (${option.hint})` : option.label }))
      : [{ value: "yes", label: ask.yes ?? "Yes" }, { value: "no", label: ask.no ?? "No" }];
    const system = READ_ANSWER
      .replace("{question}", ask.question)
      .replace("{options}", options.map((o) => `${o.value}: ${o.label}`).join("\n"));
    const reply = await within(local(system, sentence, [answerTool(options.map((o) => o.value))], []), ANSWER_MS);
    // Answered meanwhile by a click, or dropped: this reading is for nothing.
    if (this.asked !== ask) return { is: "answer" };
    const call = reply ? [...reply.calls, ...written(reply.text, new Set(["answer"]))].find((c) => c.name === "answer") : undefined;
    const chosen = typeof call?.arguments?.option === "string" ? call.arguments.option.trim().toLowerCase() : "";
    const given: Answer | null =
      chosen === "none" ? { kind: "dropped" }
      : ask.kind === "yes_no" ? (chosen === "yes" || chosen === "no" ? { kind: "yes_no", yes: chosen === "yes" } : null)
      : ask.options[Number(chosen) - 1] ? { kind: "choice", id: ask.options[Number(chosen) - 1].id } : null;
    if (!given) return { is: "unclear" };
    // "No, Discord": no to this, and a request of its own, heard once this turn is over.
    const refusal = given.kind === "dropped" || (given.kind === "yes_no" && !given.yes);
    if (refusal && call?.arguments?.also_asks === true) this.nextSaid = sentence;
    this.answer(given);
    return { is: "answer" };
  }

  // ── A sentence ──────────────────────────────────────────────────────────────

  /** Understands a sentence and does it. */
  async hear(said: string, how: Hearing = {}): Promise<Heard> {
    const sentence = said.trim();
    if (!sentence) return IGNORED;
    const wake = how.wake ?? true;
    // Without the wake phrase: only a model on this computer is given it, and with no model it is for nobody.
    if (!wake && (!this.followUp() || !this.local())) return IGNORED;
    const turn: Running = { said: sentence, how, ran: [], started: this.now(), taken: wake, named: [] };
    if (wake) how.taken?.();
    const before = this.memory.recent(this.now());
    turn.named = await this.registry.named(sentence);
    const ranked = await this.ranked(turn, before[before.length - 1]?.said);

    const heard = await this.understand(turn, ranked);
    if (!turn.taken) return IGNORED;
    const next = this.nextSaid;
    this.nextSaid = null;
    return next ? { ...heard, next } : heard;
  }

  private async understand(turn: Running, ranked: Ranked[] | null): Promise<Heard> {
    // Tier 1: the ranking names one capability, clearly. No model is asked — and not for a sentence that may be for nobody.
    const name = ranked && turn.taken ? instant(ranked, this.registry.all()) : null;
    if (name) {
      const done = await this.instantly(name, turn);
      if (done) return this.end(turn, "");
    }

    // Tier 2: the local model.
    const local = this.local();
    if (!local) return this.end(turn, "", this.words.noModel());
    turn.how.waiting?.();
    const came = await this.locally(local, turn, ranked);
    if (came.is === "dropped") return { result: null, taken: true, rest: false };
    if (came.is === "answered") return this.end(turn, came.words);
    // What may have been said to someone else never goes further than this computer.
    if (!turn.taken) return IGNORED;

    // Tier 3: handed up, or the local model did not answer — when the user allowed a cloud model.
    const cloud = this.cloud();
    if (!cloud) return this.end(turn, "", came.is === "escalated" ? this.words.beyond() : this.words.silent());
    turn.how.waiting?.(this.words.askingCloud(), CLOUD_BUDGET_MS);
    const words = await this.cloudly(cloud, turn);
    if (turn.how.wanted && !turn.how.wanted()) return { result: null, taken: true, rest: false };
    return this.end(turn, words ?? "", words == null && !shownOf(turn).length ? this.words.silent() : undefined);
  }

  // ── The ranking ─────────────────────────────────────────────────────────────

  /** The capabilities by how near the sentence is to each; null with no embedding model. */
  private async ranked(turn: Running, previous?: string): Promise<Ranked[] | null> {
    const sentence = turn.said;
    const capabilities = this.registry.all().map((c) => ({ name: c.name, text: indexText(c), kinds: kindsOf(c) }));
    const key = capabilities.map((c) => `${c.name}\n${c.text}`).join("\n\n");
    if (key !== this.indexed) {
      // An embedding model that is not there is not asked at every sentence.
      if (this.now() - this.embedFailedAt < EMBED_RETRY_MS) return null;
      if (!(await this.index.sync(capabilities))) {
        this.embedFailedAt = this.now();
        return null;
      }
      this.indexed = key;
    }
    // The names the app has that the sentence holds: they are not embedded, and what takes their kind is nearer.
    const named = turn.named;
    return this.index.rank(sentence, previous, { kinds: [...new Set(named.map((n) => n.kind))], labels: named.filter((n) => !n.near).map((n) => n.label) });
  }

  // ── Running a capability ────────────────────────────────────────────────────

  private context(origin: RunContext["origin"], turn: Running): RunContext {
    return {
      origin,
      ask: async (ask) => {
        const answer = await this.askUser(ask);
        // The time someone takes to answer is not the turn's.
        turn.started = this.now();
        return answer;
      },
      working: (line) => turn.how.working?.(line),
    };
  }

  private async run(call: ModelCall, origin: RunContext["origin"], turn: Running): Promise<ToolResult> {
    const result = await this.registry.execute(call, this.context(origin, turn));
    turn.ran.push({ call, result, capability: this.registry.get(call.name) });
    return result;
  }

  // ── Tier 1 ──────────────────────────────────────────────────────────────────

  /**
   * Runs the capability the ranking named. A thing it must be given the name
   * of is looked for in the sentence itself, by the executor: the whole
   * sentence is the argument, and what it names is resolved or asked about.
   * False when that came to nothing — no such thing, or not a call that can be
   * made this way — and a model should read the sentence instead.
   */
  private async instantly(name: string, turn: Running): Promise<boolean> {
    const capability = this.registry.get(name);
    if (!capability) return false;
    const named = Object.entries(capability.args).filter(([, spec]) => !spec.optional);
    // Two things to name in one sentence: which is which is a model's to read.
    if (named.length > 1) return false;
    const args = Object.fromEntries(named.map(([arg]) => [arg, turn.said]));
    const result = await this.registry.execute({ name, arguments: args }, this.context("instant", turn));
    if (result.status === "not_found" || result.status === "refused") return this.local() == null && this.record(turn, name, args, result);
    return this.record(turn, name, args, result);
  }

  private record(turn: Running, name: string, args: Record<string, unknown>, result: ToolResult): true {
    turn.ran.push({ call: { name, arguments: args }, result, capability: this.registry.get(name) });
    return true;
  }

  // ── Tier 2 ──────────────────────────────────────────────────────────────────

  private async locally(
    local: LocalModel,
    turn: Running,
    ranked: Ranked[] | null,
  ): Promise<{ is: "answered"; words: string } | { is: "escalated" } | { is: "silent" } | { is: "dropped" }> {
    const { how, said } = turn;
    const capabilities = this.registry.all();
    const declared = new Set(capabilities.map((c) => c.name));
    // Handing up is offered only when there is somebody to hand up to.
    const offered = (names: readonly string[]) => names.filter((n) => declared.has(n) && (n !== ESCALATE || (turn.taken && this.cloud() != null)));
    const history: ModelTurn[] = this.memory.recent(this.now()).map(({ said: s, calls, result }) => ({ said: s, calls, result }));
    // A follow-up ("and Discord too") goes on with what the turn before called, whatever it ranks alone.
    const carried = (history[history.length - 1]?.calls ?? []).map((call) => call.name);
    const shown = new Set(offered([...(ranked ? shortlist(ranked, capabilities, SHORTLIST, [...carried, ...takers(ranked, capabilities, turn.named)]) : [...ALWAYS_SHOWN, ...carried]), UNDO]));
    // What cannot be used right now is not offered (no question waits, the chat's field is empty): read again
    // each round, since a call may make another usable — a message prepared can be sent.
    const usable = (name: string) => {
      try {
        return (this.registry.get(name)?.available?.() ?? true) === true;
      } catch {
        return false;
      }
    };
    const tools = () => [...shown].filter(usable).map((name) => this.registry.schema(name)).filter(Boolean);

    const snapshot = await this.registry.snapshot();

    // No ranking: the areas first. The model says which the sentence is about
    // — one tool, nothing else to do — and is then shown those areas' capabilities.
    if (!ranked) {
      const all = this.registry.areas();
      const lines = all.map(({ area, names }) => `${area}: ${names.map((name) => name.split("_").join(" ")).join(", ")}`).join("\n");
      // With the app's state: which area a name belongs to is read there (a pill, a session, a setting).
      const router = [AREAS_FIRST.replace("{areas}", lines), `The app's state now, as JSON:\n${JSON.stringify(snapshot)}`, namedLine(turn.named)].filter(Boolean).join("\n\n");
      const routed = await local(router, said, [aboutTool(all.map(({ area }) => area))], history);
      if (how.wanted && !how.wanted()) return { is: "dropped" };
      if (!routed) return { is: "silent" };
      const about = [...routed.calls, ...written(routed.text, new Set(["about"]))].find((call) => call.name === "about")?.arguments ?? {};
      const picked = [about.first, about.second, about.third];
      for (const { area, names } of all) if (picked.includes(area)) for (const name of offered(names)) shown.add(name);
    }
    const system = [systemPrompt(snapshot, ranked ? SHORTLISTED : BY_AREA), namedLine(turn.named), turn.taken ? "" : ASIDE].filter(Boolean).join("\n\n");

    let reply = await local(system, said, tools(), history);
    if (how.wanted && !how.wanted()) return { is: "dropped" };
    // An empty answer — no call, no words — is a small model's call that did not come out: asked once more.
    if (reply && !reply.calls.length && !reply.text.trim()) {
      reply = await local(`${system}\n\n${EMPTY}`, said, tools(), history);
      if (how.wanted && !how.wanted()) return { is: "dropped" };
    }
    if (!reply) return { is: "silent" };

    const steps: ModelStep[] = [];
    let words = "";
    for (let round = 1; ; round++) {
      // Calls written out as text are calls; what is left of them is never Mochi's words.
      const calls = reply.calls.length ? reply.calls : written(reply.text, declared);
      if (!calls.length) {
        words = looksWritten(reply.text) ? "" : reply.text;
        break;
      }
      // What it already called it has nothing more to ask of: nothing is done twice for one sentence.
      const fresh = calls.filter((call) => !turn.ran.some((ran) => same(ran.call, call))).slice(0, MOST_CALLS);
      if (!fresh.length) break;
      // Said without the wake phrase: it was for Coucou once the model asks for something the app does.
      if (!turn.taken && fresh.some((call) => declared.has(call.name) && ![NOTHING, MORE_TOOLS, ESCALATE].includes(call.name))) {
        turn.taken = true;
        how.taken?.();
      }

      const step: ModelStep = { calls: [], results: [] };
      for (const call of fresh) {
        const result = await this.run(call, "local", turn);
        if (how.wanted && !how.wanted()) return { is: "dropped" };
        if (call.name === ESCALATE && result.status === "done") return { is: "escalated" };
        step.calls.push(call);
        // An area's capabilities, asked for: they are tools from the next round on.
        const listed = call.name === MORE_TOOLS && result.status === "done" ? offered(namesIn(result.data)) : [];
        for (const added of listed) shown.add(added);
        step.results.push(JSON.stringify(listed.length ? { status: "done", result: `Now among your tools: ${listed.join(", ")}.` } : forModel(result)));
      }
      steps.push(step);
      // Asked for nothing: there is nothing to go on with, and nothing to say.
      if (fresh.every((call) => call.name === NOTHING)) break;

      const left = TURN_BUDGET_MS - (this.now() - turn.started);
      if (round >= MOST_MODEL_ROUNDS || left <= 0) break;
      const line = lineOf(turn);
      if (line) how.working?.(line);
      // Once something was done the model is waited for a little: what it adds is how it is said.
      const after = shownOf(turn).length ? AFTER_RAN : AFTER_CALLS;
      const next = await within(local(`${system}\n\n${after}`, said, tools(), history, steps), acted(turn) ? Math.min(left, WORDING_MS) : left);
      if (how.wanted && !how.wanted()) return { is: "dropped" };
      if (!next) break;
      reply = next;
    }
    // What only read is said from what was read, and from nothing else.
    if (shownOf(turn).length && !acted(turn) && shownOf(turn).every((ran) => ran.result.status === "done")) {
      words = (await this.report(local, turn)) ?? "";
      if (how.wanted && !how.wanted()) return { is: "dropped" };
    }
    return { is: "answered", words };
  }

  /** The reads of this turn in words, by a model given their results alone; null when it did not answer. */
  private async report(local: LocalModel, turn: Running): Promise<string | null> {
    const results = shownOf(turn).map((ran) => ({
      read: ran.capability ? indexText(ran.capability) : ran.call.name,
      ...(Object.keys(ran.call.arguments ?? {}).length ? { of: ran.call.arguments } : {}),
      ...forModel(ran.result),
    }));
    const left = TURN_BUDGET_MS - (this.now() - turn.started);
    const reply = await within(local(REPORT.replace("{results}", JSON.stringify(results)), REPORT_ASKED, [], []), Math.max(WORDING_MS, left));
    const text = reply && !reply.calls.length && !looksWritten(reply.text) ? reply.text.trim() : "";
    return text || null;
  }

  // ── Tier 3 ──────────────────────────────────────────────────────────────────

  private async cloudly(cloud: CloudModel, turn: Running): Promise<string | null> {
    // Everything declared but the two that speak to the local model.
    const names = this.registry.all().map((c) => c.name).filter((n) => n !== ESCALATE && n !== MORE_TOOLS);
    const key = names.join(",");
    if (key !== this.published) {
      this.publish(names.map((name) => this.registry.schema(name)));
      this.published = key;
    }
    const system = systemPrompt(await this.registry.snapshot(), "Your tools are the app's capabilities.");
    const history: ModelTurn[] = this.memory.recent(this.now()).map(({ said, calls, result }) => ({ said, calls, result }));
    this.cloudTurn = turn;
    try {
      const reply = await within(cloud(system, turn.said, history), CLOUD_BUDGET_MS);
      return reply ? reply.text : null;
    } finally {
      this.cloudTurn = null;
    }
  }

  /**
   * A capability the cloud model asked for, through its endpoint: run by the
   * executor like any other, and answered with what a model is given back.
   * Only while a turn the user started is with the cloud model: a call that
   * comes at any other time is for nobody, and is refused.
   */
  async cloudCall(name: string, args: unknown): Promise<string> {
    const turn = this.cloudTurn;
    if (!turn) return JSON.stringify({ status: "refused", result: "No request of the user's is being worked on." });
    const call: ModelCall = { name: String(name), arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
    return JSON.stringify(forModel(await this.run(call, "cloud", turn)));
  }

  // ── The end of a turn ───────────────────────────────────────────────────────

  /**
   * What the card says, and what is remembered. `words`: the model's last
   * words. `failure`: the turn's own line when nothing could be done at all.
   */
  private end(turn: Running, words: string, failure?: string): Heard {
    // Not taken as said to Coucou: nothing is shown, and nothing is remembered.
    if (!turn.taken) return IGNORED;
    const shown = shownOf(turn);
    const calls = turn.ran.map((ran) => ran.call);
    const finish = (result: VoiceResult | null, rest = false): Heard => {
      this.memory.remember({ said: turn.said, calls, result: result?.message ?? "" }, this.now());
      return { result, taken: true, rest };
    };

    if (!shown.length) {
      // Asked for nothing: the user is done.
      if (turn.ran.some((ran) => ran.call.name === NOTHING)) return finish(null, true);
      if (failure) return { result: { outcome: "failure", message: failure }, taken: true, rest: false };
      const answer = spoken(words, "");
      return finish(answer ? { outcome: "success", message: answer } : { outcome: "failure", message: this.words.notUnderstood() });
    }
    // What went wrong is what is shown, in the capability's own line.
    const wrong = shown.find((ran) => ran.result.status !== "done");
    if (wrong) return finish({ outcome: "failure", message: wrong.result.line });
    // What was done is said in the lines of what did it, and in nothing else:
    // a model's words can name what no capability did ("Stripe removed" when
    // nothing removed it); a capability's line is what it did. Only what
    // merely read is put in words (`report`: a model given the results alone).
    const doing = shown.filter((ran) => ran.capability?.tier !== "read");
    const message = doing.length ? linesOf(doing) : spoken(words, linesOf(shown));
    return finish(message ? { outcome: "success", message } : null);
  }
}

// ── Small things ──────────────────────────────────────────────────────────────

/**
 * What the app found the sentence names, for the model: a name it knows
 * nothing of ("spy flight") is said to be perhaps an app the app has. It is
 * still passed on as heard; the executor asks before acting on a near one.
 */
function namedLine(named: Running["named"]): string {
  if (!named.length) return "";
  const things = named.map((n) => (n.near ? `perhaps ${n.label} (${n.kind}, heard as something close to it)` : `${n.label} (${n.kind})`));
  return `In what was said, the app finds: ${things.join("; ")}.`;
}

/**
 * For each kind of thing the sentence names, the best-ranked capability that
 * takes it: "open Discord" names an app, and what opens an app is shown
 * however near "open" alone is to opening a folder or a conversation.
 */
function takers(ranked: readonly Ranked[], capabilities: readonly Capability[], named: Running["named"]): string[] {
  const kinds = new Map(capabilities.map((c) => [c.name, kindsOf(c)]));
  const out: string[] = [];
  for (const kind of new Set(named.map((n) => n.kind))) {
    const best = ranked.find((r) => kinds.get(r.name)?.includes(kind));
    if (best && !out.includes(best.name)) out.push(best.name);
  }
  return out;
}

/** The kinds of thing a capability takes as an argument. */
export const kindsOf = (capability: Capability): string[] =>
  Object.values(capability.args).flatMap((spec) => (spec.type === "entity" || spec.type === "entities" ? [spec.kind] : []));

/** What ran that is the app's doing: not the capabilities that are about the conversation. */
const shownOf = (turn: Running) => turn.ran.filter((ran) => ![MORE_TOOLS, NOTHING, ESCALATE].includes(ran.call.name));

/** Something was changed or shown, not only read. */
const acted = (turn: Running) =>
  shownOf(turn).some((ran) => ran.result.status === "done" && ran.capability != null && ran.capability.tier !== "read");

/** The lines of what ran, each once, as sentences: "Paused. Stripe removed." */
function linesOf(ran: readonly Ran[]): string {
  const lines = [...new Set(ran.map((r) => r.result.line.trim()).filter(Boolean))];
  return lines.map((line, i) => (i < lines.length - 1 && !/[.!?…]$/.test(line) ? `${line}.` : line)).join(" ");
}

/** The last line a capability gave, for the card while the model goes on. */
const lineOf = (turn: Running) => [...shownOf(turn)].reverse().find((ran) => ran.result.line)?.result.line ?? "";

const same = (a: ModelCall, b: ModelCall) => a.name === b.name && JSON.stringify(a.arguments ?? {}) === JSON.stringify(b.arguments ?? {});

/** The capabilities `more_tools` listed, by name. */
function namesIn(data: unknown): string[] {
  const listed = (data as { capabilities?: unknown } | null)?.capabilities;
  if (!Array.isArray(listed)) return [];
  return listed.map((item) => (item as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === "string");
}

/** The one tool the model is given when it is asked which areas a sentence is about. */
function aboutTool(areas: readonly string[]) {
  return {
    type: "function",
    function: {
      name: "about",
      description: "Says which areas of the app a sentence is about.",
      parameters: {
        type: "object",
        // Three named places rather than a list: asked for a list, a small model gives one area and stops.
        properties: {
          first: { type: "string", enum: [...areas, "none"], description: "The most likely area." },
          second: { type: "string", enum: [...areas, "none"], description: "The next most likely area." },
          third: { type: "string", enum: [...areas, "none"], description: "The third most likely area." },
        },
        required: ["first", "second", "third"],
        additionalProperties: false,
      },
    },
  };
}

/** The one tool the model that reads a spoken answer is given. */
function answerTool(options: readonly string[]) {
  return {
    type: "function",
    function: {
      name: "answer",
      description: "Gives the user's answer to the question.",
      parameters: {
        type: "object",
        properties: {
          option: {
            type: "string",
            enum: [...options, "none", "unclear"],
            description: "The option the user chose. 'none' when they turn every option down or want the question dropped. 'unclear' when what they said does not answer the question.",
          },
          also_asks: { type: "boolean", description: "True when, besides answering, they ask for something else to be done." },
        },
        required: ["option"],
        additionalProperties: false,
      },
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The calls a model wrote out as text instead of making them — JSON with a
 * name and arguments, with or without a code fence. A small model does this
 * now and then. A data format is read here, nothing a person said; only the
 * names of capabilities that exist are taken.
 */
export function written(text: string, known: ReadonlySet<string>): ModelCall[] {
  const body = text.replace(/```[a-z]*\n?|```|<\/?tool_call>/gi, " ").trim();
  if (!body) return [];
  const whole = safeJson(body);
  // A capability's name alone, or followed by its arguments as JSON: `nothing`, `open_app {"app": "Steam"}`.
  const bare = whole == null ? /^([a-z][a-z0-9_]*)\s*(?:\(\s*(\{[\s\S]*\})\s*\)|(\{[\s\S]*\}))?\s*$/.exec(body) : null;
  if (bare && known.has(bare[1])) {
    const given = bare[2] ?? bare[3];
    const args = given ? safeJson(given) : {};
    return args && typeof args === "object" && !Array.isArray(args) ? [{ name: bare[1], arguments: args as Record<string, unknown> }] : [];
  }
  const calls: ModelCall[] = [];
  for (const item of Array.isArray(whole) ? whole : whole ? [whole] : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const fn = (o.function && typeof o.function === "object" ? o.function : o) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!known.has(name)) continue;
    const raw = fn.arguments ?? fn.parameters ?? {};
    const args = typeof raw === "string" ? safeJson(raw) : raw;
    calls.push({ name, arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} });
  }
  return calls;
}

/** Text that is a model's plumbing showing through, not a sentence for a person: never shown, never said. */
export function looksWritten(text: string): boolean {
  const body = text.trim();
  return /^[\[{]/.test(body) || /^```/.test(body) || /<tool_call>/.test(body);
}

/** What a promise comes to, or null when it has not by then or it broke. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
