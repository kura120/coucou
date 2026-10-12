// What Coucou lets its assistant see and do, declared by the app itself
// (doc/voice-brain.md). A function of the app that is declared as a
// `Capability` is public: the assistant is told of it and may ask for it. One
// that is not declared does not exist for the assistant — there is no other
// way in. The guard is the executor's own and is no capability.
//
// Nothing here knows how anything is said: no words, no phrases, no grammar.
// A capability is described once, in a sentence a model reads, and its
// arguments are typed; what a sentence means is the model's to work out.
//
// This file is the contract several sessions build on. Types only.

import type { Answer, Ask, Confirm, ToolResult } from "../../voice/result";

export type { Answer, Ask, Confirm, ToolResult };

/**
 * How carefully a capability is used, decided by the app and never by the
 * assistant:
 *
 *   read        looks, changes nothing
 *   free        done at once: a view comes up, a note is shown
 *   reversible  done at once and said; it can be put back (`undo`)
 *   confirm     the exact change is shown and only a click does it — never a word
 *
 * What may never be done by the assistant has no tier: it is not declared.
 */
export type Tier = "read" | "free" | "reversible" | "confirm";

/** The kinds of thing the app has that can be named: "pill", "session", "view", "setting", "app"… Open: a module adds its own. */
export type EntityKind = string;

/** One thing of a kind, as the app knows it. */
export interface Entity {
  /** The app's own identifier: what a capability is given. */
  id: string;
  /** How it is written on screen. */
  label: string;
  /** Other ways it is written or said, when the thing itself has some (a catalog entry's, never a list kept for voice). */
  spoken?: readonly string[];
  /** A few words that tell it from the others: a path, an address, a state. */
  hint?: string;
}

/** Where the things of one kind are listed, now. */
export interface EntitySource {
  kind: EntityKind;
  /** One line a model reads: "The pills shown in the island: agents, services, the main workspace tool." */
  description: string;
  list(): readonly Entity[] | Promise<readonly Entity[]>;
  /**
   * For a kind too large to list (the installed apps): the things nearest a
   * name, nearest first, each with how near it is (0…1). When given, it is
   * used instead of ranking `list()`.
   */
  near?(said: string): Promise<readonly (Entity & { score: number })[]>;
}

/** One argument of a capability. */
export type ArgSpec = {
  description: string;
  optional?: boolean;
} & (
  | { type: "string"; enum?: readonly string[]; maxLength?: number }
  | { type: "number"; min?: number; max?: number }
  | { type: "boolean" }
  /** One thing of a kind: the model gives a name or an id, the executor resolves it and `run` is given the id. */
  | { type: "entity"; kind: EntityKind }
  /** Several of them. */
  | { type: "entities"; kind: EntityKind; max?: number }
);

export type Args = Record<string, unknown>;

/** Which of the three tiers of reasoning proposed a call (doc/voice-brain.md, section 4). */
export type Origin = "instant" | "local" | "cloud" | "ui";

/** What a capability is given besides its arguments. */
export interface RunContext {
  origin: Origin;
  /** Puts a question on screen and waits for its answer (views/ask.ts). */
  ask(ask: Ask): Promise<Answer>;
  /** A line to show while it works: "Opening Spotify…". */
  working(line: string): void;
}

export interface Capability {
  /** snake_case, stable: "pause_music", "show_view". */
  name: string;
  /** The part of the app it belongs to: "music", "pills", "chat", "settings"… One line per area is what a model sees first. */
  area: string;
  /** One or two sentences a model reads to decide: what it does, and when it is the wrong one. */
  description: string;
  args: Readonly<Record<string, ArgSpec>>;
  /** A function when it depends on the arguments (a setting's own tier). */
  tier: Tier | ((args: Args) => Tier);
  /** False, or why not, when it cannot be used right now (no music app running). Told to the model as it is. */
  available?(): true | string;
  /** For `confirm`: the exact change, for the toast. Called with resolved arguments, before `run`. */
  describe?(args: Args): Confirm | Promise<Confirm>;
  /**
   * How the question about a name the executor is not sure of is worded, with
   * the nearest thing's label: "Open Spotify?". `arg`: the argument it is for.
   * Without it the registry's own general question is asked.
   */
  question?(label: string, arg: string): string;
  /** Does it, and says what really happened. Arguments are validated and entities resolved to ids. */
  run(args: Args, context: RunContext): Promise<ToolResult>;
  /**
   * For `reversible`: the call that puts things back, worked out before `run`
   * from how things are now. Null when there is nothing to put back.
   */
  inverse?(args: Args): Call | null;
  /** A `read` capability whose result is part of what the model is told every time (kept small). */
  inSnapshot?: boolean;
}

/** What a model asks for: a capability by its name, and arguments as it wrote them. */
export interface Call {
  name: string;
  arguments: Args;
}

/** What is on screen now, said by the view that shows it: what "this" and "that one" mean. */
export interface ScreenContext {
  /** The island's view, by its name. */
  view: string;
  /** What the view is about, the most prominent first. */
  subjects: readonly { kind: EntityKind; id: string; label: string }[];
  /** A line or two of what it shows, when that helps. */
  summary?: string;
}

/** What the executor needs of the app to guard a call. Never given to a capability or a model. */
export interface GuardHost {
  /** Shows the exact change in a toast and waits. True only for a click on its button. */
  confirm(confirm: Confirm): Promise<boolean>;
}

/**
 * The registry, as the rest of the app uses it (core/capabilities/registry.ts).
 * Declared here so the capabilities' modules and the loop can be written
 * before it exists.
 */
export interface Registry {
  declare(...capabilities: Capability[]): void;
  entities(source: EntitySource): void;
  /** The view on screen says what it shows; null when it has nothing to say. */
  screen(provider: () => ScreenContext | null): void;

  /** Every capability, in the order declared. */
  all(): readonly Capability[];
  get(name: string): Capability | undefined;
  /** The areas, each with the names of its capabilities. */
  areas(): readonly { area: string; names: readonly string[] }[];
  /** One capability as a tool in the OpenAI function format — the same JSON Schema an MCP tool takes. Null for a name not declared. */
  schema(name: string): unknown;
  /** What a model is told of the app every time: the `inSnapshot` reads, what is on screen, the entity kinds. */
  snapshot(): Promise<Record<string, unknown>>;

  /**
   * One call, guarded and done: looked up (unknown: refused), its arguments
   * validated and its entities resolved (unsure: asked about; none:
   * not_found), availability checked, its tier applied (confirm: a click),
   * run, and its inverse remembered.
   */
  execute(call: Call, context: RunContext): Promise<ToolResult>;
  /** Puts the last reversible thing back. */
  undo(context: RunContext): Promise<ToolResult>;
}
