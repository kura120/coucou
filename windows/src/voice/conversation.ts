// One sentence in, what Mochi makes of it out: the parser first, then what the
// last turns make of a follow-up, then a model when one is chosen — and, when
// a name is not surely what it was taken for, a question rather than a guess
// or a refusal (voice/resolve.ts). It holds the short memory of the turns
// (voice/memory.ts) and nothing of the island: the tests run it against
// fakes, and scripts/voice-eval.mjs against a model.
//
// Voice never approves a permission and never sends anything: nothing here
// can, whatever was said before.

import type { PillDefinition } from "../core/pills";
import { t } from "../i18n/i18n";
import { answerOf, intentQuestion, pillsOf, renamed } from "./ask";
import { matchPill, normalise, noting, type PillMatch } from "./entity";
import { heardToOpen, parseIntent, parseSeveral, type VoiceIntent } from "./intent";
import {
  VoiceMemory, aboutPermission, actionOf, recordOf, resolveRelative, withPronoun, type VoiceAction, type VoiceTurn,
} from "./memory";
import { certain, provideNames, resolveName, type NameSources } from "./resolve";
import type { Answer } from "./result";
import type { Asked, VoiceResult, VoiceRunner } from "./runner";
import {
  describeState, misheardApps, notAnApp, notFound, opened, openedName, runProposal, systemPrompt, toolSchemas, understood,
  type BrainCall, type VoiceWorld,
} from "./tools";

/** An earlier turn, as a model is given it: the sentence, what was done, what came of it. */
export type BrainTurn = Pick<VoiceTurn, "said" | "calls" | "result">;

/** Asks the model server; null when it cannot be asked or does not answer. */
export type Brain = (
  system: string,
  said: string,
  tools: unknown[],
  history: BrainTurn[],
) => Promise<{ calls: BrainCall[]; text: string } | null | undefined>;

export interface Hearing {
  /**
   * False for a sentence said without the wake phrase, to nobody in
   * particular: a bare name is then no follow-up, Mochi asks nothing back, and
   * what he does not understand is nothing at all.
   */
  spokenTo?: boolean;
  /** Called when the answer has to be waited for: a lookup, a model. */
  waiting?: () => void;
  /** Asked before anything is done after a wait: false when nobody waits for it any more. */
  wanted?: () => boolean;
}

/** Mochi asks about a name at most this many times in a row. */
const MOST_ROUNDS = 2;

/**
 * Words that make a sentence ending in an app's name something other than a
 * misheard "open …": a question about it, or another thing to do with it.
 */
const NOT_OPENING = new Set([
  "what", "whats", "is", "are", "was", "does", "do", "did", "how", "why", "when", "where", "who", "which", "can", "could", "should",
  "would", "not", "no", "dont", "never", "close", "quit", "exit", "kill", "stop", "pause", "mute", "hide", "remove", "delete",
  "uninstall", "update", "about", "like", "hate", "love", "and", "or", "on", "play", "playing", "add", "show",
]);

export class VoiceConversation {
  readonly memory = new VoiceMemory();

  private runner: VoiceRunner;
  private world: VoiceWorld;
  private pills: () => readonly PillDefinition[];
  private brain: () => Brain | null;
  private now: () => number;
  private names: NameSources;

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
    // Where the resolver finds what can be named (voice/resolve.ts).
    this.names = { apps: (said) => world.appsNear(said), pills, sessions: () => world.agents() };
    provideNames(this.names);
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
    provideNames(this.names);
    const spokenTo = how.spokenTo ?? true;
    const pills = this.pills();

    // The answer to a question Mochi asked.
    const asked = this.runner.takeAsked();
    if (asked) return this.answered(asked, said, how);
    if (this.runner.asking) return this.runner.answer(said);

    // What the parser makes of it, and how each pill in it was named.
    const parsed = noting(() => ({ intent: parseIntent(said, pills), several: parseSeveral(said, pills) }));
    const { intent, several } = parsed.value;
    if (intent.kind === "cancel") return null;
    // "pause and remove github": each part is done, the last one is shown.
    // Looked for first, or its first word alone would be taken for the whole.
    const known = intent.kind !== "unknown" || several != null;
    // "put it back" before the parser, which hears "back"; any other follow-up
    // only when the sentence is no command of its own.
    const last = this.last();
    const relative = noting(() => resolveRelative(said, last, pills, spokenTo));
    const follows = relative.value && (relative.value.undo || !known) ? relative.value : null;
    let intents = follows ? [follows.intent, ...(follows.also ? [follows.also] : [])] : known ? (several ?? [intent]) : null;
    let matches = follows ? relative.matches : parsed.matches;
    // "take that one off": the pill the last command was about, by a pronoun.
    const meant = intents ? null : withPronoun(said, last, pills);
    if (meant) {
      const again = noting(() => parseIntent(meant, pills));
      if (pillsOf(again.value).length) {
        intents = [again.value];
        matches = again.matches;
      }
    }
    if (intents) {
      // A pill that was only nearly named is asked about, not acted on.
      const unsure = this.unsure(intents, matches, said);
      if (unsure) return spokenTo ? unsure() : null;
      const done = await this.run(intents, said, how, follows ? follows.led : true, follows != null && !spokenTo);
      if (done !== undefined) return done;
    } else if (spokenTo) {
      // "up in spotify": the verb was misheard, the app was not.
      const verbless = await this.verbless(said, how);
      if (verbless) return verbless;
    }
    return this.ask(said, how, meant);
  }

  /**
   * The answer to the question that waits, given by a click or a shortcut
   * (the island's ask component) rather than said. Null when nothing waits.
   */
  async answer(answer: Answer, how: Hearing = {}): Promise<VoiceResult | null> {
    provideNames(this.names);
    const asked = this.runner.takeAsked();
    return asked ? this.settle(asked, answer, how) : null;
  }

  /**
   * The question to ask when a pill of these intents was only nearly named
   * ("remove strife" → "Remove Stripe?"), or null when each was named surely.
   * Returned as a function: asking changes what the runner waits for.
   */
  private unsure(intents: readonly VoiceIntent[], matches: readonly PillMatch[], said: string): (() => VoiceResult) | null {
    const pills = this.pills();
    const named = [...new Set(intents.flatMap(pillsOf))];
    const doubtful = named.filter((id) => {
      const ways = matches.filter((match) => match.id === id);
      return ways.length > 0 && !ways.some(certain);
    });
    const about = intents.find((intent) => pillsOf(intent).some((id) => doubtful.includes(id)));
    const question = about ? intentQuestion(about, pills) : null;
    if (!about || !question) return null;
    const label = (id: string) => pills.find((p) => p.id === id)?.name ?? id;
    // One pill in doubt: another name said instead takes its place. Several: yes or no.
    const one = doubtful.length === 1 ? doubtful[0] : null;
    const candidates = one ? [{ id: one, label: label(one) }] : [{ id: "", label: doubtful.map(label).join(", ") }];
    const then = (id: string) => (one && id && id !== one ? intents.map((intent) => renamed(intent, one, id)) : [...intents]);
    return () => this.runner.ask({ ask: { kind: "yes_no", question }, candidates, then, said, rounds: 1 });
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
      // The name is looked up among what is installed, which takes a moment.
      how.waiting?.();
      const app = await resolveName("app", intent.name);
      // Surely an app, or one of the user's folders: opened. An app the speech
      // model was not sure it heard is asked about below.
      const name = app.is === "unsure" ? null : await openedName(app.is === "sure" ? app.label : intent.name, this.world);
      if (name) {
        const record = recordOf(intent, pills, null, name);
        calls.push(...record.calls);
        action = record.action;
        results.push(opened(name));
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
      // No app by that name: the nearest is asked about, at once. Looked for
      // in all that followed "open": "the squad", where the name is "squad".
      const near = app.is === "unsure" ? app : await resolveName("app", heardToOpen(said) || intent.name);
      if (near.is === "unsure") return this.runner.askOpen(near.candidates.map((c) => c.label), said);
      if (brain) return undefined;
      if (silent) return null;
      return this.remembered(said, [], notFound(intent.name), null);
    }
    const shown = results.find((r) => r.outcome !== "success") ?? results[results.length - 1];
    return this.remembered(said, calls, shown, action);
  }

  /**
   * "Up in Spotify", "fine Figma": a word or two the parser does not know,
   * then an installed app's name as it is written. The verb was misheard:
   * Mochi asks "Open Spotify?" before any model is asked, and opens nothing
   * without the yes. Null when the sentence is not that.
   */
  private async verbless(said: string, how: Hearing): Promise<VoiceResult | null> {
    const words = normalise(said).split(" ").filter(Boolean);
    if (words.length < 2 || words.length > 4 || aboutPermission(said) || words.some((w) => NOT_OPENING.has(w))) return null;
    how.waiting?.();
    const near = await this.world.appsNear(said);
    const text = ` ${words.join(" ")}`;
    const app = near.names.find((name, i) => {
      const label = normalise(name);
      const before = words.length - label.split(" ").length;
      return (near.scores?.[i] ?? 1) >= 0.99 && text.endsWith(` ${label}`) && before >= 1 && before <= 2;
    });
    return app ? this.runner.askOpen([app], said) : null;
  }

  /** What was said in answer to a question about a name. */
  private async answered(asked: Asked, said: string, how: Hearing): Promise<VoiceResult | null> {
    const pills = this.pills();
    const answer = answerOf(said, asked.ask, asked.candidates.map((c) => c.label));
    if (answer.kind === "unclear") return asked.rounds < MOST_ROUNDS ? this.runner.ask({ ...asked, rounds: asked.rounds + 1 }) : leftAsIs();
    if (answer.kind !== "other") return this.settle(asked, answer, how);

    const intent = parseIntent(said, pills);
    if (intent.kind === "cancel") return leftAsIs();
    // Not an answer: another command, done as one.
    if ((intent.kind !== "unknown" && intent.kind !== "open") || parseSeveral(said, pills)) return this.hear(said, how);
    // Another name: that one is tried, and asked about in turn when it is not surely one — once.
    const again = asked.rounds < MOST_ROUNDS;
    if (asked.then === "app") {
      const name = intent.kind === "open" ? intent.name : answer.said;
      how.waiting?.();
      const app = await resolveName("app", name);
      if (app.is === "sure") return (await this.open(app.label, asked.said)) ?? notFound(name);
      if (app.is === "unsure" && again) return this.runner.askOpen(app.candidates.map((c) => c.label), asked.said, asked.rounds + 1);
      return notFound(name);
    }
    const one = asked.candidates.length === 1 && asked.candidates[0].id ? asked.candidates[0] : null;
    const match = one ? matchPill(answer.said, pills) : null;
    if (!one || !match) return this.runner.run({ kind: "unknown" }, said);
    const intents = asked.then(match.id);
    if (certain(match)) return (await this.run(intents, asked.said, how, true, false)) ?? null;
    const question = intentQuestion(intents.find((i) => pillsOf(i).includes(match.id)) ?? intents[0], pills);
    if (!again || !question) return this.runner.run({ kind: "unknown" }, said);
    const label = pills.find((p) => p.id === match.id)?.name ?? match.id;
    const then = (id: string) => (id && id !== match.id ? intents.map((i) => renamed(i, match.id, id)) : intents);
    return this.runner.ask({ ask: { kind: "yes_no", question }, candidates: [{ id: match.id, label }], then, said: asked.said, rounds: asked.rounds + 1 });
  }

  /** The answer, whichever way it was given: the candidate is acted on, or it is left. */
  private async settle(asked: Asked, answer: Answer, how: Hearing): Promise<VoiceResult | null> {
    const chosen =
      answer.kind === "yes_no" && answer.yes ? asked.candidates[0]
      : answer.kind === "choice" ? asked.candidates.find((c) => c.id === answer.id)
      : null;
    if (!chosen) return leftAsIs();
    if (asked.then === "app") {
      how.waiting?.();
      return (await this.open(chosen.label, asked.said)) ?? notFound(chosen.label);
    }
    return (await this.run(asked.then(chosen.id), asked.said, how, true, false)) ?? null;
  }

  /** Opens the app by that name and remembers it as what `said` led to. Null: no such app. */
  private async open(name: string, said: string): Promise<VoiceResult | null> {
    const app = await openedName(name, this.world);
    return app ? this.remembered(said, [{ name: "open_app", arguments: { name: app } }], opened(app), { kind: "open" }) : null;
  }

  /**
   * Not a sentence the parser knows: the model is asked, with the turns so
   * far, and its proposal checked. `meant`: the sentence with its "that one"
   * said as the pill it stands for, which is what the checks read.
   */
  private async ask(said: string, how: Hearing, meant: string | null = null): Promise<VoiceResult | null> {
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
    const proposal = await brain(system, said, toolSchemas(pills, hint), history);
    // Given up on meanwhile: what it proposes is done for nobody.
    if (how.wanted && !how.wanted()) return null;

    const calls: BrainCall[] = [];
    let action: VoiceAction | null = null;
    const mainBefore = this.runner.pillState().main;
    const result = await runProposal(proposal ?? { calls: [], text: "" }, said, this.runner, this.world, pills, {
      last,
      quiet,
      near,
      meant: alone ? undefined : (meant ?? undefined),
      ran: (call, intent) => {
        calls.push(call);
        action = actionOf(call, intent, pills, mainBefore) ?? action;
      },
    });
    if (!result || result.outcome === "question") return result;
    if (quiet && !understood(result, said)) return null;
    return this.remembered(said, calls, result, action);
  }

  private remembered(said: string, calls: BrainCall[], result: VoiceResult, action: VoiceAction | null): VoiceResult {
    this.memory.remember({ said, calls, result: result.message, action: result.outcome === "success" ? action : null }, this.now());
    return result;
  }
}

/** "No" to a question: nothing is done, and Mochi says so. */
const leftAsIs = (): VoiceResult => ({ outcome: "success", message: t("OK, leaving it as is") });
