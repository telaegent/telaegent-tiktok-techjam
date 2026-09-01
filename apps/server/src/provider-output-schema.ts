import type { AgentProvider, JsonSchemaDocument } from "./runtime-contract.js";

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
      converted.required = Object.keys(
        converted.properties as Record<string, unknown>,
      );
    }
    return converted;
  };

  return visit(value) as JsonSchemaDocument;
}
