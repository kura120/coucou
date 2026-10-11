// A LOCAL COPY of the types doc/voice-turns.md fixes (sections 2 and 3), for
// the resolver and the questions built on them until the main session's
// `result.ts` lands on feat/voice-turns: delete this file when rebasing onto
// it. Nothing here may differ from the contract.

export type ToolStatus = "done" | "failed" | "not_found" | "ask" | "confirm" | "refused";

export type Ask =
  // 2 to 9 options
  | { kind: "choice"; question: string; options: { id: string; label: string; hint?: string }[] }
  | { kind: "yes_no"; question: string; yes?: string; no?: string }
  | { kind: "text"; question: string; value?: string; placeholder?: string };

export type Answer =
  | { kind: "choice"; id: string }
  | { kind: "yes_no"; yes: boolean }
  | { kind: "text"; value: string }
  // closed, timed out, "never mind"
  | { kind: "dropped" };

export interface ToolResult {
  status: ToolStatus;
  /** The action was seen to have had its effect. */
  verified: boolean;
  /** One short line for the card and the fallback answer. Translated. */
  line: string;
  /** For the model, and for a failure: what happened, plainly. */
  detail?: string;
  data?: unknown;
  /** Names that are close to what was said (the resolver's). */
  near?: string[];
  ask?: Ask;
  /** The guard's (section 5): the main session's to define. */
  confirm?: unknown;
}
