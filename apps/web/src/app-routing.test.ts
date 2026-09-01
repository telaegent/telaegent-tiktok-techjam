import { describe, expect, it } from "vitest";
import {
  canonicalProductUrl,
  productLocationFromUrl,
  productPath,
  surfaceFromUrl,
} from "./app-routing";

describe("browser app routing", () => {
  it("keeps landing and authenticated app URLs distinct", () => {
    expect(surfaceFromUrl("/", "")).toBe("landing");
    expect(surfaceFromUrl("/app", "")).toBe("product");
    expect(surfaceFromUrl("/app/connections", "")).toBe("product");
  });

  it("migrates the legacy query route without losing preview state", () => {
    expect(canonicalProductUrl("/", "?view=platform")).toBe("/app");
    expect(
      canonicalProductUrl(
        "/",
        "?view=platform&preview=1&route=onboarding",
      ),
    ).toBe("/app?preview=1&route=onboarding");
  });

  it("restores product sections and project workspaces after refresh", () => {
    expect(productLocationFromUrl("/app", "", false)).toEqual({
      route: "projects",
      projectId: null,
    });
    expect(
      productLocationFromUrl("/app/onboarding", "", false).route,
    ).toBe("onboarding");
    expect(
      productLocationFromUrl("/app/projects/new", "", false).route,
    ).toBe("add-project");
    expect(
      productLocationFromUrl("/app/connections", "", false).route,
    ).toBe("connections");
    expect(productLocationFromUrl("/app/settings", "", false).route).toBe(
      "settings",
    );
    expect(
      productLocationFromUrl("/app/projects/project%2Fid", "", false),
    ).toEqual({ route: "workspace", projectId: "project/id" });
  });

  it("builds durable paths and keeps local preview mode query-gated", () => {
    expect(productPath("projects")).toBe("/app");
    expect(productPath("add-project")).toBe("/app/projects/new");
    expect(productPath("onboarding", null, true)).toBe(
      "/app/onboarding?preview=1",
    );
    expect(productPath("workspace", "project/id")).toBe(
      "/app/projects/project%2Fid",
    );
  });
});
