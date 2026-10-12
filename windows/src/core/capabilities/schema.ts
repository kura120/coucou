// A capability as a tool a model can call: the OpenAI function format, whose
// `parameters` is the JSON Schema an MCP tool takes as it is. Only what was
// declared is in it — never the tier, the guard or how the app does it.

import type { ArgSpec, Capability } from "./types";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: false };
  };
}

export function schemaOf(capability: Capability): ToolSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(capability.args)) {
    properties[name] = property(spec);
    if (!spec.optional) required.push(name);
  }
  return {
    type: "function",
    function: { name: capability.name, description: capability.description, parameters: { type: "object", properties, required, additionalProperties: false } },
  };
}

/** What a model is told of an argument that names a thing: its kind, and that a name will do. */
const naming = (kind: string) => `A ${kind}: its name or its id.`;

function property(spec: ArgSpec): Record<string, unknown> {
  switch (spec.type) {
    case "string":
      return {
        type: "string",
        description: spec.description,
        ...(spec.enum ? { enum: [...spec.enum] } : {}),
        ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
      };
    case "number":
      return {
        type: "number",
        description: spec.description,
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
      };
    case "boolean":
      return { type: "boolean", description: spec.description };
    case "entity":
      return { type: "string", description: `${spec.description} ${naming(spec.kind)}` };
    case "entities":
      return {
        type: "array",
        description: spec.description,
        items: { type: "string", description: naming(spec.kind) },
        ...(spec.max !== undefined ? { maxItems: spec.max } : {}),
      };
  }
}
