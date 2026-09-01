import { describe, expect, it } from "vitest";
import { connectorHttpResponseError } from "./connector-http-error.js";

describe("connector HTTP diagnostics", () => {
  it("retains only HTTP status and a safe server code", async () => {
    const error = await connectorHttpResponseError(
      new Response(JSON.stringify({
        code: "RUNTIME_TIMEOUT",
        error: "private path C:\\Users\\owner\\repo and token=secret",
      }), {
        status: 504,
        headers: { "content-type": "application/json" },
      }),
      "job update",
    );

    expect(error).toMatchObject({
      name: "ConnectorHttpResponseError",
      status: 504,
      code: "RUNTIME_TIMEOUT",
    });
    expect(error.message).toBe(
      "Telaegent connector job update failed (HTTP 504, code RUNTIME_TIMEOUT)",
    );
    expect(error.message).not.toMatch(/owner|repo|token|secret/i);
  });

  it.each([
    { body: "not json", expected: "HTTP_502" },
    { body: JSON.stringify({ code: "unsafe code with detail" }), expected: "HTTP_502" },
  ])("falls back to status for an unsafe response code", async ({ body, expected }) => {
    const error = await connectorHttpResponseError(
      new Response(body, { status: 502 }),
      "request",
    );

    expect(error.code).toBe(expected);
    expect(error.message).not.toContain(body);
  });

  it("does not read or retain an oversized response body", async () => {
    const secret = "PRIVATE_PROVIDER_DETAIL_".repeat(300);
    const error = await connectorHttpResponseError(
      new Response(JSON.stringify({ code: "RUNTIME_FAILED", error: secret }), {
        status: 500,
      }),
      "request",
    );

    expect(error.code).toBe("HTTP_500");
    expect(error.message).not.toContain("PRIVATE_PROVIDER_DETAIL");
  });
});
