import { describe, expect, it } from "vitest";
import { RuntimeProviderError } from "../runtime-errors.js";
import { ConnectorHttpResponseError } from "./connector-http-error.js";
import { probeFailureReason } from "./connector-probe-failure.js";

describe("probeFailureReason", () => {
  it("reports a provider failure by its public code, never its message", () => {
    const reason = probeFailureReason(
      new RuntimeProviderError("RUNTIME_UNAVAILABLE", "Codex says private detail", {
        phase: "provider_exit",
        exitCode: 1,
      }),
    );

    expect(reason).toBe("RUNTIME_UNAVAILABLE");
    expect(reason).not.toContain("private detail");
  });

  it("keeps the sanitized status and code of a failed cloud probe call", () => {
    expect(probeFailureReason(new ConnectorHttpResponseError("probe", 503, "NO_BINDING")))
      .toBe("Telaegent connector probe failed (HTTP 503, code NO_BINDING)");
  });

  it("distinguishes polling that stopped before the probe settled", () => {
    expect(
      probeFailureReason(
        new Error("Connector polling stopped before the live probe completed"),
      ),
    ).toBe("Connector polling stopped before the live probe completed");
  });

  it("collapses whitespace so one failure stays one line", () => {
    expect(probeFailureReason(new Error("fetch failed\n  caused by: ECONNREFUSED")))
      .toBe("fetch failed caused by: ECONNREFUSED");
  });

  it("bounds an unexpected error instead of flooding connector output", () => {
    const reason = probeFailureReason(new Error("x".repeat(5_000)));

    expect(reason).toHaveLength(203);
    expect(reason.endsWith("...")).toBe(true);
  });

  it("falls back to the error name when there is no message", () => {
    expect(probeFailureReason(new Error(""))).toBe("Error");
  });

  it("survives a thrown non-error", () => {
    expect(probeFailureReason("boom")).toBe("unknown error");
    expect(probeFailureReason(undefined)).toBe("unknown error");
  });
});
