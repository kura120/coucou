// Whether an alert may come up while a game, a video or a presentation is
// fullscreen in front (Settings → General → "Quiet over fullscreen apps").
// Pure: hooks.ts asks the system whether the user is busy and hands the answer
// here, so every combination is a table in tests/quiet.test.mjs.

/** The alerts that can open the island or sound. */
export type AlertKind = "finished" | "error" | "approval" | "question";

export interface QuietDecision {
  /** true: the island opens (or switches its view); false: the pill is badged and nothing more. */
  open: boolean;
  /** Whether the alert's sound plays. */
  sound: boolean;
}

/**
 * A session that finished or failed can wait: it turns into its pill's badge,
 * silently, until the fullscreen app is gone. A permission request or a
 * question cannot — an agent is blocked on the answer — so those always come up.
 */
export function quietDecision(kind: AlertKind, busy: boolean, quietWhenBusy: boolean): QuietDecision {
  const waits = quietWhenBusy && busy && (kind === "finished" || kind === "error");
  return { open: !waits, sound: !waits };
}

/** Only these alerts can be held back, so only for these is the system worth asking. */
export function mayBeQuiet(kind: AlertKind, quietWhenBusy: boolean): boolean {
  return quietWhenBusy && (kind === "finished" || kind === "error");
}
