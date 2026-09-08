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

  /* ------------------------------------------------------------------ *
   * Optional properties under a required-everything provider
   * ------------------------------------------------------------------ */

  /**
   * Forcing every property into `required` is what OpenAI Structured Outputs
   * demands, but on its own it deletes the model's ability to decline a field.
   * A model cannot omit it and has no null to fall back on, so it fills the
   * field in -- with something invented. That is exactly what happened to
   * `peerClarification`: Codex attached a fabricated peer question to every
   * recipient turn until the schema let it say no.
   */
  const optionalObject = () => ({
    type: "object",
    properties: {
      state: { type: "string" },
      note: { type: "object", properties: {}, additionalProperties: false },
    },
    required: ["state"],
    additionalProperties: false,
  });

  it("lets Codex decline an optional property instead of inventing one", () => {
    const compatible = providerCompatibleSchema("codex", optionalObject());
    const note = (compatible.properties as Record<string, { anyOf?: unknown[] }>)
      .note;

    expect(compatible.required).toEqual(["state", "note"]);
    // The nested object carries `required: []` because the rewrite recurses:
    // every object in the document gets required-everything, and an object with
    // no properties requires nothing. Asserting the whole branch rather than
    // just `anyOf.length` is the point -- the null alternative has to sit beside
    // the original shape, not replace it.
    expect(note.anyOf).toEqual([
      { type: "object", properties: {}, required: [], additionalProperties: false },
      { type: "null" },
    ]);
  });

  it("leaves a genuinely required property exactly as authored", () => {
    const compatible = providerCompatibleSchema("codex", optionalObject());
    const state = (compatible.properties as Record<string, unknown>).state;

    // Widening a required field would let the model return null where the
    // protocol guarantees a value, which is the opposite of the intent.
    expect(state).toEqual({ type: "string" });
  });

  it("does not wrap a property that already offers null", () => {
    const compatible = providerCompatibleSchema("codex", schema());
    const request = (compatible.properties as Record<string, { anyOf?: unknown[] }>)
      .request;

    // `request` was authored as oneOf[object, null]; it becomes anyOf and stays
    // one level deep rather than collecting a redundant null branch.
    expect(request.anyOf).toHaveLength(2);
    expect(request.anyOf?.[1]).toEqual({ type: "null" });
  });

  it("never widens an optional property for Claude", () => {
    // Claude honours omission, so the field stays optional and unwrapped. Only
    // the provider that cannot omit pays for the workaround.
    const compatible = providerCompatibleSchema("claude", optionalObject());

    expect(compatible.required).toEqual(["state"]);
    expect((compatible.properties as Record<string, unknown>).note).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});
