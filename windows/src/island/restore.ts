// Where the island was — the rules behind "it comes back where you left it".
// No DOM, no Tauri: island.ts asks, state.ts remembers.
//
// A place is a view one stays in: the overview, the chat, the settings. A card
// comes over a place and goes: a permission, a question, a finished session,
// an error. Closing the island and opening it again shows the last place; a
// card that came up over an open island gives the place back when it is done.

import type { IslandViewName } from "../core/layout";

const PLACES: ReadonlySet<IslandViewName> = new Set(["overview", "empty", "prompt", "settings"]);
const CARDS: ReadonlySet<IslandViewName> = new Set(["approval", "question", "finished", "error"]);

export function isPlace(view: IslandViewName): boolean {
  return PLACES.has(view);
}

export function isCard(view: IslandViewName): boolean {
  return CARDS.has(view);
}

/**
 * Whether the card on screen took the place of something the user was looking
 * at, as the view goes from `current` to `next`. `wasOpen` is the island
 * before the change; `was` is the answer so far.
 */
export function interruptedAfter(
  was: boolean,
  next: IslandViewName,
  current: IslandViewName,
  wasOpen: boolean,
): boolean {
  // Any other view ends it: the user moved on, or was taken back.
  if (!isCard(next)) return false;
  // A card over a card keeps what the first one took.
  if (wasOpen) return isCard(current) ? was : true;
  // A folded card opened again is still the card that interrupted; a card
  // that opens a closed island interrupted nothing.
  return next === current ? was : false;
}
