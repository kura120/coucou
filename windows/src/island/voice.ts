// "OK Coucou" → the island (src-tauri/src/voice/mod.rs). Rust owns the
// microphone and the recogniser; one `voice` event tells the island what was
// heard. The island understands it (voice/intent.ts) and acts (voice/runner.ts)
// through the controls below, which do what a click in the app would do.

import { Bridge, onEvent } from "../core/bridge";
import type { IslandMode, IslandViewName } from "../core/layout";
import {
  MAX_DECLARED, availablePills, chooseMainPill, pillDefinition, sanitizeDeclared, slotsUsed, takesSlot,
} from "../core/pills";
import { lastTextStep } from "../core/diff";
import { Sound } from "../core/sound";
import { language, t } from "../i18n/i18n";
import { askToast, showToast } from "../toast/api";
import { read, written } from "../voice/guard";
import type { AppView, AppWorld } from "../voice/tools-app";
import type { VoiceWorld } from "../voice/tools";
import { VoiceConversation } from "../voice/conversation";
import { resolveRelative, type VoiceAction } from "../voice/memory";
import { SPOTIFY_ID, Spotify } from "../core/spotify";
import { State } from "../core/state";
import { buildGrammar } from "../voice/grammar";
import { parseIntent, parseSeveral } from "../voice/intent";
import type { PillDefinition } from "../core/pills";
import { VoiceRunner, type MusicControls, type PillControls, type VoiceResult } from "../voice/runner";

/** How long a result stays on screen before the island goes back. */
export const RESULT_SHOWN_MS = 2000;
/**
 * How long an answer is waited for — a lookup, a model — before the card says
 * it took too long. A model already in memory answers in a fifth of a second;
 * one that has to be loaded first takes about five.
 */
export const VOICE_PATIENCE_MS = 6000;

export interface VoiceEvent {
  phase: "woke" | "partial" | "final" | "missed" | "cancelled" | "following" | "rested" | "again";
  text: string;
}

export interface VoiceHost {
  voiceWoke(): void;
  voiceHeard(text: string, final: boolean): void;
  voiceMissed(): void;
  voiceCancelled(): void;
  /** Another command may follow without the wake phrase, or that time is over. */
  voiceFollowing(on: boolean): void;
  /** A sentence said in that time: a command, or nothing meant for Coucou. */
  voiceAgain(text: string): void;
  /** How loud the microphone hears while Coucou listens, 0…1. */
  voiceLevel(level: number): void;
  /** Ctrl+Shift+number or Ctrl+Shift+Enter, pressed while a question is on screen: "1"…"9" or "enter". */
  voiceAskKey(key: string): void;
}

/** What the tools need of the island itself. */
export interface VoiceCards {
  /** Brings the waiting permission card up, answering nothing. */
  showWaitingCard(): void;
  /** Declines the waiting permission, as a click on Deny does. */
  declineWaiting(): void;
  /** Brings one of the island's views up, or the Settings window. False when it cannot be shown now. */
  showView(view: AppView): boolean;
  /** Opens the chat with this in its field, for the user to read and send. */
  prepareChat(message: string): boolean;
  /** The settings changed under the island: it follows, as it does for the Settings window. */
  settingsChanged(): void;
  /** Pauses Coucou, as the tray's Pause does. */
  pause(): void;
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
    case "following":
      island.voiceFollowing(true);
      break;
    case "rested":
      island.voiceFollowing(false);
      break;
    case "again":
      island.voiceAgain(event.text);
      break;
  }
}

/**
 * What a sentence said without the wake phrase is, before anything is shown:
 * a command the parser knows, something only the model could make sense of
 * (`brain`: one is chosen), or nothing for Coucou — typing taken for words, a
 * word to someone else, "never mind" with nothing to cancel. `last`: what was
 * done last, which a follow-up that says it is one builds on — "and Vercel
 * too" is a command, "what about Steam?" one only if Steam turns out to be an
 * app, so it is looked up before anything shows (`ask`). A bare name is
 * nothing here: it was not said to Coucou.
 */
export function followUpKind(
  said: string,
  pills: readonly PillDefinition[],
  brain: boolean,
  last: VoiceAction | null = null,
): "command" | "ask" | "nothing" {
  const intent = parseIntent(said, pills);
  if (intent.kind === "cancel") return "nothing";
  if (intent.kind !== "unknown" || parseSeveral(said, pills)) return "command";
  const relative = resolveRelative(said, last, pills, false);
  if (relative) return relative.intent.kind === "open" ? "ask" : "command";
  return brain ? "ask" : "nothing";
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

// ── What the tools reach (voice/tools.ts) ─────────────────────────────────────

const CLAUDE_DESKTOP_ID = "agent_claude-desktop";

let timer: { label: string; endsAt: number; handle: number } | null = null;

function stopTimer(): boolean {
  if (!timer) return false;
  window.clearTimeout(timer.handle);
  timer = null;
  return true;
}

/** Where a web search is opened: the browser decides nothing about it, the address does. */
const WEB_SEARCH = "https://www.google.com/search?q=";

/** The app's views, settings and windows, as voice reaches them (voice/tools-app.ts). */
function createAppWorld(cards: VoiceCards): AppWorld {
  const setSetting = async (key: string, value: unknown) => {
    State.settings = written(State.settings, key, value);
    await Bridge.saveSettings(State.settings);
    cards.settingsChanged();
    State.notify();
    return read(State.settings, key) === value;
  };
  return {
    setting: (key) => read(State.settings, key),
    setSetting,
    // A click on the toast's button, or its key: never a word.
    confirm: async ({ title, change, action }) =>
      (await askToast({ kind: "warning", title, text: change, actions: { yes: action, no: t("Cancel") } })) === "yes",
    notify: (title, text) => void showToast({ kind: "info", title, text: text || undefined }),
    showView: (view) => cards.showView(view),
    stopListening() {
      void setSetting("voice.enabled", false);
      // Closing the microphone is never made hard; the way back is on screen for a while.
      void askToast({
        kind: "info", title: t("Voice is off"), text: t("Coucou no longer listens. Turn it back on here, or in Settings."),
        actions: { yes: t("Turn back on"), no: t("OK") }, durationMs: 20_000,
      }).then((answer) => {
        if (answer === "yes") void setSetting("voice.enabled", true);
      });
    },
    pause: () => cards.pause(),
    serviceInfo(pillId) {
      const task = State.tasks.find((x) => x.id === pillId);
      if (!task) return [];
      return [task.finalLine, ...task.steps.slice(-5).map((step) => (typeof step === "string" ? step : (step as { text?: string }).text))]
        .filter((line): line is string => typeof line === "string" && line.trim() !== "")
        .map((line) => line.slice(0, 160));
    },
    openWebSearch: (query) => void Bridge.openUrl(WEB_SEARCH + encodeURIComponent(query)),
    openMailDraft: async (to, subject, body) => (await Bridge.openMailDraft(to, subject, body)) === true,
    prepareForAgent: (message) => cards.prepareChat(message),
    remote() {
      const { voice, ollamaUrl, lmstudioUrl, customUrl } = State.settings;
      const url = { ollama: ollamaUrl, lmstudio: lmstudioUrl, custom: customUrl }[voice.brain as "ollama" | "lmstudio" | "custom"] ?? "";
      return url !== "" && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url.trim());
    },
  };
}

/** Whether the app opened last was seen to come to the front. */
let appSeen = false;

export function createWorld(cards: VoiceCards): VoiceWorld {
  const pillName = (id: string) => pillDefinition(id)?.name ?? id;
  return {
    agents: () =>
      State.tasks
        .filter((task) => !task.isIntegration && (task.state !== "idle" || task.steps.length > 0))
        .map((task) => ({
          id: task.id,
          name: pillName(task.id),
          state: task.state,
          doing: (task.finalLine || lastTextStep(task.steps) || "").slice(0, 120),
        })),
    openSession(id) {
      const task = State.tasks.find((x) => x.id === id);
      if (!task) return false;
      State.setFocus(id);
      if (id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
      else void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
      return true;
    },
    permission() {
      const pending = State.pendingApproval;
      if (!pending || pending.questions) return null;
      return { agent: pillName(pending.pillId), request: `${pending.tool}: ${pending.command}`.slice(0, 160) };
    },
    showPermission: () => cards.showWaitingCard(),
    declinePermission: () => cards.declineWaiting(),
    timer: () =>
      timer ? { label: timer.label, minutesLeft: Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 60_000)) } : null,
    setTimer(minutes, label) {
      stopTimer();
      const ms = minutes * 60_000;
      const handle = window.setTimeout(() => {
        timer = null;
        Sound.play("finish");
        void showToast({ kind: "info", title: t("Time's up"), text: label || undefined, durationMs: 15_000 });
      }, ms);
      timer = { label, endsAt: Date.now() + ms, handle };
    },
    cancelTimer: stopTimer,
    async openApp(name) {
      const app = await Bridge.voiceOpenApp(name);
      appSeen = app?.seen ?? false;
      return app?.name ?? null;
    },
    appSeen: () => appSeen,
    app: createAppWorld(cards),
    appsNear: async (said) => (await Bridge.voiceAppsNear(said)) ?? { names: [], clear: false },
    openFolder: async (name) => (await Bridge.voiceOpenFolder(name)) ?? null,
    openUrl: (url) => void Bridge.openUrl(url),
    nowPlaying() {
      const { track, playing } = Spotify.state;
      return track && playing ? `${track.title} — ${track.artist}` : null;
    },
    reports() {
      const out: Record<string, string> = {};
      for (const task of State.tasks) {
        const line = task.isIntegration ? lastTextStep(task.steps) : undefined;
        if (line) out[pillName(task.id)] = line.slice(0, 120);
      }
      return out;
    },
  };
}

/** A model server and a model are chosen for voice in Settings. */
export const brainChosen = () => Boolean(State.settings.voice.brain && State.settings.voice.brainModel);

/** The pills a command may name: the ones this build offers. */
export const voicePills = () => availablePills(State.os);

export const voiceRunner = new VoiceRunner(liveMusic, livePills, voicePills);

/**
 * What a sentence means and what is done for it, with the last turns in mind
 * (voice/conversation.ts). The model is the server chosen in Settings; one
 * that cannot be asked answers nothing, which is "not recognised".
 */
export function createConversation(world: VoiceWorld): VoiceConversation {
  return new VoiceConversation(voiceRunner, world, voicePills, () =>
    brainChosen() ? (system, said, tools, history, steps) => Bridge.voiceBrain(system, said, tools, history, steps) : null,
  );
}

// ── Mochi's voice (src-tauri/src/voice/speak.rs) ──────────────────────────────

/** The sound effects' default volume: Mochi speaks at full level there. */
const USUAL_VOLUME = 0.12;

let speechContext: AudioContext | null = null;
let speaking: AudioBufferSourceNode | null = null;

/** 16-bit mono PCM in base64 → samples, -1…1. */
export function decodeSpeech(pcm: string): Float32Array {
  const bytes = atob(pcm);
  const samples = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    const value = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
    samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
  }
  return samples;
}

/** How loud Mochi speaks for a Sound volume: the usual volume and above is full. */
export function speechGain(soundVolume: number): number {
  return Math.max(0, Math.min(1, soundVolume / USUAL_VOLUME));
}

export function stopSpeaking() {
  try {
    speaking?.stop();
  } catch {
    // Already over.
  }
  speaking = null;
}

function playSpeech(speech: { sampleRate: number; pcm: string }) {
  // Muted is muted, for Mochi's voice like for his sounds.
  if (!State.settings.soundEnabled || !speech.sampleRate) return;
  const samples = decodeSpeech(speech.pcm);
  if (!samples.length) return;
  stopSpeaking();
  speechContext ??= new AudioContext();
  if (speechContext.state === "suspended") void speechContext.resume();
  const buffer = speechContext.createBuffer(1, samples.length, speech.sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = speechContext.createBufferSource();
  const gain = speechContext.createGain();
  gain.gain.value = speechGain(State.settings.soundVolume);
  source.buffer = buffer;
  source.connect(gain).connect(speechContext.destination);
  source.onended = () => {
    if (speaking === source) speaking = null;
  };
  speaking = source;
  source.start();
}

/**
 * Has Mochi say what a command did, when speaking is on. English only for
 * now, like listening: in another language the card says it.
 */
export function sayResult(result: VoiceResult) {
  if (!State.settings.voice.speak || language() !== "en") return;
  void Bridge.voiceSay(result.message.replace(/[«»]/g, ""));
}

export function registerVoiceHandlers(island: VoiceHost) {
  void onEvent<VoiceEvent>("voice", (event) => applyVoice(island, event));
  void onEvent<number>("voice-level", (level) => island.voiceLevel(level));
  void onEvent<string>("voice-ask-key", (key) => island.voiceAskKey(key));
  void onEvent<{ sampleRate: number; pcm: string }>("voice-speech", playSpeech);
  // What the recogniser can hear: nothing listens until it has this. The
  // installed apps are part of it ("open {app}"), so they are asked for first.
  void Bridge.voiceApps().then((apps) => {
    const grammar = buildGrammar(voicePills(), apps ?? []);
    void Bridge.voiceGrammar(grammar.commands, grammar.slots);
  });
}
