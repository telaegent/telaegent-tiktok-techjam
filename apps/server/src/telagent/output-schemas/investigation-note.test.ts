import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileOutputSchemaResolver } from "../../runtime-provider-registry.js";

const schemaRoot = path.dirname(fileURLToPath(import.meta.url));

describe("investigation-note.schema.json", () => {
  it("resolves through the standard schema resolver", async () => {
    const resolver = new FileOutputSchemaResolver(schemaRoot);
    const schema = await resolver.resolve("investigation-note.schema.json");
    expect(schema).toMatchObject({
      type: "object",
      required: ["note"],
      additionalProperties: false,
    });
  });

  it("cannot carry a message: no sendCandidate, state, or resourceRequests", async () => {
    const resolver = new FileOutputSchemaResolver(schemaRoot);
    const schema = await resolver.resolve("investigation-note.schema.json");
    const properties = (schema as unknown as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties)).toEqual(["note"]);
    expect(properties.sendCandidate).toBeUndefined();
    expect(properties.state).toBeUndefined();
    expect(properties.resourceRequests).toBeUndefined();
  });

  it("bounds the note so it cannot grow without limit", async () => {
    const resolver = new FileOutputSchemaResolver(schemaRoot);
    const schema = await resolver.resolve("investigation-note.schema.json");
    const note = (
      schema as unknown as { properties: { note: { maxLength: number } } }
    ).properties.note;
    expect(note.maxLength).toBe(8000);
  });
});
