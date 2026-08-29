import { describe, expect, it } from "vitest";
import {
  ALLOWED_ACTION_FIXTURES,
  EMPTY_TELAGENT_DATABASE,
  TELAGENT_ENVELOPE_FIXTURES,
} from "./contract-fixtures.js";
import {
  allowedActionSchema,
  telagentDatabaseSchema,
  telagentEnvelopeSchema,
} from "./schemas.js";

describe("protocol handoff fixtures", () => {
  it("provides a valid envelope for every tool", () => {
    expect(Object.keys(TELAGENT_ENVELOPE_FIXTURES)).toHaveLength(11);
    for (const fixture of Object.values(TELAGENT_ENVELOPE_FIXTURES)) {
      expect(telagentEnvelopeSchema.safeParse(fixture).success, fixture.operation).toBe(true);
    }
  });

  it("provides every server-calculated UI action", () => {
    expect(ALLOWED_ACTION_FIXTURES).toHaveLength(11);
    for (const fixture of ALLOWED_ACTION_FIXTURES) {
      expect(allowedActionSchema.safeParse(fixture).success, fixture.kind).toBe(true);
    }
  });

  it("provides Khoa a schema-valid empty database value", () => {
    expect(telagentDatabaseSchema.parse(EMPTY_TELAGENT_DATABASE)).toEqual(
      EMPTY_TELAGENT_DATABASE,
    );
  });
});
