// A call's arguments against the capability's `ArgSpec`s. A model writes what
// it likes: a number as "50", a boolean as "on", one name where a list is
// wanted, arguments nobody declared. What can be read as the declared type is;
// what cannot is said plainly, for the model to try again. An `entity` is
// only made a string here — which thing it names is the executor's to resolve.

import type { ArgSpec, Args } from "./types";

export type Checked = { ok: true; args: Args } | { ok: false; wrong: string };

/**
 * How a boolean is written in JSON by a model that got the type wrong. A data
 * format, as "50" is for a number: nothing a person says is read here.
 */
const WRITTEN_TRUE = ["true", "on", "yes", "1"];
const WRITTEN_FALSE = ["false", "off", "no", "0"];

const absent = (value: unknown) => value === undefined || value === null || (typeof value === "string" && !value.trim());

/** The arguments as declared, coerced; the ones nobody declared are left out. */
export function check(specs: Readonly<Record<string, ArgSpec>>, given: unknown): Checked {
  let from: unknown = given ?? {};
  // Some servers hand the arguments over as the JSON text the model wrote.
  if (typeof from === "string") {
    try {
      from = from.trim() ? JSON.parse(from) : {};
    } catch {
      return { ok: false, wrong: "The arguments are not valid JSON." };
    }
  }
  if (typeof from !== "object" || from === null || Array.isArray(from)) return { ok: false, wrong: "The arguments must be an object." };

  const args: Args = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = (from as Args)[name];
    const none = absent(value) || (spec.type === "entities" && Array.isArray(value) && !value.filter((v) => !absent(v)).length);
    if (none) {
      if (!spec.optional) return { ok: false, wrong: `"${name}" is required: ${spec.description}` };
      continue;
    }
    const read = coerce(spec, value);
    if ("wrong" in read) return { ok: false, wrong: `"${name}" ${read.wrong}` };
    args[name] = read.value;
  }
  return { ok: true, args };
}

function coerce(spec: ArgSpec, value: unknown): { value: unknown } | { wrong: string } {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return { wrong: "must be a string." };
      const text = String(value);
      if (spec.enum) {
        const one = spec.enum.find((option) => option === text) ?? only(spec.enum.filter((option) => option.toLowerCase() === text.trim().toLowerCase()));
        return one === undefined ? { wrong: `must be one of: ${spec.enum.join(", ")}.` } : { value: one };
      }
      if (spec.maxLength !== undefined && [...text].length > spec.maxLength) return { wrong: `must be at most ${spec.maxLength} characters.` };
      return { value: text };
    }
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? written(value) : NaN;
      if (!Number.isFinite(n)) return { wrong: "must be a number." };
      if (spec.min !== undefined && n < spec.min) return { wrong: `must be at least ${spec.min}.` };
      if (spec.max !== undefined && n > spec.max) return { wrong: `must be at most ${spec.max}.` };
      return { value: n };
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      const text = String(typeof value === "number" || typeof value === "string" ? value : "").trim().toLowerCase();
      if (WRITTEN_TRUE.includes(text)) return { value: true };
      if (WRITTEN_FALSE.includes(text)) return { value: false };
      return { wrong: "must be true or false." };
    }
    case "entity": {
      const name = named(value);
      return name === null ? { wrong: `must be the name or id of one ${spec.kind}.` } : { value: name };
    }
    case "entities": {
      // One name where a list is wanted is a list of one.
      const names = (Array.isArray(value) ? value : [value]).filter((v) => !absent(v)).map(named);
      if (names.some((name) => name === null)) return { wrong: `must be a list of ${spec.kind} names or ids.` };
      return { value: names };
    }
  }
}

const only = <T>(list: readonly T[]) => (list.length === 1 ? list[0] : undefined);

const named = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : null);

/** A number as a model writes it in a string: "50", "0,5", "50%", " 12 ". */
function written(text: string): number {
  const digits = text.trim().replace(/\s*%$/, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(digits) ? Number(digits) : NaN;
}
