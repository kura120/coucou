// What names are compared by: a name without its accents and punctuation, a
// key of how it sounds, and how many letters apart two names are. Arithmetic
// on letters — no list of names, of words or of ways to say anything. Which
// thing a name is, among the things the app has, is decided with these in
// core/capabilities/match.ts.

/** Lowercase, no accents, no punctuation, single spaces (IntentParser.normalise). */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’-]/g, " ")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .join(" ");
}

/**
 * How a name sounds, roughly: its consonants, those a recogniser takes for
 * one another made the same. The keys of `sound` in voice/apps.rs.
 */
export function soundKey(text: string): string {
  const letters = [...normalise(text).replace(/ /g, "").replace(/th/g, "t").replace(/ph/g, "f").replace(/ck/g, "k").replace(/qu/g, "k").replace(/x/g, "ks")];
  let out = "";
  letters.forEach((c, i) => {
    const soft = "eiy".includes(letters[i + 1] ?? " ");
    let key = c;
    if ("aeiouyhw".includes(c)) {
      // Only where a name starts with one.
      if (i > 0) return;
      key = "a";
    } else if (c === "b" || c === "p") key = "p";
    else if (c === "d" || c === "t") key = "t";
    else if (c === "c" && soft) key = "s";
    else if ("cgkq".includes(c)) key = "k";
    else if (c === "f" || c === "v") key = "f";
    else if (c === "s" || c === "z") key = "s";
    else if (c === "m" || c === "n") key = "n";
    if (!out.endsWith(key)) out += key;
  });
  return out;
}

/** Wagner–Fischer, on characters. */
export function levenshtein(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  if (!ac.length) return bc.length;
  if (!bc.length) return ac.length;
  const row = Array.from({ length: bc.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ac.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= bc.length; j++) {
      const kept = row[j];
      row[j] = ac[i - 1] === bc[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = kept;
    }
  }
  return row[bc.length];
}
