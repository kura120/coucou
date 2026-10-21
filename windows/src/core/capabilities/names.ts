// The names the user confirmed: what the words heard were, and the thing they
// were. When Peika asked "Did you mean Stripe?" and the user said yes (or
// picked it), "strife" is Stripe from then on, and the same words resolve
// surely with no question. Put back right after, it is forgotten (registry.ts).
//
// Only the user's own confirmed answers are kept, in memory only: nothing is
// written to disk, and no list of words is kept here. The matching stays the
// matcher's (match.ts).

import { normalise } from "../../voice/entity";
import { SPAN_WORDS } from "./match";

/** A name the user confirmed: the words it was heard as, and the thing it is. */
export interface LearnedName {
  heard: string;
  kind: string;
  id: string;
  label: string;
  /** How many times the user confirmed it. */
  confirmed: number;
  /** When it was last confirmed. */
  at: number;
}

export interface LearnedNames {
  /** The words learned for this thing, as written forms of it. */
  forms(kind: string, id: string): readonly string[];
  /** The thing these words were learned for, if any (compared normalised). */
  find(kind: string, heard: string): LearnedName | undefined;
  learn(kind: string, heard: string, id: string, label: string): void;
  forget(kind: string, heard: string): void;
  list(): readonly LearnedName[];
}

/** WisprFlow sends up to 200 dictionary words per dictation: no more are kept. */
const MOST_LEARNED = 200;

export function createLearnedNames(options: { most?: number; now?: () => number; initial?: readonly LearnedName[] } = {}): LearnedNames {
  const most = options.most ?? MOST_LEARNED;
  const now = options.now ?? Date.now;
  const entries = new Map<string, LearnedName>();
  const key = (kind: string, heard: string) => `${kind}\u0000${normalise(heard)}`;
  // A name is one to three words, never a sentence.
  const fits = (words: string) => words !== "" && words.split(" ").length <= SPAN_WORDS;

  /** Past `most`, the one confirmed longest ago goes. */
  const trim = () => {
    while (entries.size > most) {
      let oldest: [string, LearnedName] | undefined;
      for (const pair of entries) if (!oldest || pair[1].at < oldest[1].at) oldest = pair;
      entries.delete(oldest![0]);
    }
  };

  const learn = (kind: string, heard: string, id: string, label: string) => {
    const words = normalise(heard);
    if (!fits(words)) return;
    const prior = entries.get(key(kind, words));
    entries.set(key(kind, words), { heard: words, kind, id, label, confirmed: (prior?.confirmed ?? 0) + 1, at: now() });
    trim();
  };

  // Kept as they were confirmed: their counts and times.
  for (const entry of options.initial ?? []) {
    const words = normalise(entry.heard);
    if (fits(words)) entries.set(key(entry.kind, words), { ...entry, heard: words });
  }
  trim();

  return {
    forms: (kind, id) => [...entries.values()].filter((entry) => entry.kind === kind && entry.id === id).map((entry) => entry.heard),
    find: (kind, heard) => entries.get(key(kind, heard)),
    learn,
    forget: (kind, heard) => {
      entries.delete(key(kind, heard));
    },
    list: () => [...entries.values()],
  };
}
