import { describe, expect, it, vi } from "vitest";
import { refreshEstablishedReadiness } from "./connector-readiness.js";

describe("refreshEstablishedReadiness", () => {
  it("reports a successful refresh", async () => {
    const announce = vi.fn().mockResolvedValue(undefined);

    await expect(refreshEstablishedReadiness(announce)).resolves.toBe(true);
    expect(announce).toHaveBeenCalledOnce();
  });

  it("contains a transient refresh failure after initial readiness", async () => {
    const announce = vi.fn().mockRejectedValue(new Error("temporary control-plane outage"));

    await expect(refreshEstablishedReadiness(announce)).resolves.toBe(false);
    expect(announce).toHaveBeenCalledOnce();
  });
});
