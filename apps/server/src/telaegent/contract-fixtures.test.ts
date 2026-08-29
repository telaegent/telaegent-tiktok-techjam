import { describe, expect, it } from "vitest";
import {
  ALLOWED_ACTION_FIXTURES,
  EMPTY_TELAEGENT_DATABASE,
  TELAEGENT_ENVELOPE_FIXTURES,
} from "./contract-fixtures.js";
import {
  allowedActionSchema,
  telaegentDatabaseSchema,
  telaegentEnvelopeSchema,
} from "./schemas.js";

describe("protocol handoff fixtures", () => {
  it("provides a valid envelope for every tool", () => {
    expect(Object.keys(TELAEGENT_ENVELOPE_FIXTURES)).toHaveLength(11);
    for (const fixture of Object.values(TELAEGENT_ENVELOPE_FIXTURES)) {
      expect(telaegentEnvelopeSchema.safeParse(fixture).success, fixture.operation).toBe(true);
    }
  });

  it("provides every server-calculated UI action", () => {
    expect(ALLOWED_ACTION_FIXTURES).toHaveLength(11);
    for (const fixture of ALLOWED_ACTION_FIXTURES) {
      expect(allowedActionSchema.safeParse(fixture).success, fixture.kind).toBe(true);
    }
  });

  it("provides Khoa a schema-valid empty database value", () => {
    expect(telaegentDatabaseSchema.parse(EMPTY_TELAEGENT_DATABASE)).toEqual(
      EMPTY_TELAEGENT_DATABASE,
    );
  });
});
