// "OK Coucou" → the island (src-tauri/src/voice/mod.rs). Rust owns the
// microphone and the recogniser; one `voice` event tells the island what was
// heard. The island understands it (voice/intent.ts) and acts (voice/runner.ts)
// through the controls below, which do what a click in the app would do.

import { Bridge, onEvent } from "../core/bridge";
import type { IslandMode, IslandViewName } from "../core/layout";
import {
  MAX_DECLARED, availablePills, chooseMainPill, sanitizeDeclared, slotsUsed, takesSlot,
} from "../core/pills";
import { SPOTIFY_ID, Spotify } from "../core/spotify";
import { State } from "../core/state";
import { buildGrammar } from "../voice/grammar";
import { VoiceRunner, type MusicControls, type PillControls } from "../voice/runner";

/** How long a result stays on screen before the island goes back. */
export const RESULT_SHOWN_MS = 2000;

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

// ── What voice may touch ──────────────────────────────────────────────────────

/** Spotify, as the music card drives it (views/spotify.ts). */
const liveMusic: MusicControls = {
  enabled: () => declared().activeIntegrations.includes(SPOTIFY_ID),
  running: () => Spotify.state.running,
  playing: () => Spotify.state.playing,
  shuffle: () => Spotify.state.shuffle,
  repeat: () => Spotify.state.repeat,
  playPause: () => void Bridge.spotifyControl("playPause"),
  next: () => void Bridge.spotifyControl("next"),
  previous: () => void Bridge.spotifyControl("previous"),
  setShuffle: (on) => void Bridge.spotifyControl("shuffle", on ? 1 : 0),
  setRepeat: (on) => void Bridge.spotifyControl("repeat", on ? 1 : 0),
  open: () => void Bridge.spotifyOpen(),
};

const declared = () => sanitizeDeclared(State.settings, State.os);

/** The pills, as Settings → Active pills changes them: same rules, then saved. */
const livePills: PillControls = {
  active: () => declared().activeIntegrations,
  main: () => declared().mainPill,
  hasRoomFor: (id) => !takesSlot(id) || slotsUsed(declared().activeIntegrations) < MAX_DECLARED,
  limit: () => MAX_DECLARED,
  toggle(id) {
    State.toggleIntegration(id);
    void Bridge.saveSettings(State.settings);
    State.notify();
  },
  setMain(id) {
    const next = chooseMainPill(declared(), id, State.os);
    if (!next) return;
    State.settings.mainPill = next.mainPill;
    State.settings.activeIntegrations = next.activeIntegrations;
    State.loadIntegrationTasks();
    // A new main tool comes to the front, as when it is picked in Settings.
    State.setFocus(State.mainPillId);
    void Bridge.saveSettings(State.settings);
    State.notify();
  },
};

/** The pills a command may name: the ones this build offers. */
export const voicePills = () => availablePills(State.os);

export const voiceRunner = new VoiceRunner(liveMusic, livePills, voicePills);

export function registerVoiceHandlers(island: VoiceHost) {
  void onEvent<VoiceEvent>("voice", (event) => applyVoice(island, event));
  // What the recogniser can hear: nothing listens until it has this.
  const grammar = buildGrammar(voicePills());
  void Bridge.voiceGrammar(grammar.commands, grammar.slots);
}
