// Music: Spotify, as the music card drives it. What can be put back (playing,
// shuffle, repeat, the volume) is reversible; a skipped track is not.

import type { Call, ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { done, failed } from "../voice/result";
import type { AppHost } from "./host";
import { capability, type Area } from "./shared";

const AREA = "music";

export function music(host: AppHost): Area {
  /** Music the user switched off is not touched, and not started either. */
  const off = () => (host.music().enabled ? null : t("Spotify is off in Settings"));
  const available = (): true | string => off() ?? (host.music().running ? true : t("No music app running"));
  const refusedNow = (): ToolResult | null => {
    const why = available();
    return why === true ? null : failed(why);
  };

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
          if (!host.music().playing && !(await host.musicControl("playPause"))) return failed(t("That did not change"), "The player did not take it.");
          return done(t("Playing"), host.music().playing);
        },
      }),
      capability({
        name: "pause_music",
        area: AREA,
        description: "Pauses the music that is playing, for a moment or for good. What a pause means when nothing else is named. Not for pausing Coucou itself, and not for stopping the microphone.",
        args: {},
        tier: "reversible",
        available,
        inverse: () => (host.music().playing ? { name: "play_music", arguments: {} } : null),
        async run() {
          const stopped = refusedNow();
          if (stopped) return stopped;
          if (host.music().playing && !(await host.musicControl("playPause"))) return failed(t("That did not change"), "The player did not take it.");
          return done(t("Paused"), !host.music().playing);
        },
      }),
      capability({
        name: "next_track",
        area: AREA,
        description: "Skips to the next track.",
        args: {},
        tier: "free",
        available,
        async run() {
          const stopped = refusedNow();
          if (stopped) return stopped;
          // Which track comes is the player's to say, a moment later: asked for, not seen.
          return (await host.musicControl("next")) ? done(t("Next track"), false) : failed(t("That did not change"), "The player did not take it.");
        },
      }),
      capability({
        name: "previous_track",
        area: AREA,
        description: "Goes back to the previous track, or to the start of this one.",
        args: {},
        tier: "free",
        available,
        async run() {
          const stopped = refusedNow();
          if (stopped) return stopped;
          return (await host.musicControl("previous")) ? done(t("Previous track"), false) : failed(t("That did not change"), "The player did not take it.");
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
        description: "Sets the music player's volume, from 0 to 100. Not for muting Coucou, nor for the volume of Coucou's own sounds and Mochi's voice: those are the settings Sound effects and Sound volume.",
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
