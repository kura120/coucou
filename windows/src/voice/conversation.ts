// One sentence in, what Mochi makes of it out: the parser first, then what the
// last turns make of a follow-up, then a model when one is chosen — and, when
// a name that was said is no app, a question rather than a refusal. It holds
// the short memory of the turns (voice/memory.ts) and nothing of the island:
// the tests run it against fakes, and scripts/voice-eval.mjs against a model.
//
// Voice never approves a permission and never sends anything: nothing here
// can, whatever was said before.

import type { PillDefinition } from "../core/pills";
import { t } from "../i18n/i18n";
import { readAnswer } from "./ask";
import { heardToOpen, parseIntent, parseSeveral, type VoiceIntent } from "./intent";
import { VoiceMemory, aboutPermission, actionOf, recordOf, resolveRelative, type VoiceAction, type VoiceTurn } from "./memory";
import { forModel, fromVoiceResult, spoken } from "./result";
import type { VoiceResult, VoiceRunner } from "./runner";
import {
  AFTER_TOOLS, describeState, didYouMean, misheardApps, notAnApp, notFound, opened, openedName, runProposal, systemPrompt, toolSchemas, understood,
  type BrainCall, type VoiceWorld,
} from "./tools";

/** An earlier turn, as a model is given it: the sentence, what was done, what came of it. */
export type BrainTurn = Pick<VoiceTurn, "said" | "calls" | "result">;

/** One round of this turn, as a model is given it back: its calls and what each came to. */
export interface BrainStep {
  calls: BrainCall[];
  results: string[];
}

/** Asks the model server; null when it cannot be asked or does not answer. */
export type Brain = (
  system: string,
  said: string,
  tools: unknown[],
  history: BrainTurn[],
  steps?: BrainStep[],
) => Promise<{ calls: BrainCall[]; text: string } | null | undefined>;

/** A turn is at most this many rounds of the model calling tools. */
export const MOST_MODEL_ROUNDS = 5;
/** Past this, a turn that has done something says so with the tool's own line. */
export const TURN_BUDGET_MS = 8000;
/** How long the model is waited for once its tools have run: its words are a nicety. */
export const WORDING_MS = 2500;

export interface Hearing {
  /**
   * False for a sentence said without the wake phrase, to nobody in
   * particular: a bare name is then no follow-up, Mochi asks nothing back, and
   * what he does not understand is nothing at all.
   */
  spokenTo?: boolean;
  /** Called when the answer has to be waited for: a lookup, a model. `line`: what is being done, when known. */
  waiting?: (line?: string) => void;
  /** Something was done and there is more to come: the line to show meanwhile. */
  working?: (line: string) => void;
  /** Asked before anything is done after a wait: false when nobody waits for it any more. */
  wanted?: () => boolean;
}

/** Mochi asks about an app at most this many times in a row. */
const MOST_ROUNDS = 2;

export class VoiceConversation {
  readonly memory = new VoiceMemory();

  private runner: VoiceRunner;
  private world: VoiceWorld;
  private pills: () => readonly PillDefinition[];
  private brain: () => Brain | null;
  private now: () => number;

  /** `brain`: the model to ask, or null when none is chosen. */
  constructor(
    runner: VoiceRunner,
    world: VoiceWorld,
    pills: () => readonly PillDefinition[],
    brain: () => Brain | null,
    now: () => number = () => Date.now(),
  ) {
    this.runner = runner;
    this.world = world;
    this.pills = pills;
    this.brain = brain;
    this.now = now;
  }

  /** Voice was turned off, or the conversation is over: nothing is remembered. */
  forget() {
    this.memory.clear();
    this.runner.reset();
  }

  /** What was done last that a follow-up can build on. */
  last(): VoiceAction | null {
    return this.memory.last(this.now());
  }

  /**
   * Understands a sentence and does it. The result is for the card — a
   * question when Mochi asks one back — or null when there is nothing to show.
   */
  async hear(said: string, how: Hearing = {}): Promise<VoiceResult | null> {
    const spokenTo = how.spokenTo ?? true;
    const pills = this.pills();

    // The answer to a question Mochi asked.
    if (this.runner.openAsked) return this.answerOpen(said, how);
    if (this.runner.asking) return this.runner.answer(said);

    const intent = parseIntent(said, pills);
    if (intent.kind === "cancel") return null;
    // "pause and remove github": each part is done, the last one is shown.
    // Looked for first, or its first word alone would be taken for the whole.
    const several = parseSeveral(said, pills);
    const known = intent.kind !== "unknown" || several != null;
    // "put it back" before the parser, which hears "back"; any other follow-up
    // only when the sentence is no command of its own.
    const relative = resolveRelative(said, this.last(), pills, spokenTo);
    const follows = relative && (relative.undo || !known) ? relative : null;
    const intents = follows ? [follows.intent] : known ? (several ?? [intent]) : null;
    if (intents) {
      const done = await this.run(intents, said, how, follows ? follows.led : true, follows != null && !spokenTo);
      if (done !== undefined) return done;
    }
    return this.ask(said, how);
  }

  /**
   * Does what the parser understood. Undefined: the one thing asked for is
   * nothing that is installed and nothing near it — a model may know better.
   * `named`: the sentence said it was naming something to open ("open …",
   * "what about …"), which a bare name after "open Spotify" does not.
   * `silent`: a follow-up nobody said the wake phrase for — when it names
   * nothing, it was not meant for Mochi.
   */
  private async run(
    intents: readonly VoiceIntent[],
    said: string,
    how: Hearing,
    named: boolean,
    silent: boolean,
  ): Promise<VoiceResult | null | undefined> {
    const pills = this.pills();
    const results: VoiceResult[] = [];
    const calls: BrainCall[] = [];
    let action: VoiceAction | null = null;
    for (const intent of intents) {
      if (intent.kind !== "open") {
        const mainBefore = this.runner.pillState().main;
        const result = this.runner.run(intent, said);
        results.push(result);
        if (result.outcome === "question") return result;
        if (result.outcome !== "success") continue;
        const record = recordOf(intent, pills, mainBefore);
        calls.push(...record.calls);
        action = record.action ?? action;
        continue;
      }
      // The name is looked up among what is installed, started, and watched for.
      how.waiting?.(t("Opening {0}…", { 0: intent.name }));
      const name = await openedName(intent.name, this.world);
      if (name) {
        const record = recordOf(intent, pills, null, name);
        calls.push(...record.calls);
        action = record.action;
        results.push(opened(name, this.world));
        continue;
      }
      if (intents.length > 1) {
        results.push(notFound(intent.name));
        continue;
      }
      if (!named) return undefined;
      const brain = this.brain() != null;
      // A session or a web address: a model reads those, not the list of apps.
      if (brain && notAnApp(intent.name)) return undefined;
      // No app by that name: the nearest is asked about, at once.
      const asked = await didYouMean(heardToOpen(said) || intent.name, said, this.runner, this.world);
      if (asked) return asked;
      if (brain) return undefined;
      if (silent) return null;
      return this.remembered(said, [], notFound(intent.name), null);
    }
    const shown = results.find((r) => r.outcome !== "success") ?? results[results.length - 1];
    return this.remembered(said, calls, shown, action);
  }

  /** "Open Spotify?" — the answer: yes, no, one of the two, or something else. */
  private async answerOpen(said: string, how: Hearing): Promise<VoiceResult | null> {
    const asked = this.runner.takeOpenAsked();
    if (!asked) return null;
    const pills = this.pills();
    const answer = readAnswer(said, asked.names);
    const open = async (name: string): Promise<VoiceResult | null> => {
      how.waiting?.(t("Opening {0}…", { 0: name }));
      const app = await openedName(name, this.world);
      return app ? this.remembered(asked.said, [{ name: "open_app", arguments: { name: app } }], opened(app, this.world), { kind: "open" }) : null;
    };
    switch (answer.kind) {
      case "open":
        return (await open(answer.name)) ?? notFound(answer.name);
      case "no":
        return leftAsIs();
      case "unclear":
        return asked.rounds < MOST_ROUNDS ? this.runner.askOpen(asked.names, asked.said, asked.rounds + 1) : leftAsIs();
      case "other": {
        const intent = parseIntent(said, pills);
        if (intent.kind === "cancel") return leftAsIs();
        // Not an answer: another command, done as one.
        if ((intent.kind !== "unknown" && intent.kind !== "open") || parseSeveral(said, pills)) return this.hear(said, how);
        // Another name: that one is tried.
        const name = intent.kind === "open" ? intent.name : answer.said;
        const result = await open(name);
        if (result) return result;
        const again = asked.rounds < MOST_ROUNDS ? await didYouMean(name, asked.said, this.runner, this.world, asked.rounds + 1) : null;
        return again ?? notFound(name);
      }
    }
  }

  /**
   * Not a sentence the parser knows: the model is asked, with the turns so
   * far, and its proposal checked.
   */
  private async ask(said: string, how: Hearing): Promise<VoiceResult | null> {
    const quiet = !(how.spokenTo ?? true);
    const brain = this.brain();
    if (!brain) return quiet ? null : this.runner.run({ kind: "unknown" }, said);
    how.waiting?.();
    const pills = this.pills();
    // A sentence about a permission stands alone: nothing said before it is
    // carried into it, and a model given the turns before reads "no, decline
    // that" as a change of mind.
    const alone = aboutPermission(said);
    const last = alone ? null : this.last();
    const history: BrainTurn[] = alone ? [] : this.memory.recent(this.now()).map(({ said: s, calls, result }) => ({ said: s, calls, result }));
    // The apps a misheard name in it may be, so the model can ask about one.
    const near = (await this.world.appsNear(said)).names;
    const hint = misheardApps(said, near);
    const system = systemPrompt(describeState(this.world, this.runner, pills), hint);
    const tools = toolSchemas(pills, hint);
    const started = this.now();
    let proposal = await brain(system, said, tools, history);
    // Given up on meanwhile: what it proposes is done for nobody.
    if (how.wanted && !how.wanted()) return null;

    const calls: BrainCall[] = [];
    let action: VoiceAction | null = null;
    const mainBefore = this.runner.pillState().main;
    // The model calls tools, is given what came of them, and goes on from
    // there — or says what happened, in its own words.
    const steps: BrainStep[] = [];
    const shown: VoiceResult[] = [];
    let words = "";
    for (let round = 1; ; round++) {
      const step: BrainStep = { calls: [], results: [] };
      const result = await runProposal(proposal ?? { calls: [], text: "" }, said, this.runner, this.world, pills, {
        last,
        quiet,
        near,
        ran: (call, intent) => {
          calls.push(call);
          action = actionOf(call, intent, pills, mainBefore) ?? action;
        },
        each: (call, came) => {
          step.calls.push(call);
          step.results.push(JSON.stringify(came ? forModel(fromVoiceResult(came)) : { status: "done", result: "Nothing to do." }));
        },
      });
      // A question, or a card that opened: the turn waits on the user.
      if (!result || result.outcome === "question") {
        if (shown.length && !result) break;
        return result;
      }
      shown.push(result);
      // An answer and no tool, or nothing more to ask the model with.
      if (!step.calls.length || quiet) break;
      steps.push(step);
      if (round >= MOST_MODEL_ROUNDS || this.now() - started >= TURN_BUDGET_MS) break;
      how.working?.(result.message);
      const next = await within(brain(`${system}\n${AFTER_TOOLS}`, said, tools, history, steps), WORDING_MS);
      if (how.wanted && !how.wanted()) return null;
      if (!next) break;
      // A model that calls again what it just called has nothing more to do:
      // nothing is done twice for one sentence.
      const fresh = next.calls.filter((call) => !steps.some((s) => s.calls.some((made) => sameCall(made, call))));
      if (fresh.length) {
        proposal = { calls: fresh, text: "" };
        continue;
      }
      if (next.calls.length) break;
      words = next.text;
      break;
    }
    if (!shown.length) return null;
    // What went wrong is what is shown; else the last thing done.
    const last_ = shown.find((r) => r.outcome === "failure") ?? shown[shown.length - 1];
    if (quiet && !understood(last_, said)) return null;
    // Mochi's words are the model's when its tools ran and it said something —
    // but only for what worked. A model told a call was refused has still said
    // "Spotify is now playing": what did not happen is said in the tool's own words.
    const result = steps.length && last_.outcome === "success" ? { ...last_, message: spoken(words, last_.message) } : last_;
    return this.remembered(said, calls, result, action);
  }

  private remembered(said: string, calls: BrainCall[], result: VoiceResult, action: VoiceAction | null): VoiceResult {
    this.memory.remember({ said, calls, result: result.message, action: result.outcome === "success" ? action : null }, this.now());
    return result;
  }
}

const sameCall = (a: BrainCall, b: BrainCall) => a.name === b.name && JSON.stringify(a.arguments ?? {}) === JSON.stringify(b.arguments ?? {});

/** What a promise comes to, or null when it has not by then. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
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

/** "No" to a question: nothing is done, and Mochi says so. */
const leftAsIs = (): VoiceResult => ({ outcome: "success", message: t("OK, leaving it as is") });
