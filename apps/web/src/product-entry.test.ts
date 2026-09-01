import { describe, expect, it } from "vitest";
import {
  initialProductEntryRoute,
  productEntryRouteAfterDiscovery,
} from "./product-entry";

describe("product entry routing", () => {
  it("resumes authenticated users at their projects instead of onboarding", () => {
    expect(
      initialProductEntryRoute({
        authenticated: true,
        preview: false,
        requestedPreviewRoute: null,
      }),
    ).toBe("projects");
  });

  it("keeps first-time users in onboarding when discovery finds no projects", () => {
    expect(productEntryRouteAfterDiscovery(0)).toBe("onboarding");
  });

  it("keeps returning users in the product when discovery finds a project", () => {
    expect(productEntryRouteAfterDiscovery(1)).toBe("projects");
  });

  it("preserves the explicit onboarding preview route", () => {
    expect(
      initialProductEntryRoute({
        authenticated: false,
        preview: true,
        requestedPreviewRoute: "onboarding",
      }),
    ).toBe("onboarding");
  });
});
