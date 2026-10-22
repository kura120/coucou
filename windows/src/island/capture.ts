// The screen capture (`capture-taken`, from the Rust side once the user has
// selected part of the screen): Peika swallows the picture the way he swallows a
// dropped file, and the capture card opens on it. Port of ScreenCapture on the
// Mac. Nothing is captured here, and nothing leaves the computer unless the user
// chooses Ask (the picture then goes to a fresh chat, as a dropped file does).

import { Bridge, onEvent } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { State } from "../core/state";

/** The picture as Rust sends it (core/state.ts `capture`). */
type Shot = NonNullable<typeof State.capture>;

/** What the capture needs from the island. */
export interface CaptureHost {
  alert(view: IslandViewName): void;
  setView(view: IslandViewName): void;
  collapse(): void;
  /** Peika gulps the picture down, as he does a dropped file. */
  gulpCapture(): void;
}

/** A new capture replaces the one on the card; the old picture's file goes. */
export function takeCapture(host: CaptureHost, shot: Shot): void {
  // Paused, the island shows nothing: the picture is not kept either.
  if (State.paused) {
    void Bridge.captureDiscard(shot.path);
    return;
  }
  const previous = State.capture;
  if (previous && previous.path !== shot.path) void Bridge.captureDiscard(previous.path);
  State.capture = shot;
  host.gulpCapture();
  host.alert("capture");
}

/** Paste: the picture goes into the window that was in front, then the island folds and the file is done with. */
export async function pasteCapture(host: CaptureHost): Promise<void> {
  const shot = State.capture;
  if (!shot) return;
  State.capture = null;
  // The paste is asked for first; the fold does not wait for it.
  const pasting = Bridge.capturePaste(shot.path);
  host.collapse();
  await pasting;
  await Bridge.captureDiscard(shot.path);
}

/** Ask: the picture goes to a fresh chat, exactly as a dropped file does. Its file is kept: the chat reads it. */
export function askAboutCapture(host: CaptureHost): void {
  const shot = State.capture;
  if (!shot) return;
  const name = shot.path.split(/[\\/]/).pop() || "file";
  State.capture = null;
  State.droppedFile = { name, path: shot.path };
  State.promptContext = { kind: "file", name, path: shot.path };
  State.chatHistory = [];
  void Bridge.chatReset();
  host.setView("prompt");
}

/** The ✕: the picture is thrown away and the island goes back to what it shows by default. */
export function closeCapture(host: CaptureHost): void {
  const shot = State.capture;
  if (!shot) return;
  State.capture = null;
  void Bridge.captureDiscard(shot.path);
  host.setView(State.defaultView());
}

export function registerCaptureHandlers(host: CaptureHost): void {
  void onEvent<Shot>("capture-taken", (shot) => takeCapture(host, shot));
}
