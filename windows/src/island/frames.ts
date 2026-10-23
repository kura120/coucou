// Which frames of the island's loop are drawn.
//
// While anything moves quickly (the island growing or shrinking, Peika
// travelling, the greeting, the drop sequence, a view's ticker, a tween, a mouse
// follow) every animation frame is drawn, at the screen's rate. While the only
// thing moving is a slow loop (the breathing of the sleeping Peika, its z's, the
// sweat of a rate limit) the loop still ticks, but a frame is drawn only about
// every 1/30 s: the loop would otherwise run at 60 to 144 Hz for as long as the
// island is on screen and Peika sleeps. The skipped frames cost almost nothing,
// and `dt` is measured from the last frame that was drawn, so speed is unchanged.
//
// Upstream's cap on the Mac app (Mochi at 60 fps on ProMotion) was taken back
// for a reason that does not apply here: its author wanted to judge the
// smoothness at the full rate first, and it capped everything, motion included.
// This one never caps anything quick, and only loops that are slow by nature.

/** Target frame rate of a slow loop. */
export const SLOW_FPS = 30;

/** Time between two drawn frames of a slow loop, ms. */
export const SLOW_FRAME_MS = 1000 / SLOW_FPS;

/**
 * Animation frames come at the display's rate with a little jitter; a frame that
 * arrives this much early still counts as due, so that a 60 Hz screen draws every
 * second frame (33.3 ms apart, not every third because one came at 33.1).
 */
export const FRAME_JITTER_MS = 2;

/** A timer may fire late; the frame is asked this much ahead of when it is due. */
export const TIMER_LEAD_MS = 8;

/** Everything that can need the full rate. */
export interface Motion {
  /** The island's width, height or corner radius is still settling. */
  geometry: boolean;
  /** Peika's position or size is still settling. */
  bot: boolean;
  /** The launch greeting is on. */
  greeting: boolean;
  /** The drop sequence is on. */
  upload: boolean;
  /** The current view's ticker asked for more frames. */
  view: boolean;
  /** A little Peika bounces, scans or dances (`miniBotsFast`); the rest of what they do is slow. */
  miniBots: boolean;
  /** Peika's engine moves with more than a slow loop (`BotEngine.fastMotion`). */
  engine: boolean;
  /** Something just changed (a state update, an event): draw it at once. */
  wake: boolean;
}

/** True when only a slow loop is moving, so the cap applies. */
export function slowLoopOnly(m: Motion): boolean {
  return !(
    m.geometry || m.bot || m.greeting || m.upload || m.view || m.miniBots || m.engine || m.wake
  );
}

/**
 * How long to wait before asking for the next animation frame: while a slow loop
 * is all that moves, a timer sleeps through the frames that would be skipped, so
 * the page is not woken at the display's rate (up to 240 Hz and more) to do nothing.
 * It ends a little early to land on the vsync before the one that is due. 0 = ask
 * now, as for anything quick.
 */
export function frameDelay(m: Motion, sinceDrawnMs: number): number {
  if (!slowLoopOnly(m)) return 0;
  return Math.max(0, SLOW_FRAME_MS - sinceDrawnMs - TIMER_LEAD_MS);
}

/** Whether to draw this animation frame, `sinceDrawnMs` after the last one drawn. */
export function shouldDraw(m: Motion, sinceDrawnMs: number): boolean {
  if (!slowLoopOnly(m)) return true;
  return sinceDrawnMs >= SLOW_FRAME_MS - FRAME_JITTER_MS;
}
