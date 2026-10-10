// Does what a command means. Port of VoiceActionRunner.swift: an intent in, a
// result for the card out. It touches the app only through `MusicControls` and
// `PillControls`, so the tests run it against fakes (island/voice.ts has the
// real ones).
//
// What differs from the Mac: the music is Spotify's alone, the limit is six
// pills and Spotify takes none of them, and Spotify cannot be asked for a
// track, a playlist or a volume here — those commands say they were not
// recognised rather than pretend.
//
// Voice never approves a permission and never sends anything: no intent does.

import type { PillDefinition } from "../core/pills";
import { t } from "../i18n/i18n";
import { resolvePill } from "./entity";
import type { VoiceIntent } from "./intent";

export interface VoiceResult {
  /** "question": Mochi asks, and listens again for the answer. */
  outcome: "success" | "failure" | "question";
  message: string;
}

export interface MusicControls {
  /** Spotify is switched on in Settings: Coucou follows it and may drive it. */
  enabled(): boolean;
  /** Spotify is running. */
  running(): boolean;
  playing(): boolean;
  shuffle(): boolean;
  repeat(): boolean;
  playPause(): void;
  next(): void;
  previous(): void;
  setShuffle(on: boolean): void;
  setRepeat(on: boolean): void;
  /** Starts Spotify, or brings it forward. */
  open(): void;
}

export interface PillControls {
  /** The declared pills, without the main one. */
  active(): string[];
  main(): string;
  /** Whether one more pill fits. `id`: what has a card of its own takes no slot. */
  hasRoomFor(id: string): boolean;
  /** How many pills fill it. */
  limit(): number;
  toggle(id: string): void;
  setMain(id: string): void;
}

const ok = (message: string): VoiceResult => ({ outcome: "success", message });
const fail = (message: string): VoiceResult => ({ outcome: "failure", message });

export class VoiceRunner {
  /** The pill waiting for room: "which one do I remove?" was asked. */
  private pendingAdd: string | null = null;

  private music: MusicControls;
  private pills: PillControls;
  private catalog: () => readonly PillDefinition[];

  constructor(music: MusicControls, pills: PillControls, catalog: () => readonly PillDefinition[]) {
    this.music = music;
    this.pills = pills;
    this.catalog = catalog;
  }

  get asking(): boolean {
    return this.pendingAdd != null;
  }

  /** The pills as they are now, for what a model is told about the app. */
  pillState(): { active: string[]; main: string } {
    return { active: this.pills.active(), main: this.pills.main() };
  }

  /** Forgets a question nobody answered. */
  reset() {
    this.pendingAdd = null;
  }

  run(intent: VoiceIntent, said = ""): VoiceResult {
    const { music, pills } = this;
    // Music the user switched off is not touched, and not started either.
    if (intent.kind.startsWith("music") && !music.enabled()) return fail(t("Spotify is off in Settings"));
    switch (intent.kind) {
      case "openSpotify":
        // The app was asked for by name: opened even when Coucou does not follow it.
        music.open();
        return ok(t("{0} opened", { 0: "Spotify" }));
      case "musicPlay":
        if (!music.running()) {
          music.open();
          return ok(t("Open Spotify"));
        }
        if (!music.playing()) music.playPause();
        return ok(t("Playing"));
      case "musicPause":
        if (!music.running()) return fail(t("No music app running"));
        if (music.playing()) music.playPause();
        return ok(t("Paused"));
      case "musicNext":
        if (!music.running()) return fail(t("No music app running"));
        music.next();
        return ok(t("Next track"));
      case "musicPrevious":
        if (!music.running()) return fail(t("No music app running"));
        music.previous();
        return ok(t("Previous track"));
      case "musicShuffle": {
        if (!music.running()) return fail(t("No music app running"));
        const on = intent.on ?? !music.shuffle();
        music.setShuffle(on);
        return ok(on ? t("Shuffle on") : t("Shuffle off"));
      }
      case "musicRepeat": {
        if (!music.running()) return fail(t("No music app running"));
        const on = intent.on ?? !music.repeat();
        music.setRepeat(on);
        return ok(on ? t("Repeat on") : t("Repeat off"));
      }

      case "pillAdd": {
        if (intent.id === pills.main() || pills.active().includes(intent.id)) return ok(t("Already active"));
        if (!pills.hasRoomFor(intent.id)) {
          this.pendingAdd = intent.id;
          return { outcome: "question", message: t("{0} active — remove which?", { 0: pills.limit() }) };
        }
        pills.toggle(intent.id);
        return ok(t("{0} added", { 0: this.name(intent.id) }));
      }
      case "pillAddMultiple": {
        const added: string[] = [];
        for (const id of intent.ids) {
          if (id === pills.main() || pills.active().includes(id) || !pills.hasRoomFor(id)) continue;
          pills.toggle(id);
          added.push(this.name(id));
        }
        return added.length ? ok(t("{0} added", { 0: added.join(", ") })) : fail(t("Command not recognised"));
      }
      case "pillRemove":
        if (!pills.active().includes(intent.id)) return fail(t("Not active"));
        pills.toggle(intent.id);
        return ok(t("{0} removed", { 0: this.name(intent.id) }));
      case "pillRemoveMultiple": {
        const removed: string[] = [];
        for (const id of intent.ids) {
          if (!pills.active().includes(id)) continue;
          pills.toggle(id);
          removed.push(this.name(id));
        }
        return removed.length ? ok(t("{0} removed", { 0: removed.join(", ") })) : fail(t("Command not recognised"));
      }
      case "pillSetMain":
        pills.setMain(intent.id);
        return ok(t("Main: {0}", { 0: this.name(intent.id) }));
      case "pillReplace":
        return this.replace(intent.old, intent.new);
      case "pillOnly": {
        // The main pill is always there: it is not one to keep or to drop.
        const keep = intent.ids.filter((id) => id !== pills.main());
        for (const id of pills.active()) if (!keep.includes(id)) pills.toggle(id);
        for (const id of keep) if (!pills.active().includes(id) && pills.hasRoomFor(id)) pills.toggle(id);
        const names = intent.ids.filter((id) => id === pills.main() || pills.active().includes(id));
        return names.length ? ok(t("Only: {0}", { 0: names.map((id) => this.name(id)).join(", ") })) : fail(t("Command not recognised"));
      }

      // Heard and understood, and not something Spotify can be asked here.
      case "musicPlaySearch":
      case "musicPlayPlaylist":
      case "musicVolumeUp":
      case "musicVolumeDown":
      case "musicSetVolume":
      case "cancel":
      case "unknown":
        return fail(said ? t("Not recognised: « {0} »", { 0: said }) : t("Command not recognised"));
    }
  }

  /** The answer to "which one do I remove?": that pill goes, the waiting one comes. */
  answer(said: string): VoiceResult {
    const toAdd = this.pendingAdd;
    this.pendingAdd = null;
    if (!toAdd) return fail(t("Command not recognised"));
    if (!said.trim()) return ok(t("OK, leaving it as is"));
    const id = resolvePill(said, this.catalog());
    if (!id || !this.pills.active().includes(id)) return fail(t("Command not recognised"));
    return this.replace(id, toAdd);
  }

  private replace(old: string, next: string): VoiceResult {
    const { pills } = this;
    if (pills.active().includes(old)) pills.toggle(old);
    if (next !== pills.main() && !pills.active().includes(next) && pills.hasRoomFor(next)) pills.toggle(next);
    if (next !== pills.main() && !pills.active().includes(next)) return fail(t("Command not recognised"));
    return ok(t("{0} → {1}", { 0: this.name(old), 1: this.name(next) }));
  }

  private name(id: string): string {
    return this.catalog().find((p) => p.id === id)?.name ?? id;
  }
}
