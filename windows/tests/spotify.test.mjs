// The Spotify pill and Mochi's dance: the page's rules in
// src/core/spotify.ts, the dance in src/mochi/engine.ts, the report handling in
// src/island/spotify.ts and the views in src/views/spotify.ts. The MPRIS side —
// metadata, position, the bus itself — is tested in src-tauri/src/spotify.rs.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { emit, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import {
  IDLE_SPOTIFY, SPOTIFY_ID, Spotify, currentArtwork, desktopDances, formatTime, isAd, islandDances,
  marquee, musicCardShown, musicPlaying, nowPlayingLine, spotifyPosition, volumeLevel, withPlaying,
} from "../src/core/spotify.ts";
import { EXPANDED_W, MUSIC_CARD_GAP, MUSIC_CARD_W, PANEL_W, islandSize, nowPlayingRoom } from "../src/core/layout.ts";
import { createMarquee } from "../src/views/marquee.ts";
import { BotEngine, danceTransform, hexToRGB, stepBodyColor, stepDanceLevel } from "../src/mochi/engine.ts";
import { registerSpotifyHandlers } from "../src/island/spotify.ts";
import { buildSpotifyCard, buildSpotifyMini, musicAppBadge } from "../src/views/spotify.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { lookup, setLanguage } from "../src/i18n/i18n.ts";

installFakeDom();

const track = (over = {}) => ({
  id: "spotify:track:abc", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories",
  duration: 180, artUrl: "https://i.scdn.co/image/abc", ...over,
});

const playing = (over = {}) => ({
  ...IDLE_SPOTIFY, running: true, installed: true, track: track(), playing: true,
  position: 10, positionAt: 1_000, volume: 70, ...over,
});

// ── Position ──────────────────────────────────────────────────────────────────

test("the position runs on from its timestamp while playing, and stops at the end", () => {
  const s = playing();
  assert.equal(spotifyPosition(s, 1_000), 10);
  assert.equal(spotifyPosition(s, 3_500), 12.5);
  assert.equal(spotifyPosition(s, 0), 10, "a clock behind the anchor never moves it back");
  assert.equal(spotifyPosition(s, 1_000_000), 180, "capped at the track's length");
  assert.equal(spotifyPosition({ ...s, playing: false }, 60_000), 10, "paused, it stays put");
  assert.equal(spotifyPosition({ ...s, track: null }, 3_000), 12, "no length, no cap");
});

test("a play/pause click freezes or restarts the clock where it is", () => {
  const paused = withPlaying(playing(), false, 5_000);
  assert.equal(paused.playing, false);
  assert.equal(paused.position, 14);
  assert.equal(paused.positionAt, 5_000);
  assert.equal(spotifyPosition(paused, 9_000), 14);
  const again = withPlaying(paused, true, 9_000);
  assert.equal(spotifyPosition(again, 10_000), 15);
  const same = playing();
  assert.equal(withPlaying(same, true, 99), same, "no change, same object");
});

test("times read like the Mac's player", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(599), "9:59");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(-3), "0:00");
  assert.equal(formatTime(Number.NaN), "0:00");
});

test("the volume icon has the Mac's thresholds", () => {
  assert.deepEqual([0, 1, 33, 34, 66, 67, 100].map(volumeLevel), [0, 1, 1, 2, 2, 3, 3]);
});

test("ads are told by their id", () => {
  assert.ok(isAd(track({ id: "spotify:ad:123" })));
  assert.ok(!isAd(track()));
  assert.ok(!isAd(null));
});

test("a cover shows only on the track it belongs to", () => {
  Spotify.artwork = { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/jpeg;base64,AA" };
  assert.equal(currentArtwork(playing()), "data:image/jpeg;base64,AA");
  assert.equal(currentArtwork(playing({ track: track({ artUrl: "https://i.scdn.co/image/zzz" }) })), null);
  assert.equal(currentArtwork(playing({ track: null })), null);
  Spotify.artwork = null;
});

// ── When Mochi dances ─────────────────────────────────────────────────────────

test("music counts only when it plays on a declared Spotify pill", () => {
  assert.ok(musicPlaying(playing(), [SPOTIFY_ID]));
  assert.ok(!musicPlaying(playing(), ["integration_n8n"]));
  assert.ok(!musicPlaying(playing({ playing: false }), [SPOTIFY_ID]));
  assert.ok(!musicPlaying(playing({ track: null }), [SPOTIFY_ID]));
});

test("the island's Mochi dances by the Mac's rules", () => {
  const base = { music: true, state: "idle", mode: "compact", view: "overview", focusId: "integration_claude" };
  // Compact: whenever music plays, in the calm and busy states.
  for (const state of ["idle", "working", "thinking", "searching", "finished"]) {
    assert.ok(islandDances({ ...base, state }), state);
  }
  // An alert, an error, sleep or a daze win.
  for (const state of ["approval", "question", "error", "ratelimit", "sleeping", "dizzy"]) {
    assert.ok(!islandDances({ ...base, state }), state);
  }
  assert.ok(!islandDances({ ...base, music: false }));
  assert.ok(!islandDances({ ...base, mode: "hidden" }));
  // Expanded: only on the overview, with the music pill in front.
  assert.ok(!islandDances({ ...base, mode: "expanded" }));
  assert.ok(islandDances({ ...base, mode: "expanded", focusId: SPOTIFY_ID }));
  assert.ok(!islandDances({ ...base, mode: "expanded", focusId: SPOTIFY_ID, view: "prompt" }));
});

test("Mochi on the desktop dances by the compact island's rules", () => {
  assert.ok(desktopDances(true, "working"));
  assert.ok(!desktopDances(true, "approval"));
  assert.ok(!desktopDances(false, "idle"));
});

// ── The dance itself (BotEngine.applyDance) ───────────────────────────────────

test("the dance fades in over 0.3 s and out over 0.5 s", () => {
  assert.equal(stepDanceLevel(0, true, 0.15), 0.5);
  assert.equal(stepDanceLevel(0.9, true, 0.15), 1);
  assert.equal(stepDanceLevel(1, false, 0.25), 0.5);
  assert.equal(stepDanceLevel(0.1, false, 0.25), 0);
  assert.equal(stepDanceLevel(1, true, 0.05), 1);
});

test("112 BPM: still on the beat, highest half a beat later, nothing at level 0", () => {
  const R = 10;
  const onBeat = danceTransform(0, 1, R);
  assert.equal(onBeat.dx, 0);
  assert.equal(onBeat.dy, -0);
  assert.equal(onBeat.rotate, 0);
  assert.ok(Math.abs(onBeat.sx - 1.045) < 1e-9 && Math.abs(onBeat.sy - 0.94) < 1e-9, "squashed on landing");
  const top = danceTransform(0.5 * 60 / 112, 1, R);
  assert.ok(Math.abs(top.dy + 2) < 1e-9, "hops 0.2 R");
  assert.ok(Math.abs(top.dx - 0.8) < 1e-9 && Math.abs(top.rotate - 0.1) < 1e-9);
  assert.ok(Math.abs(top.sx - 1) < 1e-9 && Math.abs(top.sy - 1) < 1e-9);
  const off = danceTransform(0.3, 0, R);
  assert.deepEqual([off.dx, off.dy, off.rotate, off.sx, off.sy].map((v) => Math.abs(v)), [0, 0, 0, 1, 1]);
});

test("Mochi changes colour over a moment when another pill comes to the front", () => {
  const green = hexToRGB("#1DB954");
  const red = hexToRGB("#F4505E");
  // Already there: nothing to do.
  assert.equal(stepBodyColor(green, green, 0.016), green);
  assert.equal(stepBodyColor(null, null, 0.016), null);
  // On his way: between the two, nearer the target frame after frame.
  let c = stepBodyColor(green, red, 0.016);
  assert.ok(c[0] > green[0] && c[0] < red[0]);
  for (let i = 0; i < 40 && c !== red; i++) c = stepBodyColor(c, red, 0.016);
  assert.equal(c, red, "and there within the moment");
  // To his own white and back: through white, then exactly his own again.
  c = stepBodyColor(red, null, 0.016);
  assert.ok(c !== null && c[1] > red[1]);
  for (let i = 0; i < 40 && c !== null; i++) c = stepBodyColor(c, null, 0.016);
  assert.equal(c, null);
  assert.ok(stepBodyColor(null, green, 0.016)[0] < 0.93);
  // A frame as long as the whole blend lands on the target.
  assert.equal(stepBodyColor(green, red, 1), red);
});

test("the engine dances only once asked, and keeps its frames going meanwhile", () => {
  const ops = [];
  const ctx = {
    translate: (x, y) => ops.push(["translate", x, y]),
    rotate: (a) => ops.push(["rotate", a]),
    scale: (x, y) => ops.push(["scale", x, y]),
  };
  const engine = new BotEngine();
  engine.applyDance(ctx, 100, 100);
  assert.deepEqual(ops, [], "not dancing: the context is left alone");
  engine.setDancing(true);
  engine.update(0.05);
  assert.ok(engine.dancingLevel > 0 && engine.busy);
  engine.applyDance(ctx, 100, 100);
  assert.deepEqual(ops.map((o) => o[0]), ["translate", "rotate", "scale", "translate"]);
  // Around the bottom of the body: back where it started.
  assert.equal(ops[3][1], -(50 + engine.ox * 30));
  engine.setDancing(false);
  for (let i = 0; i < 20; i++) engine.update(0.05);
  assert.equal(engine.dancingLevel, 0);
});

// ── Reports from Rust ─────────────────────────────────────────────────────────

const island = { reveals: 0, revealSilently() { this.reveals += 1; } };
registerSpotifyHandlers(island);

beforeEach(() => {
  setLanguage("en");
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [SPOTIFY_ID] };
  State.os = "linux";
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.loadIntegrationTasks();
  Spotify.state = { ...IDLE_SPOTIFY };
  Spotify.artwork = null;
  island.reveals = 0;
});

const spotifyTask = () => State.tasks.find((t) => t.id === SPOTIFY_ID);

test("the pill wears the track's title, and its own name when nothing plays", () => {
  assert.equal(spotifyTask().name, "Spotify");
  emit("spotify", playing());
  assert.equal(Spotify.state.track.title, "Get Lucky");
  assert.equal(spotifyTask().name, "Get Lucky");
  emit("spotify", playing({ track: track({ id: "spotify:ad:1", title: "" }) }));
  assert.equal(spotifyTask().name, "Advertisement");
  emit("spotify", { ...IDLE_SPOTIFY, running: true });
  assert.equal(spotifyTask().name, "Spotify");
});

test("music starting shows the hidden island once, silently; nothing when the pill is not declared", () => {
  emit("spotify", playing({ playing: false }));
  assert.equal(island.reveals, 0);
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  emit("spotify", playing({ position: 30 }));
  assert.equal(island.reveals, 1, "only on not playing → playing");
  assert.ok(State.spotifyPlaying);

  // Not declared: nothing dances, nothing shows.
  emit("spotify", { ...IDLE_SPOTIFY });
  State.settings.activeIntegrations = [];
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  assert.ok(!State.spotifyPlaying);
});

test("the cover arrives on its own event", () => {
  emit("spotify", playing());
  emit("spotify-artwork", { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/png;base64,AA" });
  assert.equal(currentArtwork(), "data:image/png;base64,AA");
});

test("the card reads the player again each time it comes on screen", () => {
  const before = sent("spotify_refresh").length;
  State.mode = "expanded";
  State.view = "overview";
  State.setFocus(SPOTIFY_ID);
  assert.equal(sent("spotify_refresh").length, before + 1);
  State.notify();
  assert.equal(sent("spotify_refresh").length, before + 1, "not again while it stays");
  State.mode = "compact";
  State.notify();
  State.mode = "expanded";
  State.notify();
  assert.equal(sent("spotify_refresh").length, before + 2);
});

// ── Views ─────────────────────────────────────────────────────────────────────

test("the idle card: not playing, or not installed with a way to get it", () => {
  const card = buildSpotifyCard();
  Spotify.state = { ...IDLE_SPOTIFY, installed: true };
  card.sync();
  assert.match(card.el.textContent, /Spotify.*Integration.*Not playing.*Open Spotify/);
  Spotify.state = { ...IDLE_SPOTIFY };
  card.sync();
  assert.match(card.el.textContent, /Spotify not installed.*Get Spotify/);
  card.el.find("BUTTON")[0].fire("click");
  assert.ok(sent("spotify_open").length > 0);

  setLanguage("fr");
  card.sync();
  assert.ok(card.el.textContent.includes(lookup("Get Spotify", "fr")));
});

test("the playing card: title, artist · album, times, and the controls", () => {
  const card = buildSpotifyCard();
  Spotify.state = playing({ playing: false, shuffle: true });
  card.sync();
  const text = card.el.textContent;
  assert.ok(text.includes("Get Lucky"));
  assert.ok(text.includes("Daft Punk · Random Access Memories"));
  assert.ok(text.includes("0:10") && text.includes("-2:50"));

  const [shuffle, prev, play, next, repeat] = card.el.querySelector("np-buttons").children;
  assert.equal(shuffle.title, "Shuffle on");
  assert.equal(repeat.title, "Repeat off");
  assert.equal(play.title, "Play");
  const before = sent("spotify_control").length;
  shuffle.fire("click");
  repeat.fire("click");
  prev.fire("click");
  next.fire("click");
  play.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [
    { action: "shuffle", value: 0 },
    { action: "repeat", value: 1 },
    { action: "previous", value: null },
    { action: "next", value: null },
    { action: "playPause", value: null },
  ]);
  // The page shows the clicks at once.
  assert.equal(Spotify.state.shuffle, false);
  assert.equal(Spotify.state.repeat, true);
  assert.equal(Spotify.state.playing, true);

  Spotify.state = playing({ track: track({ id: "spotify:ad:9", title: "x", artist: "", album: "" }) });
  card.sync();
  assert.ok(card.el.textContent.includes("Advertisement"));
});

// ── The compact island's line ────────────────────────────────────────────────

test("the compact island says the title and the artist on one line", () => {
  assert.equal(nowPlayingLine(track(), "Advertisement"), "Get Lucky — Daft Punk");
  assert.equal(nowPlayingLine(track({ artist: "" }), "Advertisement"), "Get Lucky");
  assert.equal(nowPlayingLine(track({ artist: "  " }), "Advertisement"), "Get Lucky");
  assert.equal(nowPlayingLine(track({ id: "spotify:ad:1", title: "x" }), "Advertisement"), "Advertisement");
  assert.equal(nowPlayingLine(null, "Advertisement"), "");
});

test("a line that fits stays still; a longer one passes at reading speed", () => {
  assert.equal(marquee(120, 163), null);
  assert.equal(marquee(163, 163), null);
  // One pass goes the line's width and the gap after it.
  assert.deepEqual(marquee(224, 163), { distance: 260, seconds: 10 });
  assert.ok(marquee(600, 163).seconds > marquee(224, 163).seconds);
  // Not laid out yet: nothing to scroll.
  assert.equal(marquee(0, 163), null);
  assert.equal(marquee(300, 0), null);
  assert.equal(marquee(NaN, 163), null);
});

test("the compact island's line has the room between Mochi and the little Mochis", () => {
  // The compact island's own width, whatever the island is drawn at meanwhile.
  assert.deepEqual(nowPlayingRoom(2), { left: 60, width: 165 });
  // A third column of little Mochis takes its width from the line.
  assert.deepEqual(nowPlayingRoom(3), { left: 60, width: 149 });
});

test("a line passes through its place only when it is too long for it", () => {
  const line = createMarquee("np-title");
  const spans = () => line.el.find("SPAN");
  const widen = (px) => (spans()[0].offsetWidth = px);

  line.set("Get Lucky");
  assert.deepEqual(spans().map((s) => s.textContent), ["Get Lucky"]);
  // Not laid out yet: nothing is decided, and it is asked again.
  line.fit(165);
  assert.ok(!line.el.classList.contains("scroll"));
  // It fits: one copy, still.
  widen(80);
  line.fit(165);
  assert.ok(!line.el.classList.contains("scroll"));
  assert.equal(spans().length, 1);

  // A longer one: a second copy follows the first, and it passes.
  line.set("A very long title that goes on and on — and its artist");
  widen(320);
  line.fit(165);
  assert.ok(line.el.classList.contains("scroll"));
  assert.equal(spans().length, 2);
  assert.equal(spans()[1].getAttribute("aria-hidden"), "true");
  const run = line.el.find(".marquee-run")[0];
  assert.equal(run.style["--mq-distance"], "-356px");
  assert.equal(run.style["--mq-seconds"], "13.7s");

  // Asked again for the same line and room: nothing is rebuilt.
  const first = spans()[0];
  line.set("A very long title that goes on and on — and its artist");
  line.fit(165);
  assert.equal(spans()[0], first);
  // Less room (a third column of little Mochis): placed again for it.
  line.fit(400);
  assert.ok(!line.el.classList.contains("scroll"));
  assert.equal(spans().length, 1);
  // A new line starts still.
  line.set("Short");
  assert.ok(!line.el.classList.contains("scroll"));
  assert.deepEqual(spans().map((s) => s.textContent), ["Short"]);
});

// ── The music card ────────────────────────────────────────────────────────────

test("the music card shows while Spotify has a track on a declared pill that is not in front", () => {
  const declared = [SPOTIFY_ID];
  assert.ok(musicCardShown(playing(), declared, "integration_claude"));
  // Paused too: a pause can be undone from the card.
  assert.ok(musicCardShown(playing({ playing: false }), declared, "integration_claude"));
  // Nothing loaded, not declared, or Spotify in front with its own card up.
  assert.ok(!musicCardShown({ ...IDLE_SPOTIFY, running: true }, declared, "integration_claude"));
  assert.ok(!musicCardShown(playing(), [], "integration_claude"));
  assert.ok(!musicCardShown(playing(), declared, SPOTIFY_ID));
});

test("Spotify is never one of the pills; with a track its card is up and the overview widens", () => {
  const pills = () => State.shownPills.map((t) => t.id);
  // Declared, nothing loaded: no card, and no pill either.
  assert.ok(State.tasks.some((t) => t.id === SPOTIFY_ID));
  assert.ok(!State.musicCard);
  assert.ok(!pills().includes(SPOTIFY_ID));
  Spotify.state = playing();
  assert.ok(State.musicCard);
  assert.ok(!pills().includes(SPOTIFY_ID));
  // In front, Spotify has the left card: no second one.
  State.setFocus(SPOTIFY_ID);
  assert.ok(!State.musicCard);

  const wide = EXPANDED_W + MUSIC_CARD_W + MUSIC_CARD_GAP;
  assert.equal(islandSize("expanded", "overview", 0, false, 0, true).w, wide);
  assert.equal(islandSize("expanded", "overview", 0, false, 0, false).w, EXPANDED_W);
  // Only the overview has the card; no other view, and no closed island, grows for it.
  assert.equal(islandSize("expanded", "prompt", 0, false, 0, true).w, EXPANDED_W);
  assert.equal(islandSize("expanded", "approval", 0, false, 0, true).w, EXPANDED_W);
  assert.equal(islandSize("compact", "overview", 0, false, 0, true).w, islandSize("compact", "overview").w);
  // And the window has the room.
  assert.ok(wide < PANEL_W);
});

test("the music card: cover, title and artist, seek, and the five buttons", () => {
  let opened = 0;
  const mini = buildSpotifyMini(() => (opened += 1));
  State.mode = "expanded";
  Spotify.state = playing({ position: 45, positionAt: Date.now() });
  Spotify.artwork = { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/png;base64,AA" };
  mini.sync();
  assert.equal(mini.el.querySelector("np-title").textContent, "Get Lucky");
  assert.equal(mini.el.querySelector("np-sub").textContent, "Daft Punk");
  assert.equal(mini.el.find("IMG")[0].getAttribute("src"), "data:image/png;base64,AA");
  // A quarter of the way through.
  assert.match(mini.el.querySelector("np-mini-bar").find(".np-fill")[0].style.width, /^25(\.\d+)?%$/);

  // The app's mark sits in the card's last row, before the buttons, not by the title.
  const foot = mini.el.querySelector("np-mini-foot");
  assert.equal(foot.children[0].getAttribute("title"), "Spotify");
  assert.equal(foot.children[0].find("svg")[0].getAttribute("width"), "18");
  assert.equal(mini.el.querySelector("np-mini-head").find(".np-app").length, 0);

  const [shuffle, prev, play, next, repeat] = mini.el.querySelector("np-buttons").children;
  assert.equal(play.title, "Pause");
  assert.equal(shuffle.title, "Shuffle off");
  assert.equal(repeat.title, "Repeat off");
  const before = sent("spotify_control").length;
  shuffle.fire("click");
  repeat.fire("click");
  prev.fire("click");
  next.fire("click");
  play.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [
    { action: "shuffle", value: 1 },
    { action: "repeat", value: 1 },
    { action: "previous", value: null },
    { action: "next", value: null },
    { action: "playPause", value: null },
  ]);
  assert.equal(Spotify.state.playing, false, "shown at once");
  assert.ok(Spotify.state.shuffle && Spotify.state.repeat);
  mini.sync();
  assert.equal(play.title, "Play");
  // On, they are Spotify's green and say so; a second click turns them off.
  assert.equal(shuffle.title, "Shuffle on");
  assert.equal(repeat.title, "Repeat on");
  assert.equal(shuffle.style.color, "#1DB954");
  shuffle.fire("click");
  mini.sync();
  assert.equal(shuffle.title, "Shuffle off");
  assert.deepEqual(sent("spotify_control").at(-1), { action: "shuffle", value: 0 });

  // The cover and the names bring Spotify's own card to the front.
  mini.el.querySelector("np-mini-head").fire("click");
  assert.equal(opened, 1);
  // An ad has no title of its own, and no artist.
  Spotify.state = playing({ track: track({ id: "spotify:ad:9", title: "x", artist: "" }) });
  mini.sync();
  assert.equal(mini.el.querySelector("np-title").textContent, "Advertisement");
  assert.equal(mini.el.querySelector("np-sub").style.display, "none");
});

test("the player says which app the music comes from", () => {
  const badge = musicAppBadge();
  assert.equal(badge.getAttribute("title"), "Spotify");
  assert.equal(badge.find("svg").length, 1);
  // On Spotify's own card: before the title.
  Spotify.state = playing();
  const card = buildSpotifyCard();
  card.sync();
  const row = card.el.querySelector("np-title-row");
  assert.equal(row.children[0].getAttribute("title"), "Spotify");
  assert.equal(row.children[0].find("svg")[0].getAttribute("width"), "14");
  assert.ok(row.children[1].classList.contains("np-title"));
  // On the music card: larger, in the lower left corner.
  const mini = buildSpotifyMini(() => {});
  mini.sync();
  const mark = mini.el.querySelector("np-mini-foot").children[0];
  assert.equal(mark.getAttribute("title"), "Spotify");
  assert.equal(mark.find("svg")[0].getAttribute("width"), "18");
});

test("the card has no volume where Spotify's cannot be read", () => {
  const card = buildSpotifyCard();
  const volume = () => card.el.querySelector("np-volume");
  // Linux reads it over MPRIS: the slider is there, at Spotify's level.
  Spotify.state = playing({ volume: 30 });
  card.sync();
  assert.equal(volume().style.display, "");
  assert.equal(volume().title, "Volume 30%");
  // Windows is not told it: no slider, rather than one that says 100 %.
  Spotify.state = playing({ volume: 100, volumeKnown: false });
  card.sync();
  assert.equal(volume().style.display, "none");
  // The rest of the card is as it was.
  assert.equal(card.el.querySelector("np-buttons").children.length, 5);
  Spotify.state = playing({ volume: 30, volumeKnown: true });
  card.sync();
  assert.equal(volume().style.display, "");
});
