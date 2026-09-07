import { describe, expect, it, vi } from "vitest";
import { assertAllSelectedProvidersConnected, probeConnectorProviders } from "./connector-provider-probes.js";

describe("connector provider probes", () => {
  it.each(["claude", "codex"] as const)("keeps the other provider usable when %s fails", async (failed) => {
    const failure = new Error("provider unavailable");
    const onFailure = vi.fn();
    let active = false;
    const connected = await probeConnectorProviders(["claude", "codex"], async (provider) => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
      if (provider === failed) throw failure;
    }, onFailure);
    expect(connected).toEqual([failed === "claude" ? "codex" : "claude"]);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failed, failure);
    expect(() => assertAllSelectedProvidersConnected(["claude", "codex"], connected)).toThrow("Not all selected providers");
  });

  it("does not report connection when all probes fail", async () => {
    const onFailure = vi.fn();
    await expect(probeConnectorProviders(["claude", "codex"], async () => { throw new Error("failed"); }, onFailure)).rejects.toThrow("No local coding provider passed");
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("probes only the selected provider and passes complete readiness", async () => {
    const probe = vi.fn(async () => {});
    const connected = await probeConnectorProviders(["claude"], probe, vi.fn());
    expect(probe).toHaveBeenCalledExactlyOnceWith("claude");
    expect(() => assertAllSelectedProvidersConnected(["claude"], connected)).not.toThrow();
  });
});
