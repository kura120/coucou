// What a capability gives back, and how Mochi asks. Every capability returns
// a ToolResult: what really happened, in a line for the card and in words a
// model can reason on. Nothing here does anything; the executor runs the
// capabilities (core/capabilities/registry.ts) and island/voice.ts shows the
// states.
//
// A VoiceResult is what a whole turn ends in (voice/turn.ts); a ToolResult is
// what each step of it returns.

/** What a turn ends in, for its card: green and a tick, or red and a cross. */
export interface VoiceResult {
  outcome: "success" | "failure";
  message: string;
}

export type ToolStatus =
  /** Done and checked (`verified`), or done and not checkable. */
  | "done"
  /** Tried, and it did not work: `detail` says why. */
  | "failed"
  /** The thing named does not exist; `near` may hold what it could have been. */
  | "not_found"
  /** Nothing done yet: the user must choose or answer (`ask`). */
  | "ask"
  /** Nothing done yet: a guard wants a click (`confirm`). */
  | "confirm"
  /** Never done by voice, or the checks refused it: `detail` says which rule. */
  | "refused";

/** A question on screen, in one of the three shapes the island can show. */
export type Ask =
  /** A numbered list, two to nine: a click, Ctrl+Shift+number, or said. `about`: the kind of thing it asks which of. */
  | { kind: "choice"; question: string; options: AskOption[]; about?: string }
  /** Two buttons. A spoken yes is an answer here, never a guard's confirmation. `about`: the kind of thing it asks whether. */
  | { kind: "yes_no"; question: string; yes?: string; no?: string; about?: string }
  /** A field: dictated into, edited by hand, confirmed with Ctrl+Shift+Enter. */
  | { kind: "text"; question: string; value?: string; placeholder?: string };

export interface AskOption {
  id: string;
  label: string;
  /** A few words under the label: an address, a path. */
  hint?: string;
}

export type Answer =
  | { kind: "choice"; id: string }
  | { kind: "yes_no"; yes: boolean }
  | { kind: "text"; value: string }
  /** Closed, timed out, "never mind": nothing was answered. */
  | { kind: "dropped" };

/** A change that waits for a click: what it is, exactly, for the toast. */
export interface Confirm {
  /** "Change the language to Hindi?" */
  title: string;
  /** What changes, from what to what, in one line. */
  change: string;
  /** The button that does it: "Change". */
  action: string;
}

export interface ToolResult {
  status: ToolStatus;
  /** The action was seen to have had its effect: the window came, the setting reads back. */
  verified: boolean;
  /** One short line for the card and the fallback answer: "Spotify opened". Translated. */
  line: string;
  /** For the model, and for a failure: what happened, plainly. */
  detail?: string;
  /** What a tool that reads gives back. Small: it goes to a model. */
  data?: unknown;
  /** Names close to what was said (voice/resolve.ts). */
  near?: string[];
  ask?: Ask;
  confirm?: Confirm;
}

export const done = (line: string, verified = true, data?: unknown): ToolResult =>
  ({ status: "done", verified, line, ...(data === undefined ? {} : { data }) });
export const failed = (line: string, detail?: string): ToolResult => ({ status: "failed", verified: false, line, detail: detail ?? line });
export const notFoundResult = (line: string, near: string[] = []): ToolResult =>
  ({ status: "not_found", verified: false, line, ...(near.length ? { near } : {}) });
export const refused = (line: string, detail: string): ToolResult => ({ status: "refused", verified: false, line, detail });
/**
 * What a model is given back for a tool call: the status first, then only
 * what helps it decide the next step. Never the card's wording alone — a model
 * told "Spotify opened" cannot tell a check from a hope.
 */
export function forModel(result: ToolResult): Record<string, unknown> {
  const out: Record<string, unknown> = { status: result.status };
  if (result.status === "done") out.verified = result.verified;
  out.result = result.detail ?? result.line;
  if (result.data !== undefined) out.data = result.data;
  if (result.near?.length) out.did_you_mean = result.near;
  if (result.ask) out.waiting_for = "the user's answer";
  if (result.confirm) out.waiting_for = "the user's click";
  return out;
}

/** An answer is a few sentences at most; it is shown whole, and said whole. */
export const MAX_SPOKEN = 600;

/** What Mochi says: the model's words when it has some, else the tool's line. */
export function spoken(words: string | null | undefined, fallback: string): string {
  const said = (words ?? "").replace(/\s+/g, " ").trim();
  if (!said) return fallback;
  return said.length > MAX_SPOKEN ? `${said.slice(0, MAX_SPOKEN - 1)}…` : said;
}
