// What Windows' recogniser can hear after the wake phrase. It only ever
// matches sentences it was given, so the sentences are written here, next to
// the parser that must understand every one of them (tests/voice-intent.test.mjs
// checks that it does). `{pill}` and `{workspace}` stand for any way of saying
// a pill; Rust builds one grammar rule per slot (src-tauri/src/voice/sapi.rs).
//
// A recogniser that hears free text needs none of this: it gets the parser alone.

import type { PillDefinition } from "../core/pills";
import { spokenForms } from "./entity";

export interface VoiceGrammar {
  commands: string[];
  slots: Record<string, string[]>;
}

const MUSIC = [
  "play", "play music", "play some music", "play spotify", "resume", "resume music",
  "open spotify", "launch spotify",
  "pause", "pause music", "stop", "stop the music",
  "next", "next track", "next song", "skip",
  "previous", "previous track", "previous song",
  "shuffle", "shuffle on", "shuffle off", "repeat", "repeat on", "repeat off",
];

const PILLS = [
  "add {pill}", "show {pill}", "enable {pill}",
  "add {pill} and {pill}", "show {pill} and {pill}",
  "remove {pill}", "hide {pill}", "disable {pill}",
  "remove {pill} and {pill}", "hide {pill} and {pill}",
  "replace {pill} with {pill}", "swap {pill} for {pill}",
  "keep only {pill}", "keep only {pill} and {pill}", "keep only {pill} and {pill} and {pill}",
];

const MAIN_PILL = ["switch to {workspace}", "use {workspace}", "set main to {workspace}"];

/** The answer to "which one do I remove?" is a pill's name and nothing else. */
const ANSWER = ["{pill}"];

const CANCEL = ["never mind", "cancel", "forget it"];

export function buildGrammar(pills: readonly PillDefinition[]): VoiceGrammar {
  const said = (list: readonly PillDefinition[]) => [...new Set(list.flatMap(spokenForms))];
  return {
    commands: [...MUSIC, ...PILLS, ...MAIN_PILL, ...ANSWER, ...CANCEL],
    slots: {
      pill: said(pills),
      workspace: said(pills.filter((p) => p.category === "workspace")),
    },
  };
}

/**
 * Sentences a command can be heard as: every value in its first slot, the
 * first values in the others — enough to check each command and each name
 * without the millions of combinations.
 */
export function sentences(command: string, slots: Record<string, string[]>): string[] {
  const names = [...command.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  if (!names.length) return [command];
  return (slots[names[0]] ?? []).map((first) => {
    let n = 0;
    return command.replace(/\{(\w+)\}/g, (_, name: string) => {
      const values = slots[name] ?? [];
      const value = n === 0 ? first : values[n % values.length];
      n += 1;
      return value;
    });
  });
}
