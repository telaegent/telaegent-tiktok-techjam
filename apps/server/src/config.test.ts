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
