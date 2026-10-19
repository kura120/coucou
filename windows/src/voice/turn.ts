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
// it. Without it — the few seconds after a turn — it is taken as said to
// Coucou too (the user's choice: better answer a remark than ignore a
// request), given only to a model on this computer, with the turn before;
// the model calls `nothing` for what plainly was for someone else, and the
// island then closes again. Such a sentence never reaches the cloud.
//
// Nothing here reads a word of what was said. A sentence is embedded whole or
// handed to a model whole; what it means is theirs to work out, and what may
// be done is the executor's to decide (the capability's tier, a click for
// `confirm`). The texts below are instructions to a model, not rules about
// wording. The one comparison with the sentence is of names: whether it
// holds a name a model wrote (`asHeard`), by the matcher's own normalising.
// What Mochi says of what was done is the capabilities' own lines; a model
// words only what was read, given nothing but the results (`report`).
// Nothing said is written to disk or logged.

import type { Answer, Ask, Capability, Registry, RunContext, ToolResult } from "../core/capabilities/types";
import { usable } from "./asking";
import { normalise } from "./entity";
import { VoiceMemory, type ModelCall, type VoiceTurn } from "./memory";
import { CapabilityIndex, indexText, instant, SHORTLIST, shortlist, type Embed, type Ranked } from "./rank";
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
/** A free action done again on purpose ("skip twice") runs this many times at most in one turn. */
export const MOST_REPEATS = 3;
/** Past this, a turn says what it has with the capabilities' own lines. */
export const TURN_BUDGET_MS = 8000;
/** How long the model is waited for once something was done: its words are a nicety. */
export const WORDING_MS = 2500;
/** How long the model that reads a spoken answer is waited for. */
export const ANSWER_MS = 4000;
/** How long the cloud tier may take, as Rust allows it (voice_cloud): it is for what is worth waiting for. */
export const CLOUD_BUDGET_MS = 150_000;
/** After the embedding model did not answer, it is not asked again for this long. */
export const EMBED_RETRY_MS = 10_000;

const MORE_TOOLS = "more_tools";
/** Putting the last change back is about the conversation, whatever it was about: shown whatever the sentence is. */
const UNDO = "undo";
const NOTHING = "nothing";
const ESCALATE = "escalate";
const ASK_USER = "ask_user";

/** The lines the turn itself shows, worded and translated by its maker. */
export interface TurnWords {
  /** No model server is chosen for voice. */
  noModel(): string;
  /** No embedding model is chosen for voice: it is what finds the capabilities a sentence is about. */
  noEmbedding(): string;
  /** The embedding model was asked and did not answer. */
  embedSilent(): string;
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
  /** Whether one is chosen at all: without one, voice says so rather than guess. */
  embedChosen?: () => boolean;
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
  /**
   * The debug log, when the user turned it on (voice/debug.rs): told each
   * step of a turn in a line — what was heard and ranked, what the models
   * were asked and answered, what ran and what came of it. Absent: nothing is
   * written anywhere.
   */
  trace?: (line: string) => void;
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
  /**
   * Something ran: true when the model's words for it were said, false when
   * they did not hold up against the results and the capabilities' lines were
   * said instead. Absent when nothing ran, or no model put it in words.
   */
  worded?: boolean;
  /** Why they did not: "unseen", "thing" or "number" (`unfounded`). */
  unworded?: string;
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
  /** Taken as said to Coucou: always, now; false only for a turn that ends ignored. */
  taken: boolean;
  /** Said after the wake phrase. Without it, the sentence never reaches the cloud. */
  wake: boolean;
  /** Whether the model's words for what ran held up against the results (`checked`), and if not, why. */
  worded?: boolean;
  unworded?: string;
  /** The app's things the sentence names, or perhaps names (Registry.named). */
  named: readonly { kind: string; id: string; label: string; near?: boolean; heard?: string }[];
}

const IGNORED: Heard = { result: null, taken: false, rest: false };

// ── What a model is told ──────────────────────────────────────────────────────

const INTRO = "You are the voice of Coucou, a small desktop app: its user has just said one sentence to it, and you act for them through the app's own capabilities, given to you as tools.";

/** Said after the app's state: a small model follows best what it read last. */
const ROLE = [
  "How to act:",
  "- Do what was asked by calling capabilities. Several things asked are several calls.",
  "- Names: write each name in the arguments in the user's own words, as it was heard, even when it looks misheard, cut short or unlike anything in the state (\"open st\" is the app \"st\", \"open this squad\" the app \"this squad\"). The app looks it up and asks the user when it is not sure. A name you do not know is never a reason to do nothing. Never write a name or an address the user did not say.",
  "- When you are not sure what the user meant — a name that may be misheard, two things it could be — ask them with ask_user, giving the likely answers as options, then do what they answer. Asking is never wrong; doing nothing with a request is.",
  "- A sentence that goes on from the turn before (\"and Discord too\", \"what about Steam\") asks for the same again, for what it names now.",
  "- A correction of the turn before (\"no, I meant Resend\", \"take that one off\") is a request: put the last change back with undo, then do what is meant now, if anything.",
  "- Some capabilities wait for the user's click before anything happens. That is the app's doing: call them when they are what was asked.",
  "- A question about the app is answered from its state, below, or by a capability that reads.",
  "- When what was heard asks nothing of Coucou, call the capability named nothing.",
  "- When no capability does what was asked, say so in words. Never call one that does something else instead.",
  "- Never say something was done unless a capability's result says so.",
  "- When you answer in words: one or two short sentences, plain text, no lists.",
  "- Last, and above all: when the sentence says not to do something, or never to do it, nothing is done. Call the capability named nothing.",
].join("\n");

const SHORTLISTED = "Your tools are the capabilities nearest to what was said. When none of them is what was asked, call more_tools with an area to be given that area's.";

/** Told to the model of a sentence said without the wake phrase. */
const ASIDE =
  "This sentence was said without Coucou's name, a few seconds after the turn above. Take it as said to Coucou, as a request or a follow-up of the turn above, and act on it. Call the capability named nothing only when it is plainly said to someone else in the room: a remark to a person, a plan or a time that is not for Coucou.";

const AFTER_CALLS =
  "The results of your calls are above. If what was asked needs another capability, call it now. Otherwise say what happened in one short sentence, from the results alone.";

/**
 * Said when the model answered with nothing at all. Measured: that is a call
 * to a capability that does not exist ("approve_permission_request"), which
 * the model server drops, since it is not among the tools.
 */
const EMPTY = "Your last answer called a capability that does not exist here, and nothing was done. Call one of your tools — {tools} — the one nearest to what was asked, or answer in words.";

/** Once the app's capabilities ran, the model only decides what else to call: its words are not what Mochi says. */
const AFTER_RAN = "The results of your calls are above. If a call failed and can be made right with another value or another setting, make it now. If what was asked needs another capability, call it now. Otherwise tell the user, in one short sentence, what the results say was done — only that.";

/** After what was only asked for, not seen: the model only decides what else to call. */
const AFTER_RAN_DONE = "The results of your calls are above. If a call failed and can be made right with another value or another setting, make it now. If what was asked needs another capability, call it now. Otherwise reply with the one word: done.";

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
  private embedChosen: () => boolean;
  /** The capabilities being embedded since the wake phrase, waited for by the sentence after it. */
  private warming: Promise<void> | null = null;
  private local: () => LocalModel | null;
  private cloud: () => CloudModel | null;
  private publish: (tools: unknown[]) => void;
  private followUp: () => boolean;
  private words: TurnWords;
  private now: () => number;
  private trace: (line: string) => void;

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
    this.embedChosen = options.embedChosen ?? (() => true);
    this.index = new CapabilityIndex(options.embed);
    this.local = options.local;
    this.cloud = options.cloud;
    this.publish = options.publish ?? (() => {});
    this.followUp = options.followUp ?? (() => false);
    this.words = options.words;
    this.now = options.now ?? (() => Date.now());
    this.trace = options.trace ?? (() => {});
  }

  /** The model, with each question to it and its answer told to the debug log. */
  private traced(local: LocalModel | null, label = "model"): LocalModel | null {
    if (!local) return null;
    return async (system, said, tools, history, steps) => {
      const names = tools.map((tool) => (tool as { function?: { name?: string } }).function?.name ?? "?");
      this.trace(`${label} asked${steps?.length ? ` (round ${steps.length + 1})` : ""}: ${JSON.stringify(said)} · tools: ${names.join(", ") || "none"} · turns before: ${history.length}`);
      if (!steps?.length) this.trace(`${label} instructions: ${system}`);
      const started = this.now();
      const reply = await local(system, said, tools, history, steps);
      const took = `${Math.round(this.now() - started)} ms`;
      this.trace(reply ? `${label} answered in ${took}: calls ${JSON.stringify(reply.calls)} · words ${JSON.stringify(reply.text)}` : `${label} did not answer (${took})`);
      return reply;
    };
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
    const local = this.traced(this.local(), "answer reader");
    if (!local) return { is: "unclear" };
    this.trace(`answer said to "${ask.question}": ${JSON.stringify(sentence)}`);

    // A choice's options with their place among them, for an answer by place ("the last one").
    const options = ask.kind === "choice"
      ? ask.options.map((option, i, all) => ({
        value: String(i + 1),
        label: `${option.label}${option.hint ? ` (${option.hint})` : ""}, option ${i + 1} of ${all.length}${i === 0 ? ", the first" : i === all.length - 1 ? ", the last" : ""}`,
      }))
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
    this.trace(`answer read as: ${given ? JSON.stringify(given) : "unclear"}`);
    if (!given) return { is: "unclear" };
    // "No, Discord": no to this, and a request of its own, heard once this turn is over.
    const refusal = given.kind === "dropped" || (given.kind === "yes_no" && !given.yes);
    // Or a no that names another thing of the kind it was asked about: what was meant instead.
    const instead = refusal && ask.about != null && (await this.registry.named(sentence)).some((n) => n.kind === ask.about && !n.near);
    if (refusal && (call?.arguments?.also_asks === true || instead)) this.nextSaid = sentence;
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
    const turn: Running = { said: sentence, how, ran: [], started: this.now(), taken: true, wake, named: [] };
    this.trace(`── heard${wake ? "" : " without the wake phrase"}: ${JSON.stringify(sentence)}${how.sure?.length ? ` · sure ${how.sure.map((x) => x.toFixed(2)).join(" ")}` : ""}`);
    // Taken at once, with the wake phrase or without: the island shows it is working on it.
    how.taken?.();
    const before = this.memory.recent(this.now());
    turn.named = await this.registry.named(sentence);
    if (turn.named.length) this.trace(`names found: ${turn.named.map((n) => `${n.near ? "~" : ""}${n.label} (${n.kind}${n.heard ? `, heard "${n.heard}"` : ""})`).join("; ")}`);
    const ranked = await this.ranked(turn, before[before.length - 1]?.said);
    this.trace(ranked ? `ranked: ${ranked.slice(0, 8).map((r) => `${r.name} ${r.score.toFixed(3)}`).join(", ")}` : "ranked: no embedding model answered");

    const heard = await this.understand(turn, ranked);
    if (!turn.taken) {
      this.trace("ignored: not taken as said to Coucou");
      return IGNORED;
    }
    this.trace(`card: ${heard.result ? `${heard.result.outcome} ${JSON.stringify(heard.result.message)}` : "nothing shown"}${heard.worded === false ? ` · the model's words did not hold up (${heard.unworded})` : ""}${heard.rest ? " · done talking" : ""}`);
    const next = this.nextSaid;
    this.nextSaid = null;
    return next ? { ...heard, next } : heard;
  }

  private async understand(turn: Running, ranked: Ranked[] | null): Promise<Heard> {
    // No ranking, no guess: the embedding model is what finds which capabilities a sentence is about.
    if (!ranked) {
      if (!this.local()) return this.end(turn, "", this.words.noModel());
      return this.end(turn, "", this.embedChosen() ? this.words.embedSilent() : this.words.noEmbedding());
    }
    // Tier 1: the ranking names one capability, clearly. No model is asked — and not for a sentence that may be for nobody.
    const name = ranked && turn.taken ? instant(ranked, this.registry.all()) : null;
    if (ranked) this.trace(`instant: ${name ?? "none"}`);
    if (name) {
      const done = await this.instantly(name, turn);
      if (done) return this.end(turn, "");
    }

    // Tier 2: the local model.
    const local = this.traced(this.local());
    if (!local) return this.end(turn, "", this.words.noModel());
    turn.how.waiting?.();
    const came = await this.locally(local, turn, ranked);
    if (came.is === "dropped") return { result: null, taken: true, rest: false };
    if (came.is === "answered") {
      // The sentence nearly names a thing and the model did nothing with it ("open spy flight" taken for
      // nonsense): the capability that takes such a thing is called with it as heard, and the executor
      // asks the user whether it is that thing. A question, never an act on a guess.
      // So too when all it called came to nothing ("open st" as a web address): those calls are replaced by the question.
      const failed = shownOf(turn).every((ran) => ran.result.status === "failed" || ran.result.status === "not_found" || ran.result.status === "refused");
      const near = turn.taken && failed && !turn.ran.some((ran) => ran.call.name === NOTHING) ? misheard(ranked, this.registry.all(), turn.named) : null;
      if (near) {
        const before = turn.ran;
        turn.ran = turn.ran.filter((ran) => !shownOf(turn).includes(ran));
        if (await this.instantly(near.name, turn, near.heard)) return this.end(turn, "");
        turn.ran = before;
      }
      return this.end(turn, await this.checked(turn, came.words));
    }
    // What may have been said to someone else never goes further than this computer.
    if (!turn.wake) return this.end(turn, "", came.is === "escalated" ? this.words.beyond() : this.words.silent());

    // Tier 3: handed up, or the local model did not answer — when the user allowed a cloud model.
    const cloud = this.cloud();
    if (!cloud) return this.end(turn, "", came.is === "escalated" ? this.words.beyond() : this.words.silent());
    turn.how.waiting?.(this.words.askingCloud(), CLOUD_BUDGET_MS);
    this.trace(`cloud asked (${came.is})`);
    const words = await this.cloudly(cloud, turn);
    this.trace(words == null ? "cloud did not answer" : `cloud answered: ${JSON.stringify(words)}`);
    if (gone(turn)) return { result: null, taken: true, rest: false };
    return this.end(turn, await this.checked(turn, words ?? ""), words == null && !shownOf(turn).length ? this.words.silent() : undefined);
  }

  // ── The ranking ─────────────────────────────────────────────────────────────

  /** What the index is given: each capability's text, and the key that says it changed. */
  private indexInput(): { capabilities: { name: string; text: string; kinds: string[] }[]; key: string } {
    const capabilities = this.registry.all().map((c) => ({ name: c.name, text: indexText(c), kinds: kindsOf(c) }));
    return { capabilities, key: capabilities.map((c) => `${c.name}\n${c.text}`).join("\n\n") };
  }

  /**
   * "OK Coucou" was heard: the embedding model is got ready while the
   * sentence is said — the capabilities embedded when they changed, else one
   * word, so that a server that let the model go has it back in memory. A
   * failure here is not held against it: the sentence asks again.
   */
  warm(): void {
    if (!this.embedChosen() || this.warming) return;
    const { capabilities, key } = this.indexInput();
    const work: Promise<unknown> = key === this.indexed
      ? this.embed(["ok"])
      : this.index.sync(capabilities).then((ok) => {
        if (ok) this.indexed = key;
      });
    this.warming = work.then(() => {}, () => {}).finally(() => {
      this.warming = null;
    });
  }

  /** The capabilities by how near the sentence is to each; null with no embedding model, or one that did not answer. */
  private async ranked(turn: Running, previous?: string): Promise<Ranked[] | null> {
    const sentence = turn.said;
    if (this.warming) await this.warming;
    const { capabilities, key } = this.indexInput();
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

  /** The call as it is run: its names put back as heard (`asHeard`). */
  private heardCall(call: ModelCall, turn: Running): Promise<ModelCall> {
    return asHeard(call, this.registry.get(call.name), turn, (text) => this.registry.named(text));
  }

  private async run(call: ModelCall, origin: RunContext["origin"], turn: Running): Promise<ToolResult> {
    const given = await this.heardCall(call, turn);
    const result = await this.registry.execute(given, this.context(origin, turn));
    turn.ran.push({ call: given, result, capability: this.registry.get(call.name) });
    this.traceRan(origin, given, result);
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
  private async instantly(name: string, turn: Running, said = turn.said): Promise<boolean> {
    const capability = this.registry.get(name);
    if (!capability) return false;
    const named = Object.entries(capability.args).filter(([, spec]) => !spec.optional);
    // Two things to name in one sentence: which is which is a model's to read.
    if (named.length > 1) return false;
    const args = Object.fromEntries(named.map(([arg]) => [arg, said]));
    const result = await this.registry.execute({ name, arguments: args }, this.context("instant", turn));
    if (result.status === "not_found" || result.status === "refused") return this.local() == null && this.record(turn, name, args, result);
    return this.record(turn, name, args, result);
  }

  private record(turn: Running, name: string, args: Record<string, unknown>, result: ToolResult): true {
    turn.ran.push({ call: { name, arguments: args }, result, capability: this.registry.get(name) });
    this.traceRan("instant", { name, arguments: args }, result);
    return true;
  }

  private traceRan(origin: string, call: ModelCall, result: ToolResult) {
    this.trace(`ran (${origin}): ${call.name} ${JSON.stringify(call.arguments ?? {})} → ${result.status}${result.status === "done" ? (result.verified ? ", seen" : ", not seen") : ""} · ${JSON.stringify(result.line)}${result.detail && result.detail !== result.line ? ` · ${JSON.stringify(result.detail)}` : ""}${result.data !== undefined ? ` · data ${JSON.stringify(result.data)}` : ""}`);
  }

  // ── Tier 2 ──────────────────────────────────────────────────────────────────

  private async locally(
    local: LocalModel,
    turn: Running,
    ranked: Ranked[],
  ): Promise<{ is: "answered"; words: string } | { is: "escalated" } | { is: "silent" } | { is: "dropped" }> {
    const { how, said } = turn;
    const capabilities = this.registry.all();
    const declared = new Set(capabilities.map((c) => c.name));
    // Handing up is offered only when there is somebody to hand up to.
    const offered = (names: readonly string[]) => names.filter((n) => declared.has(n) && (n !== ESCALATE || (turn.wake && this.cloud() != null)));
    const history: ModelTurn[] = this.memory.recent(this.now()).map(({ said: s, calls, result }) => ({ said: s, calls, result }));
    // A follow-up ("and Discord too") goes on with what the turn before called, whatever it ranks alone.
    const carried = (history[history.length - 1]?.calls ?? []).map((call) => call.name);
    // Asking the user is always offered: a name the model is not sure of is asked about, not guessed or dropped.
    const shown = new Set(offered([...shortlist(ranked, capabilities, SHORTLIST, [...carried, ...takers(ranked, capabilities, turn.named)]), UNDO, ASK_USER]));
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

    const system = [systemPrompt(snapshot, SHORTLISTED), namedLine(turn.named), turn.wake ? "" : ASIDE].filter(Boolean).join("\n\n");

    let reply = await local(system, said, tools(), history);
    if (gone(turn)) return { is: "dropped" };
    // An empty answer — no call, no words — is a small model's call that did not come out: asked once more.
    if (reply && !reply.calls.length && !reply.text.trim()) {
      const offered = tools().map((tool) => (tool as { function: { name: string } }).function.name);
      reply = await local(`${system}\n\n${EMPTY.replace("{tools}", offered.join(", "))}`, said, tools(), history);
      if (gone(turn)) return { is: "dropped" };
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
      // What it already called it has nothing more to ask of: nothing is done twice for one sentence —
      // compared as run, so that "Stripe" after a no to "Did you mean Stripe?" is not asked again.
      const fresh: ModelCall[] = [];
      for (const call of calls) {
        const given = await this.heardCall(call, turn);
        // Except what is done again on purpose ("skip twice"): a free action that worked may run again, a few times at most.
        const before = turn.ran.filter((ran) => same(ran.call, given));
        const times = before.length + fresh.filter((other) => same(other, given)).length;
        const again = times < MOST_REPEATS && before.every((ran) => ran.result.status === "done")
          && this.registry.get(given.name)?.tier === "free" && ![NOTHING, ASK_USER, UNDO].includes(given.name);
        if (times === 0 || again) fresh.push(given);
        if (fresh.length >= MOST_CALLS) break;
      }
      if (!fresh.length) break;

      const step: ModelStep = { calls: [], results: [] };
      for (const call of fresh) {
        const result = await this.run(call, "local", turn);
        if (gone(turn)) return { is: "dropped" };
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
      // What was only asked for is said in its own line whatever the words (`unfounded`): none are asked for.
      const after = !shownOf(turn).length ? AFTER_CALLS : shownOf(turn).every((ran) => ran.result.verified) ? AFTER_RAN : AFTER_RAN_DONE;
      const next = await within(local(`${system}\n\n${after}`, said, tools(), history, steps), acted(turn) ? Math.min(left, WORDING_MS) : left);
      if (gone(turn)) return { is: "dropped" };
      if (!next) break;
      reply = next;
    }
    // What only read is said from what was read, and from nothing else.
    if (shownOf(turn).length && !acted(turn) && shownOf(turn).every((ran) => ran.result.status === "done")) {
      words = (await this.report(this.traced(this.local(), "reporter") ?? local, turn)) ?? "";
      if (gone(turn)) return { is: "dropped" };
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

  // ── Checking the words ──────────────────────────────────────────────────────

  /**
   * The model's words for what ran, when they hold up against the results;
   * "" when they do not, and the capabilities' own lines are said instead.
   * Words with nothing run are an answer about the app's state, and pass.
   */
  private async checked(turn: Running, words: string): Promise<string> {
    const shown = shownOf(turn);
    const text = words.trim();
    if (!shown.length || !text || shown.some((ran) => ran.result.status !== "done")) return text;
    const why = await unfounded(text, shown, (said) => this.registry.named(said));
    turn.worded = why == null;
    turn.unworded = why ?? undefined;
    return why == null ? text : "";
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
    // `words` were checked against the results (`checked`): "" when they did not hold up.
    const message = spoken(words, linesOf(doing.length ? doing : shown));
    const heard = finish(message ? { outcome: "success", message } : null);
    return turn.worded == null ? heard : { ...heard, worded: turn.worded && words.trim() !== "", ...(turn.unworded ? { unworded: turn.unworded } : {}) };
  }
}

// ── Small things ──────────────────────────────────────────────────────────────

/**
 * What the app found the sentence names, for the model: a name it knows
 * nothing of ("spy flight") is said to be perhaps an app the app has. It is
 * still passed on as heard; the executor asks before acting on a near one.
 */
function namedLine(named: Running["named"], calling = true): string {
  if (!named.length) return "";
  const whole = named.filter((n) => !n.near).map((n) => `${n.label} (${n.kind})`);
  const near = named.filter((n) => n.near).map((n) => `${n.heard ? `"${n.heard}" is ` : ""}most likely ${n.label} (${n.kind}), misheard`);
  return [
    whole.length ? `In what was said, the app finds: ${whole.join("; ")}.` : "",
    near.length ? `In what was said, ${near.join("; ")}${calling ? ": call with that name, and the app asks the user before it acts on it; or ask them yourself with ask_user" : ""}.` : "",
  ].filter(Boolean).join(" ");
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

/**
 * The call with every name the model wrote for a thing the sentence only
 * nearly holds put back as the user said it: told "perhaps Stripe" of
 * "remove strife", a model writes "Stripe", and the executor would act on
 * it without the question an unsure name takes. What it is near is known
 * for a listed kind (the words it was heard as); for a kind ranked by its
 * source (the apps), the sentence itself is what is looked up, as tier 1
 * does. A name the sentence holds whole is left as written; one it does not
 * hold and that is nothing of its kind ("VS Code", a pill, written for the
 * app in "launch visual studio code"), where the sentence names one thing of
 * that kind and the capability takes one argument of it, is that thing.
 */
export async function asHeard(
  call: ModelCall,
  capability: Capability | undefined,
  turn: Pick<Running, "said" | "named">,
  /** What a text names, as Registry.named: to tell a name that is nothing of its kind. */
  namedIn?: (text: string) => Promise<readonly { kind: string }[]>,
): Promise<ModelCall> {
  if (!capability || !turn.named.length) return call;
  const args = { ...(call.arguments ?? {}) };
  const sentence = ` ${normalise(turn.said)} `;
  const specs = Object.entries(capability.args);
  const back = async (kind: string, value: unknown): Promise<unknown> => {
    if (typeof value !== "string") return value;
    const said = normalise(value);
    const ofKind = turn.named.filter((n) => n.kind === kind);
    const near = ofKind.find((n) => n.near && (n.id === value || normalise(n.label) === said));
    if (near && !ofKind.some((n) => !n.near && n.id === near.id)) return near.heard ?? turn.said;
    // A name the sentence does not hold and that is nothing of its kind, for the one argument of that kind,
    // where the sentence names one thing of it: that thing.
    const alone = specs.filter(([, spec]) => (spec.type === "entity" || spec.type === "entities") && spec.kind === kind).length === 1;
    if (!alone || !said || sentence.includes(` ${said} `) || ofKind.length !== 1 || value === ofKind[0].id) return value;
    if (!namedIn || (await namedIn(value).catch(() => [{ kind }])).some((n) => n.kind === kind)) return value;
    return ofKind[0].near ? (ofKind[0].heard ?? turn.said) : ofKind[0].id;
  };
  for (const [arg, spec] of specs) {
    if (!(arg in args)) continue;
    if (spec.type === "entity") args[arg] = await back(spec.kind, args[arg]);
    else if (spec.type === "entities") {
      args[arg] = Array.isArray(args[arg]) ? await Promise.all((args[arg] as unknown[]).map((v) => back(spec.kind, v))) : await back(spec.kind, args[arg]);
    }
  }
  return { ...call, arguments: args };
}

/**
 * The capability to ask about a thing the sentence only nearly names, and
 * the words it was heard as: one that takes that kind of thing and nothing
 * else it would need a model for, and that no click guards. Ranked, the best
 * of them; without a ranking, only when one alone takes that kind.
 */
export function misheard(ranked: readonly Ranked[] | null, capabilities: readonly Capability[], named: Running["named"]): { name: string; heard: string | undefined } | null {
  for (const thing of named.filter((n) => n.near)) {
    const fit = capabilities.filter((c) => {
      const required = Object.values(c.args).filter((spec) => !spec.optional);
      const only = required.length === 1 ? required[0] : null;
      return only != null && (only.type === "entity" || only.type === "entities") && only.kind === thing.kind && typeof c.tier === "string" && c.tier !== "confirm";
    });
    const best = ranked ? ranked.find((r) => fit.some((c) => c.name === r.name))?.name : fit.length === 1 ? fit[0].name : undefined;
    if (best) return { name: best, heard: thing.heard };
  }
  return null;
}

/** The kinds of thing a capability takes as an argument. */
export const kindsOf = (capability: Capability): string[] =>
  Object.values(capability.args).flatMap((spec) => (spec.type === "entity" || spec.type === "entities" ? [spec.kind] : []));

/**
 * Nobody waits for this turn any more: the island moved on. Only once it was
 * taken as said to Coucou — before that, a sentence said without the wake
 * phrase has no view waiting on it at all, and dropping it there lost every
 * follow-up ("next track" a few seconds after a command did nothing).
 */
const gone = (turn: Pick<Running, "taken" | "how">) => turn.taken && turn.how.wanted != null && !turn.how.wanted();

/** What ran that is the app's doing: not the capabilities that are about the conversation. */
const shownOf = (turn: Running) => turn.ran.filter((ran) => ![MORE_TOOLS, NOTHING, ESCALATE].includes(ran.call.name));

/** Something was changed or shown, not only read. */
const acted = (turn: Running) =>
  shownOf(turn).some((ran) => ran.result.status === "done" && ran.capability != null && ran.capability.tier !== "read");

/**
 * Whether words for what ran name only what the results hold. Three checks,
 * all computed — no word is looked for:
 *
 *   seen     every result was seen to work: what was only asked for ("Asked
 *            Windows to open Spotify"), or left unchanged when the click did
 *            not come, is said in its own line, whatever the words
 *   things   each thing of the app the words name (Registry.named, said
 *            whole) is in the results: an argument, a line, what was read
 *   numbers  each number in the words is in the results
 *
 * Not checked: which action the words say, when they name nothing the app
 * has ("Coucou is paused" after pause_music). Tried with the embedding
 * model — one that ran among the three capabilities nearest the words —
 * and measured: 27 rejections in 114 worded turns, every one of them true
 * ("Spotify has been opened" is nearest to opening a conversation). Gone.
 *
 * Measured with scripts/voice-eval.mjs (the "worded" column).
 */
export async function grounded(...args: Parameters<typeof unfounded>): Promise<boolean> {
  return (await unfounded(...args)) == null;
}

/** Why words for what ran do not hold up — "unseen", "thing", "number" — or null when they do (`grounded`). `named`: Registry.named. */
export async function unfounded(
  words: string,
  ran: readonly { call: ModelCall; result: ToolResult; capability?: Capability }[],
  named: (said: string) => Promise<readonly { kind: string; id: string; label: string; near?: boolean }[]>,
): Promise<"unseen" | "thing" | "number" | null> {
  if (ran.some(({ result }) => !result.verified)) return "unseen";
  const facts = ` ${values(ran.map(({ call, result }) => [call.arguments ?? {}, result.line, result.detail ?? "", result.data ?? null])).map(normalise).join(" ")} `;
  const holds = (text: string) => {
    const form = normalise(text);
    return form !== "" && facts.includes(` ${form} `);
  };
  const things = (await named(words).catch(() => [])).filter((thing) => !thing.near);
  if (things.some((thing) => !holds(thing.label) && !holds(thing.id))) return "thing";
  // Numbers said as numbers, not the digits of a name ("n8n").
  const numbers = normalise(words).split(" ").filter((word) => /^\d+$/.test(word));
  return numbers.some((number) => !holds(number)) ? "number" : null;
}

/** Every string and number a value holds, however deep. */
function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(values);
  if (value && typeof value === "object") return Object.values(value).flatMap(values);
  return [];
}

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
            description: "The option the user chose. 'none' when they turn every option down or want the question dropped. 'unclear' when what they said is not an answer to this question at all: a question or a request of its own.",
          },
          also_asks: { type: "boolean", description: "True when, besides answering, they ask for something else to be done or name something else instead (a no followed by another name)." },
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
