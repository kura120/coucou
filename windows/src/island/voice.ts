// "OK Coucou" → the island (src-tauri/src/voice/mod.rs). Rust owns the
// microphone and the recogniser; one `voice` event tells the island what was
// heard. What a sentence means and what is done for it is worked out in three
// tiers (voice/turn.ts) over what the app declared it can do (island/app.ts).

import { Bridge, onEvent, type CapabilityCallEvent } from "../core/bridge";
import type { Registry } from "../core/capabilities/types";
import { State } from "../core/state";
import { language, t } from "../i18n/i18n";
import { heardWith } from "../voice/resolve";
import type { VoiceResult } from "../voice/result";
import { VoiceTurns } from "../voice/turn";

/** How long a result stays on screen before the island goes back. */
export const RESULT_SHOWN_MS = 2000;
/**
 * How long an answer is waited for — a lookup, a model — before the card says
 * it took too long. A model already in memory answers in a fifth of a second;
 * one that has to be loaded first takes about five.
 */
export const VOICE_PATIENCE_MS = 6000;

export interface VoiceEvent {
  phase: "woke" | "partial" | "final" | "missed" | "cancelled" | "following" | "rested" | "hearing" | "again";
  text: string;
  /** How sure the speech model was of each word of `text`, 0…1, when it says (voice/resolve.ts). */
  sure?: number[];
}

export interface VoiceHost {
  voiceWoke(): void;
  /** `sure`: how sure the speech model was of each word, when the sentence is final and it says. */
  voiceHeard(text: string, final: boolean, sure?: readonly number[]): void;
  voiceMissed(): void;
  voiceCancelled(): void;
  /** Another command may follow without the wake phrase, or that time is over. */
  voiceFollowing(on: boolean): void;
  /** A sentence said in that time: for Coucou, or for nobody. `sure`: how sure the speech model was of each word. */
  voiceAgain(text: string, sure?: readonly number[]): void;
  /** A voice started in the follow-up time: the listening view comes back while it is written down. */
  voiceHearing(): void;
  /** How loud the microphone hears while Coucou listens, 0…1. */
  voiceLevel(level: number): void;
  /** Ctrl+Shift+number or Ctrl+Shift+Enter, pressed while a question is on screen: "1"…"9" or "enter". */
  voiceAskKey(key: string): void;
  /** Mochi started saying an answer (its length in ms), or finished (null). */
  voiceSpoken(ms: number | null): void;
  /** A cloud model asked for a capability through its endpoint: the text it is given back. */
  voiceCapabilityCall(name: string, args: unknown): Promise<string>;
}

/**
 * Why a wake phrase is ignored right now, or null when it may open the
 * listening view. Only a paused Coucou ignores it: over a permission request
 * or a question that waits, the wake phrase is heard — the request keeps
 * waiting under the listening view, voice may read it out, and declining it
 * takes a click like any change that cannot be put back.
 */
export function wakeBlocked(paused: boolean): string | null {
  return paused ? "paused" : null;
}

export function applyVoice(island: VoiceHost, event: VoiceEvent) {
  // A name the speech model was not sure of is asked about, not acted on.
  if (event.phase === "final" || event.phase === "again") heardWith(event.text, event.sure);
  switch (event.phase) {
    case "woke":
      island.voiceWoke();
      break;
    case "partial":
      island.voiceHeard(event.text, false);
      break;
    case "final":
      island.voiceHeard(event.text, true, event.sure);
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
    case "hearing":
      island.voiceHearing();
      break;
    case "again":
      island.voiceAgain(event.text, event.sure);
      break;
  }
}

// ── The three tiers (voice/turn.ts) ───────────────────────────────────────────

/** A model server and a model are chosen for voice in Settings. */
export const brainChosen = () => Boolean(State.settings.voice.brain && State.settings.voice.brainModel);

/** The address of the model server chosen for voice; "" is its usual one, on this computer. */
function brainUrl(): string {
  const { voice, ollamaUrl, lmstudioUrl, customUrl } = State.settings;
  return ({ ollama: ollamaUrl, lmstudio: lmstudioUrl, custom: customUrl } as Record<string, string>)[voice.brain] ?? "";
}

/**
 * The model server chosen for voice is this computer. Only then is a
 * sentence said without the wake phrase given to it: what may have been said
 * to someone else in the room does not leave the machine.
 */
export function brainHere(url = brainUrl(), brain = State.settings.voice.brain): boolean {
  const address = url.trim();
  if (!address) return brain === "ollama" || brain === "lmstudio";
  try {
    const host = new URL(address.includes("://") ? address : `http://${address}`).hostname;
    return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * What a sentence means and what is done for it, over the app's registry.
 * The embedding model and the local model are those of the server chosen in
 * Settings → Voice; the cloud model is asked only when the user turned it on.
 * One that cannot be asked answers nothing.
 */
/** Lines for the voice debug log, sent together once the turn's step is over. */
let debugLines: string[] = [];

/** One line for voice-debug.log, only while the user has the debug log on. */
function debugTrace(line: string) {
  if (!State.settings.voice.debugLog) return;
  if (!debugLines.length) {
    queueMicrotask(() => {
      const lines = debugLines;
      debugLines = [];
      void Bridge.voiceDebugLog(lines);
    });
  }
  debugLines.push(line);
}

export function createTurns(registry: Registry): VoiceTurns {
  return new VoiceTurns({
    trace: debugTrace,
    registry,
    embed: async (texts) => (brainChosen() && State.settings.voice.embedModel ? Bridge.voiceEmbed(texts) : null),
    embedChosen: () => Boolean(State.settings.voice.embedModel),
    local: () => (brainChosen() ? (system, said, tools, history, steps) => Bridge.voiceBrain(system, said, tools, history, steps) : null),
    cloud: () => (State.settings.voice.cloud ? (system, said, history) => Bridge.voiceCloud(system, said, history) : null),
    followUp: () => brainChosen() && brainHere(),
    publish: (tools) => void Bridge.capabilityPublish(tools),
    words: {
      noModel: () => t("Voice needs a model server. Choose one in Settings."),
      noEmbedding: () => t("Voice needs an embedding model. Choose one in Settings."),
      embedSilent: () => t("The embedding model did not answer. Say it again in a moment."),
      silent: () => t("The model did not answer."),
      notUnderstood: () => t("Command not recognised"),
      beyond: () => t("That is more than I can do here."),
      askingCloud: () => t("Asking a bigger model…"),
      pardon: () => t("Sorry, I didn't catch that. Say it again?"),
    },
  });
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
    if (speaking !== source) return;
    speaking = null;
    spoken?.(null);
  };
  speaking = source;
  source.start();
  spoken?.(Math.round((samples.length / speech.sampleRate) * 1000));
}

/** Told when Mochi starts saying something (how long it is, in ms) and when he has finished (null). */
let spoken: ((ms: number | null) => void) | null = null;

/** How long the card waits for Mochi's voice to be made before it stops waiting for it. */
export const SPEECH_WAITED_MS = 6000;

/** Whether this result will be said out loud: the card then stays until it has been. */
export const willSpeak = (result: VoiceResult) =>
  State.settings.voice.speak && State.settings.soundEnabled && language() === "en" && result.message.trim() !== "";

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
  // A cloud model reaches the app through its endpoint, one capability at a time: each is answered by its id.
  void onEvent<CapabilityCallEvent>("capability-call", (call) => {
    void island.voiceCapabilityCall(call.name, call.arguments).then((result) => Bridge.capabilityResult(call.id, result));
  });
  spoken = (ms) => island.voiceSpoken(ms);
}
