// "OK Coucou" → the island (src-tauri/src/voice/mod.rs). Rust owns the
// microphone and the recogniser; one `voice` event tells the island what was
// heard, and the island shows it. Nothing acts on a command yet.

import { onEvent } from "../core/bridge";
import type { IslandMode, IslandViewName } from "../core/layout";

/** How long what was heard stays on screen before the island goes back. */
export const HEARD_SHOWN_MS = 1600;
export const MISSED_SHOWN_MS = 1400;

export interface VoiceEvent {
  phase: "woke" | "partial" | "final" | "missed" | "cancelled";
  text: string;
}

export interface VoiceHost {
  voiceWoke(): void;
  voiceHeard(text: string, final: boolean): void;
  voiceMissed(): void;
  voiceCancelled(): void;
}

/**
 * Why a wake phrase is ignored right now, or null when it may open the
 * listening view (VoiceWakeFilter.wakeBlocked). A request waiting for an
 * answer comes first, and so does what the user is typing or answering.
 */
export function wakeBlocked(
  view: IslandViewName,
  mode: IslandMode,
  pendingApproval: boolean,
  paused: boolean,
): string | null {
  if (paused) return "paused";
  if (pendingApproval) return "approval shown";
  if (mode !== "expanded") return null;
  switch (view) {
    case "approval":
      return "approval shown";
    case "question":
      return "question shown";
    case "prompt":
      return "chat shown";
    default:
      return null;
  }
}

export function applyVoice(island: VoiceHost, event: VoiceEvent) {
  switch (event.phase) {
    case "woke":
      island.voiceWoke();
      break;
    case "partial":
      island.voiceHeard(event.text, false);
      break;
    case "final":
      island.voiceHeard(event.text, true);
      break;
    case "missed":
      island.voiceMissed();
      break;
    case "cancelled":
      island.voiceCancelled();
      break;
  }
}

export function registerVoiceHandlers(island: VoiceHost) {
  void onEvent<VoiceEvent>("voice", (event) => applyVoice(island, event));
}
