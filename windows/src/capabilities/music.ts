// Music: Spotify, as the music card drives it. What can be put back (playing,
// shuffle, repeat, the volume) is reversible; a skipped track is not.

import type { Call, ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, type Area } from "./shared";

const AREA = "music";
/** Which player a result is about: what Peika says of it ("Spotify is paused") is checked against the results. */
const PLAYER = { player: "Spotify" };

export function music(host: AppHost): Area {
  /** Music the user switched off is not touched, and not started either. */
  const off = () => (host.music().enabled ? null : t("Spotify is off in Settings"));
  const available = (): true | string => off() ?? (host.music().running ? true : t("No music app running"));
  const refusedNow = (): ToolResult | null => {
    const why = available();
    return why === true ? null : failed(why);
  };

  /**
   * Whether the player came to what was asked, read again for a moment: the
   * player says so a little after it was asked, and what was read at once was
   * taken for a failure (a model then asked for the opposite: "pause" played).
   */
  async function seen(check: () => boolean, ms = 1500): Promise<boolean> {
    for (let waited = 0; !check(); waited += 100) {
      if (waited >= ms) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  /** One switch of the player (shuffle, repeat): set, then read back. */
  async function switchTo(action: "shuffle" | "repeat", on: boolean, line: string): Promise<ToolResult> {
    const stopped = refusedNow();
    if (stopped) return stopped;
    if (!(await host.musicControl(action, on ? 1 : 0))) return failed(t("That did not change"), "The player did not take it.");
    return done(line, host.music()[action] === on);
  }

  return {
    sources: [],
    capabilities: [
      capability({
        name: "now_playing",
        area: AREA,
        description: "Says what is playing now: the track, the artist, whether it plays, shuffle, repeat and the volume.",
        args: {},
        tier: "read",
        inSnapshot: true,
        async run() {
          const now = host.music();
          if (!now.enabled || !now.running || !now.track) return done(t("Not playing"), true, { playing: false, track: null });
          const { title, artist, album, duration } = now.track;
          return done(`${title} — ${artist}`, true, {
            playing: now.playing, track: { title, artist, album, duration }, position: Math.round(now.position),
            shuffle: now.shuffle, repeat: now.repeat, volume: now.volume,
          });
        },
      }),
      capability({
        name: "play_music",
        area: AREA,
        description: "Plays the music: starts or resumes it in Spotify, starting Spotify when it is not running. It cannot pick a track, an artist or a playlist.",
        args: {},
        tier: "reversible",
        available: () => off() ?? true,
        inverse: (): Call | null => {
          const now = host.music();
          return now.running && !now.playing ? { name: "pause_music", arguments: {} } : null;
        },
        async run() {
          const why = off();
          if (why) return failed(why);
          if (!host.music().running) {
            // Starting the player is all that can be asked: whether it then plays is its own.
            return (await host.openMusic()) ? done(t("Open Spotify"), false) : failed(t("Spotify not installed"));
          }
          // Play said as such, never a toggle: what the app last read of the player may be late.
          if (!(await host.musicControl("play"))) return failed(t("That did not change"), "The player did not take it.");
          return done(t("Playing"), await seen(() => host.music().playing), PLAYER);
        },
      }),
      capability({
        name: "pause_music",
        area: AREA,
        description: "Pauses the music playing in Spotify, which is also what stopping the music or Spotify means. What a pause means when nothing else is named. Not for pausing Peika itself, and not for turning off Peika's microphone.",
        args: {},
        tier: "reversible",
        available,
        inverse: () => (host.music().playing ? { name: "play_music", arguments: {} } : null),
        async run() {
          const stopped = refusedNow();
          if (stopped) return stopped;
          // Pause said as such, never a toggle: a toggle on a late reading started the music instead.
          if (!(await host.musicControl("pause"))) return failed(t("That did not change"), "The player did not take it.");
          return done(t("Paused"), await seen(() => !host.music().playing), PLAYER);
        },
      }),
      capability({
        name: "next_track",
        area: AREA,
        description: "Skips to the next track.",
        args: {},
        tier: "free",
        repeatable: true,
        available,
        async run() {
          const stopped = refusedNow();
          if (stopped) return stopped;
          // Which track comes is the player's to say, a moment later: asked for, not seen.
          return (await host.musicControl("next")) ? done(t("Next track"), false, PLAYER) : failed(t("That did not change"), "The player did not take it.");
        },
      }),
      capability({
        name: "previous_track",
        area: AREA,
        description: "Goes back to the previous track, or to the start of this one.",
        args: {},
        tier: "free",
        repeatable: true,
        available,
        async run() {
          const stopped = refusedNow();
          if (stopped) return stopped;
          return (await host.musicControl("previous")) ? done(t("Previous track"), false, PLAYER) : failed(t("That did not change"), "The player did not take it.");
        },
      }),
      capability({
        name: "set_shuffle",
        area: AREA,
        description: "Turns the player's shuffle on or off.",
        args: { on: { type: "boolean", description: "True for shuffle on, false for off." } },
        tier: "reversible",
        available,
        inverse: (args) => (host.music().shuffle === (args.on === true) ? null : { name: "set_shuffle", arguments: { on: host.music().shuffle } }),
        run: (args) => switchTo("shuffle", args.on === true, args.on === true ? t("Shuffle on") : t("Shuffle off")),
      }),
      capability({
        name: "set_repeat",
        area: AREA,
        description: "Turns the player's repeat on or off.",
        args: { on: { type: "boolean", description: "True for repeat on, false for off." } },
        tier: "reversible",
        available,
        inverse: (args) => (host.music().repeat === (args.on === true) ? null : { name: "set_repeat", arguments: { on: host.music().repeat } }),
        run: (args) => switchTo("repeat", args.on === true, args.on === true ? t("Repeat on") : t("Repeat off")),
      }),
      capability({
        name: "set_music_volume",
        area: AREA,
        description: "Sets the music player's volume, from 0 to 100. Not for muting Peika, nor for the volume of Peika's own sounds and Peika's voice: those are the settings Sound effects and Sound effects volume.",
        args: { percent: { type: "number", min: 0, max: 100, description: "The volume, from 0 to 100." } },
        tier: "reversible",
        available,
        // Where the volume cannot be read, there is nothing known to put back.
        inverse: () => {
          const { volume } = host.music();
          return volume == null ? null : { name: "set_music_volume", arguments: { percent: volume } };
        },
        async run(args) {
          const stopped = refusedNow();
          if (stopped) return stopped;
          const percent = Math.round(Math.max(0, Math.min(100, Number(args.percent))));
          if (!Number.isFinite(percent)) return failed(t("That did not change"), "The volume is a number from 0 to 100.");
          if (!(await host.musicControl("volume", percent))) return failed(t("That did not change"), "The player did not take it.");
          return done(t("Volume {0}%", { 0: percent }), host.music().volume === percent);
        },
      }),
      capability({
        name: "seek_music",
        area: AREA,
        description: "Moves to a place in the track that is playing, given in seconds from its start.",
        args: { seconds: { type: "number", min: 0, description: "Seconds from the start of the track." } },
        tier: "free",
        available,
        async run(args) {
          const stopped = refusedNow();
          if (stopped) return stopped;
          const track = host.music().track;
          if (!track) return failed(t("Not playing"));
          const seconds = Math.max(0, Math.min(Number(args.seconds), track.duration > 0 ? track.duration : Number(args.seconds)));
          if (!Number.isFinite(seconds)) return failed(t("That did not change"), "The place is a number of seconds.");
          if (!(await host.musicControl("seek", seconds))) return failed(t("That did not change"), "The player did not take it.");
          const line = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
          return done(line, Math.abs(host.music().position - seconds) < 3);
        },
      }),
    ],
  };
}
