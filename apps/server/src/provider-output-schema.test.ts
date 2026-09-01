import { describe, expect, it } from "vitest";
import { providerCompatibleSchema } from "./provider-output-schema.js";

const schema = () => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    state: { type: "string" },
    request: {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "resource" } },
          required: ["kind"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["state"],
  additionalProperties: false,
});

describe("providerCompatibleSchema", () => {
  it("removes unsupported dialect declarations for Claude without weakening constraints", () => {
    const source = schema();
    const compatible = providerCompatibleSchema("claude", source);

    expect(compatible).not.toHaveProperty("$schema");
    expect(JSON.stringify(compatible)).toContain('"oneOf"');
    expect(compatible.required).toEqual(["state"]);
    expect(source).toHaveProperty("$schema");
  });

  it("normalizes the complete schema for Codex Structured Outputs", () => {
    const source = schema();
    const compatible = providerCompatibleSchema("codex", source);
    const encoded = JSON.stringify(compatible);

    expect(encoded).not.toContain('"$schema"');
    expect(encoded).not.toContain('"oneOf"');
    expect(encoded).toContain('"anyOf"');
    expect(encoded).not.toContain('"const"');
    expect(encoded).toContain('"enum":["resource"]');
    expect(compatible.required).toEqual(["state", "request"]);
    expect(source.required).toEqual(["state"]);
  });
});
