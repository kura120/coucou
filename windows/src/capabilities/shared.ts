// What every area's file uses: how an area is handed over, how arguments are
// read, and the wrapper that keeps a capability from ever throwing.

import type { Args, Capability, EntitySource, ToolResult } from "../core/capabilities/types";
import { t } from "../i18n/i18n";
import { failed } from "../voice/result";

/** What one part of the app declares. */
export interface Area {
  capabilities: Capability[];
  sources: EntitySource[];
}

/**
 * A capability as it is declared. `run` never throws: what goes wrong in the
 * app comes back as a failure, with the error for the model.
 */
export function capability(declared: Capability): Capability {
  const { run } = declared;
  return {
    ...declared,
    async run(args, context): Promise<ToolResult> {
      try {
        return await run(args, context);
      } catch (error) {
        return failed(t("That did not work"), error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** An argument of type `entities`, as the ids the executor resolved; one id alone is a list of one. */
export const ids = (value: unknown): string[] =>
  [...new Set((Array.isArray(value) ? value : [value]).map(str).filter(Boolean))];

/** A text on one line, cut to size. */
export const cut = (text: string, most: number): string => {
  const line = text.split(/\s+/).filter(Boolean).join(" ");
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
};

/** An argument that names nothing the app has: the executor should have stopped it. */
export const unknownArgument = (args: Args, name: string): ToolResult =>
  failed(t("Not found: {0}", { 0: cut(str(args[name]) || name, 40) }), `Argument '${name}' does not name anything the app has.`);
