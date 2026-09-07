import { describe, expect, it } from "vitest";
import { deviceAuthorizationUiOutcome } from "./device-authorization-ui";

describe("device authorization UI outcome", () => {
  it("renders the durable server status rather than the locally clicked decision", () => {
    expect(deviceAuthorizationUiOutcome("approved")).toBe("approved");
    expect(deviceAuthorizationUiOutcome("consumed")).toBe("approved");
    expect(deviceAuthorizationUiOutcome("denied")).toBe("denied");
    expect(deviceAuthorizationUiOutcome("expired")).toBe("expired");
    expect(deviceAuthorizationUiOutcome("pending")).toBe("ready");
  });
});
