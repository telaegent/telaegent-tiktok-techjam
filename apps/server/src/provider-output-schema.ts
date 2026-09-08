import type { AgentProvider, JsonSchemaDocument } from "./runtime-contract.js";

/** Whether a subschema already offers null, so wrapping would only add noise. */
function permitsNull(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const node = schema as Record<string, unknown>;
  const type = node["type"];
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.some(permitsNull)) return true;
  }
  return false;
}

/** Widens a subschema to accept null without disturbing what it already says. */
function nullableSchema(schema: unknown): unknown {
  return permitsNull(schema) ? schema : { anyOf: [schema, { type: "null" }] };
}


/** Derive a detached schema for each CLI's supported Structured Outputs subset. */
export function providerCompatibleSchema(
  provider: AgentProvider,
  value: JsonSchemaDocument,
): JsonSchemaDocument {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== "object") return node;

    const converted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // Claude Code 2.1.x has no draft-2020-12 meta-schema. Codex releases
      // also vary here. The annotation is not needed to enforce constraints.
      if (key === "$schema") continue;
      // Codex Structured Outputs reliably supports enum across CLI/model
      // versions, while support for the equivalent JSON Schema `const`
      // keyword has varied. Preserve the exact constraint as a one-value enum.
      if (provider === "codex" && key === "const") {
        converted.enum = [visit(child)];
        continue;
      }
      converted[provider === "codex" && key === "oneOf" ? "anyOf" : key] =
        visit(child);
    }

    // OpenAI Structured Outputs requires every declared property to be
    // required. The strict local parser remains the final protocol authority.
    if (
      provider === "codex" &&
      converted.properties !== null &&
      typeof converted.properties === "object" &&
      !Array.isArray(converted.properties)
    ) {
      const properties = converted.properties as Record<string, unknown>;
      // Listing an optional property as required without also letting it be
      // null leaves the model no way to decline it, and it will not invent a
      // refusal -- it invents a value. That is not a hypothetical: with
      // `peerClarification` forced required, Codex attached a fabricated peer
      // question to every recipient turn, including the control case whose
      // whole point is that no question is warranted, and satisfied the
      // equally-forced `sharedBasisMessageIds` with an empty array. Both read
      // as the model behaving badly; both were this line.
      //
      // So an optional property stays present, as OpenAI demands, and becomes
      // nullable, which is how "none" is spelled when omission is unavailable.
      const declared = new Set(
        Array.isArray(converted.required)
          ? (converted.required as unknown[]).filter(
              (name): name is string => typeof name === "string",
            )
          : [],
      );
      for (const [name, schema] of Object.entries(properties)) {
        if (declared.has(name)) continue;
        properties[name] = nullableSchema(schema);
      }
      converted.required = Object.keys(properties);
    }
    return converted;
  };

  return visit(value) as JsonSchemaDocument;
}
