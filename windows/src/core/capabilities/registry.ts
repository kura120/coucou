// The registry and its executor (doc/voice-brain.md, section 3.1). The app
// declares its capabilities here; a model names one and writes arguments; and
// `execute` is the only way anything runs:
//
//   look up → arguments → can it be used now → which things are named →
//   tier (confirm: a click) → run → remember how to put it back
//
// The guard is this file's own. It is handed over when the registry is made
// and kept in a closure: no capability is given it, no schema names it, and
// nothing a model writes can reach or loosen it.
//
// No wording lives here: every line a person reads comes from `Words`, given
// by whoever makes the registry, or from the capability itself.

import { done, failed, notFoundResult, refused } from "../../voice/result";
import { sureOf, UNSURE_WORD } from "../../voice/resolve";
import { among, contained, type Resolved } from "./match";
import { schemaOf } from "./schema";
import type { Answer, ArgSpec, Args, Ask, Call, Capability, Entity, EntitySource, GuardHost, Registry, RunContext, ScreenContext, Tier, ToolResult } from "./types";
import { check } from "./validate";

/** The lines the executor shows, worded and translated by its maker. */
export interface Words {
  /** A call that is not run: "I can't do that." The rule is in the result's `detail`. */
  refused(): string;
  /** A capability that cannot be used now: "That isn't possible right now." */
  unavailable(): string;
  /** A capability that broke: "That didn't work." */
  failed(): string;
  /** Nothing by that name: "I can't find {0}." */
  notFound(said: string): string;
  /** The user did not confirm, or said no to a name: "Nothing was changed." */
  unchanged(): string;
  /** `undo` with nothing remembered: "There is nothing to put back." */
  nothingToUndo(): string;
  /** A name it is not sure of, when the capability has no question of its own: "Did you mean {0}?" */
  one(label: string): string;
  /** Two or three as near as each other: "{0} or {1}?", "{0}, {1} or {2}?" */
  which(labels: readonly string[]): string;
}

export interface RegistryOptions {
  /** What shows a confirmation and waits for the click. Kept here, given to nobody. */
  guard: GuardHost;
  words: Words;
  /**
   * Whether the speech model was unsure of these words. By default, what
   * voice/resolve.ts was told of the last sentence (`heardWith`).
   */
  doubted?(said: string): boolean;
}

/** What `snapshot` may weigh, in characters of JSON: it is read by a model at every turn. */
export const SNAPSHOT_MOST = 6000;
/** One read's share of it; a longer one is cut, and marked as cut. */
const READ_MOST = 800;
/** The names listed for one kind of thing, and the length of its line. */
const NAMES_MOST = 12;
const LINE_MOST = 400;
const SUBJECTS_MOST = 8;

const NAME = /^[a-z][a-z0-9_]*$/;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
const tierOf = (capability: Capability, args: Args): Tier => (typeof capability.tier === "function" ? capability.tier(args) : capability.tier);
const required = (capability: Capability) => Object.values(capability.args).some((spec) => !spec.optional);

export function createRegistry(options: RegistryOptions): Registry {
  const { guard, words } = options;
  const doubted = options.doubted ?? ((said: string) => (sureOf(said) ?? 1) < UNSURE_WORD);
  const capabilities = new Map<string, Capability>();
  const sources = new Map<string, EntitySource>();
  let onScreen: () => ScreenContext | null = () => null;
  /** How to put the last reversible thing back. */
  let last: Call | null = null;

  function declare(...added: Capability[]) {
    for (const capability of added) {
      if (!NAME.test(capability.name)) throw new Error(`A capability's name is snake_case: "${capability.name}".`);
      if (capabilities.has(capability.name) || added.filter((other) => other.name === capability.name).length > 1) {
        throw new Error(`The capability "${capability.name}" is declared twice.`);
      }
      // Declared wrong is found when the app starts, not when someone speaks.
      if (capability.tier === "confirm" && !capability.describe) throw new Error(`"${capability.name}" is confirmed by a click and has no describe().`);
      if (capability.tier === "reversible" && !capability.inverse) throw new Error(`"${capability.name}" is reversible and has no inverse().`);
      if (capability.inSnapshot && (capability.tier !== "read" || required(capability))) {
        throw new Error(`"${capability.name}" is in the snapshot: it must be a read that needs no argument.`);
      }
    }
    for (const capability of added) capabilities.set(capability.name, capability);
  }

  function entities(source: EntitySource) {
    if (sources.has(source.kind)) throw new Error(`The entity kind "${source.kind}" is declared twice.`);
    sources.set(source.kind, source);
  }

  function areas() {
    const by = new Map<string, string[]>();
    for (const capability of capabilities.values()) by.set(capability.area, [...(by.get(capability.area) ?? []), capability.name]);
    return [...by].map(([area, names]) => ({ area, names }));
  }

  // ── Which thing a name is ───────────────────────────────────────────────────

  /** What one name is among a kind's things, and the things it was looked for in. */
  async function resolve(source: EntitySource, said: string): Promise<{ found: Resolved; things: readonly Entity[] }> {
    const listed = await source.list();
    const byId = listed.find((thing) => thing.id === said);
    if (byId) return { found: { is: "sure", id: byId.id, label: byId.label }, things: listed };
    if (!source.near) return { found: among(said, listed, { doubted }), things: listed };
    // Too many to list: the source ranks them, and the same judgement is made of its ranking.
    const near = await source.near(said);
    return { found: among(said, near, { doubted, scores: new Map(near.map((thing) => [thing.id, thing.score])) }), things: near };
  }

  /**
   * One named thing as its id — asking when unsure — or the result that ends
   * the call: nothing by that name, or the user said no.
   */
  async function identify(capability: Capability, arg: string, kind: string, said: string, context: RunContext): Promise<{ id: string } | ToolResult> {
    const source = sources.get(kind);
    if (!source) return failed(words.failed(), `No source lists the things of kind "${kind}".`);
    const { found } = await resolve(source, said);
    if (found.is === "sure") return { id: found.id };
    if (found.is === "none") return { ...notFoundResult(words.notFound(said), found.near), detail: `No ${kind} is named "${said}".` };

    const [first, ...others] = found.candidates;
    const ask: Ask = others.length
      ? { kind: "choice", question: words.which(found.candidates.map((c) => c.label)), options: found.candidates.map(({ id, label, hint }) => ({ id, label, ...(hint ? { hint } : {}) })) }
      : { kind: "yes_no", question: capability.question?.(first.label, arg) ?? words.one(first.label) };
    const answer: Answer = await context.ask(ask);
    if (answer.kind === "yes_no" && answer.yes && !others.length) return { id: first.id };
    const chosen = answer.kind === "choice" && others.length ? found.candidates.find((c) => c.id === answer.id) : undefined;
    if (chosen) return { id: chosen.id };
    const names = found.candidates.map((c) => c.label).join(", ");
    return { ...done(words.unchanged(), false), detail: `Nothing was done: "${said}" was not surely a ${kind}, and the user did not pick ${names}.` };
  }

  /** The arguments with every named thing replaced by its id, or the result that ends the call. */
  async function named(capability: Capability, args: Args, context: RunContext): Promise<{ args: Args } | { ended: ToolResult }> {
    const out: Args = { ...args };
    for (const [arg, spec] of Object.entries(capability.args) as [string, ArgSpec][]) {
      if (out[arg] === undefined) continue;
      if (spec.type === "entity") {
        const one = await identify(capability, arg, spec.kind, out[arg] as string, context);
        if (!("id" in one)) return { ended: one };
        out[arg] = one.id;
      } else if (spec.type === "entities") {
        const ids: string[] = [];
        for (const said of out[arg] as string[]) {
          const several = await severalIn(spec.kind, said);
          if (several) {
            ids.push(...several);
            continue;
          }
          const one = await identify(capability, arg, spec.kind, said, context);
          if (!("id" in one)) return { ended: one };
          ids.push(one.id);
        }
        const unique = [...new Set(ids)];
        if (spec.max !== undefined && unique.length > spec.max) return { ended: refused(words.refused(), `"${arg}" takes at most ${spec.max}.`) };
        out[arg] = unique;
      }
    }
    return { args: out };
  }

  /** Several things of a kind named in one string ("github and stripe"): each said whole. Null when it names one or none. */
  async function severalIn(kind: string, said: string): Promise<string[] | null> {
    const source = sources.get(kind);
    if (!source || source.near) return null;
    const listed = await source.list();
    if (listed.some((thing) => thing.id === said)) return null;
    const inside = contained(said, listed);
    return inside.length > 1 ? inside.map((thing) => thing.id) : null;
  }

  // ── The executor ────────────────────────────────────────────────────────────

  async function guarded(call: Call, given: RunContext, undoing: boolean): Promise<ToolResult> {
    const capability = typeof call?.name === "string" ? capabilities.get(call.name) : undefined;
    // Not declared is private: it does not exist.
    if (!capability) return refused(words.refused(), `There is no capability named "${String(call?.name)}".`);

    const checked = check(capability.args, call.arguments);
    if (!checked.ok) return refused(words.refused(), checked.wrong);

    // Only what the contract names is handed on, whatever the caller's object also carries.
    const context: RunContext = { origin: given.origin, ask: (ask) => given.ask(ask), working: (line) => given.working(line) };

    // Before any question: nobody is asked which app they meant to be told none can be opened.
    const can = capability.available?.() ?? true;
    if (can !== true) return { status: "failed", verified: false, line: words.unavailable(), detail: can || `"${capability.name}" cannot be used right now.` };

    const resolved = await named(capability, checked.args, context);
    if ("ended" in resolved) return resolved.ended;
    const args = resolved.args;

    const tier = tierOf(capability, args);
    if (tier === "confirm") {
      // With no model there is nobody to have meant it: the instant tier never reaches a confirmation.
      if (context.origin === "instant") return refused(words.refused(), `"${capability.name}" needs a click to confirm and is never run without a model.`);
      if (!capability.describe) return refused(words.refused(), `"${capability.name}" needs a click to confirm and does not say what it changes.`);
      // The app's own interface is the user's click already.
      if (context.origin !== "ui" && !(await guard.confirm(await capability.describe(args)))) {
        return { ...done(words.unchanged(), false), detail: "Nothing was changed: the user did not click to confirm." };
      }
    }

    // How to put it back is worked out from how things are now, before they change.
    const remember = tier === "reversible" && !undoing;
    const inverse = remember ? (capability.inverse?.(args) ?? null) : null;

    const result = await capability.run(args, context);
    if (!result || typeof result.status !== "string" || typeof result.line !== "string") {
      return failed(words.failed(), `"${capability.name}" did not say what happened.`);
    }
    if (remember && result.status === "done") {
      // Something changed that cannot be put back: an older change must not be undone in its place.
      if (!capability.inverse) last = null;
      else if (inverse) last = inverse;
    }
    return result;
  }

  /** One call, start to end. Whatever breaks on the way is a result, never an exception. */
  async function run(call: Call, context: RunContext, undoing: boolean): Promise<ToolResult> {
    try {
      return await guarded(call, context, undoing);
    } catch (error) {
      return failed(words.failed(), reason(error));
    }
  }

  async function undo(context: RunContext): Promise<ToolResult> {
    const inverse = last;
    if (!inverse) return failed(words.nothingToUndo(), "Nothing reversible was done, or it was already put back.");
    // Once: it is forgotten before it runs, and putting back is not itself remembered.
    last = null;
    return run(inverse, context, true);
  }

  // ── What a sentence names ───────────────────────────────────────────────────

  async function namedIn(sentence: string): Promise<{ kind: string; id: string; label: string }[]> {
    const out: { kind: string; id: string; label: string }[] = [];
    for (const source of sources.values()) {
      try {
        // A kind too large to list is asked for what is near the sentence; only what is said whole in it counts.
        const things = source.near ? await source.near(sentence) : await source.list();
        for (const thing of contained(sentence, things)) out.push({ kind: source.kind, id: thing.id, label: thing.label });
      } catch {
        // A source that breaks names nothing.
      }
    }
    return out;
  }

  // ── What a model is told every time ─────────────────────────────────────────

  async function snapshot(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    let room = SNAPSHOT_MOST;
    const add = (into: Record<string, unknown>, key: string, value: unknown) => {
      const size = JSON.stringify(value)?.length ?? 0;
      if (!size || size + key.length > room) return false;
      room -= size + key.length;
      into[key] = value;
      return true;
    };

    const screen = safely(() => onScreen());
    if (screen) {
      add(out, "screen", {
        view: clip(String(screen.view), LINE_MOST),
        subjects: screen.subjects.slice(0, SUBJECTS_MOST).map(({ kind, id, label }) => ({ kind, id, label: clip(label, 80) })),
        ...(screen.summary ? { summary: clip(screen.summary, LINE_MOST) } : {}),
      });
    }

    // One line for each kind of thing: what it is, and the names when they can be listed.
    const kinds: Record<string, string> = {};
    for (const source of sources.values()) {
      let line = source.description;
      if (!source.near) {
        const listed = await Promise.resolve().then(() => source.list()).catch(() => []);
        const labels = listed.slice(0, NAMES_MOST).map((thing) => thing.label);
        if (labels.length) line += ` ${labels.join(", ")}${listed.length > labels.length ? `, and ${listed.length - labels.length} more` : ""}.`;
      }
      add(kinds, source.kind, clip(line, LINE_MOST));
    }
    if (Object.keys(kinds).length) out.entities = kinds;

    // The reads that are always told. One that cannot be used or breaks is left out.
    const nobody: RunContext = { origin: "ui", ask: async () => ({ kind: "dropped" }), working: () => {} };
    const reads = [...capabilities.values()].filter((capability) => capability.inSnapshot);
    const read = await Promise.all(
      reads.map(async (capability) => {
        try {
          if ((capability.available?.() ?? true) !== true) return null;
          const result = await capability.run({}, nobody);
          return result?.status === "done" ? (result.data ?? result.line) : null;
        } catch {
          return null;
        }
      }),
    );
    const state: Record<string, unknown> = {};
    reads.forEach((capability, i) => {
      const value = read[i];
      if (value == null) return;
      const text = JSON.stringify(value) ?? "";
      add(state, capability.name, text.length > READ_MOST ? clip(text, READ_MOST) : value);
    });
    if (Object.keys(state).length) out.state = state;
    return out;
  }

  return {
    declare,
    entities,
    screen: (provider) => {
      onScreen = provider;
    },
    all: () => [...capabilities.values()],
    get: (name) => capabilities.get(name),
    areas,
    schema: (name) => {
      const capability = capabilities.get(name);
      return capability ? schemaOf(capability) : null;
    },
    snapshot,
    named: namedIn,
    execute: (call, context) => run(call, context, false),
    undo,
  };
}

function safely<T>(work: () => T): T | null {
  try {
    return work();
  } catch {
    return null;
  }
}
