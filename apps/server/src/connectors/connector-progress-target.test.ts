import { describe, expect, it } from "vitest";
import { progressSchemaForTests } from "./routes.js";

describe("progress target", () => {
  it("accepts an activity event with a workspace-relative target", () => {
    expect(
      progressSchemaForTests.parse({
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "src/auth/session.ts",
      }),
    ).toMatchObject({ target: "src/auth/session.ts" });
  });

  it("accepts an activity event with no target", () => {
    const parsed = progressSchemaForTests.parse({
      type: "activity_started",
      provider: "claude",
      activity: "tool",
    });
    expect(parsed).not.toHaveProperty("target");
  });

  it("rejects an absolute target", () => {
    expect(() =>
      progressSchemaForTests.parse({
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "/home/dev/.aws/credentials",
      }),
    ).toThrow();
  });

  it("rejects a backslash target", () => {
    expect(() =>
      progressSchemaForTests.parse({
        type: "activity_started",
        provider: "claude",
        activity: "tool",
        target: "C:\repo\src\a.ts",
      }),
    ).toThrow();
  });

  it("still rejects text_delta on the progress route", () => {
    expect(() =>
      progressSchemaForTests.parse({
        type: "text_delta",
        provider: "claude",
        text: "the API key is sk-live-1234",
      }),
    ).toThrow();
  });
});
