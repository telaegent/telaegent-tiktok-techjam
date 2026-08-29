import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOutputSchemaDocuments } from "./output-schema-documents.js";

const schemaDirectory = fileURLToPath(new URL("./output-schemas/", import.meta.url));

describe("provider output JSON Schemas", () => {
  it("stay synchronized with the authoritative Zod schemas", async () => {
    const expected = buildOutputSchemaDocuments();
    expect(Object.keys(expected)).toHaveLength(8);
    for (const [name, document] of Object.entries(expected)) {
      const raw = await readFile(path.join(schemaDirectory, name), "utf8");
      expect(JSON.parse(raw), name).toEqual(document);
      expect(document.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(document.$id).toMatch(/^urn:telaegent:output-schema:.+:v1$/);
      expect(document.additionalProperties).toBe(false);
    }
  });
});
