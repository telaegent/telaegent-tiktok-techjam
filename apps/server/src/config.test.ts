import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("ModelArk configuration", () => {
  it("defaults local runs to the BytePlus Southeast Asia Responses API", () => {
    const config = loadConfig({});

    expect(config.arkBaseUrl).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3",
    );
  });

  it("allows an explicit deployment-specific Ark base URL", () => {
    const config = loadConfig({
      ARK_BASE_URL: "https://ark.example.test/api/v3/",
    });

    expect(config.arkBaseUrl).toBe("https://ark.example.test/api/v3");
  });
});

describe("runtime timeout configuration", () => {
  it("defaults to one minute idle and five minutes maximum", () => {
    const config = loadConfig({});

    expect(config.runtimeIdleTimeoutMs).toBe(60_000);
    expect(config.codexTimeoutMs).toBe(300_000);
    expect(config.claudeTimeoutMs).toBe(300_000);
  });

  it("allows deployment-specific timeout limits", () => {
    const config = loadConfig({
      RUNTIME_IDLE_TIMEOUT_MS: "90000",
      CODEX_TIMEOUT_MS: "420000",
      CLAUDE_TIMEOUT_MS: "480000",
    });

    expect(config.runtimeIdleTimeoutMs).toBe(90_000);
    expect(config.codexTimeoutMs).toBe(420_000);
    expect(config.claudeTimeoutMs).toBe(480_000);
  });
});
