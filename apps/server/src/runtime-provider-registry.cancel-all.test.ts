/**
 * Stopping every provider run when the process quits.
 *
 * Provider children are spawned into their own process group so a cancel can
 * reach the whole tree. That same detachment means a terminal Ctrl-C no longer
 * reaches them -- the signal goes to this process's group, which the provider
 * is deliberately no longer in -- so without an explicit stop on shutdown, a
 * provider CLI kept running against the owner's repository after the connector
 * or server exited.
 *
 * It also matters for restart reconciliation: a survivor still working on a
 * workspace while startup marks its draft failed puts two things on one
 * checkout.
 */

import { describe, expect, it } from "vitest";

import { RuntimeProviderRegistry } from "./runtime-provider-registry.js";
import type {
  AgentProvider,
  MiddlewareProviderRunner,
  RuntimeProviderCapability,
} from "./runtime-contract.js";

function runner(
  provider: AgentProvider,
  overrides: Partial<MiddlewareProviderRunner> = {},
): MiddlewareProviderRunner {
  return {
    provider,
    async runStructured() {
      throw new Error("not run in this test");
    },
    async cancel() {
      return true;
    },
    async capability(): Promise<RuntimeProviderCapability> {
      return { installed: true, authenticated: true };
    },
    ...overrides,
  };
}

const schemas = { async resolve() { return {}; } };

describe("RuntimeProviderRegistry.cancelAll", () => {
  it("stops every registered runner", async () => {
    const stopped: AgentProvider[] = [];
    const registry = new RuntimeProviderRegistry(
      [
        runner("claude", {
          async cancelAll() {
            stopped.push("claude");
          },
        }),
        runner("codex", {
          async cancelAll() {
            stopped.push("codex");
          },
        }),
      ],
      schemas,
    );

    await registry.cancelAll();

    expect(stopped.sort()).toEqual(["claude", "codex"]);
  });

  it("stops the others when one runner fails or cannot stop", async () => {
    const stopped: AgentProvider[] = [];
    const registry = new RuntimeProviderRegistry(
      [
        // A runner whose children were never detached needs nothing here and
        // does not implement the method at all.
        runner("claude"),
        runner("codex", {
          async cancelAll() {
            stopped.push("codex");
          },
        }),
      ],
      schemas,
    );

    await expect(registry.cancelAll()).resolves.toBeUndefined();
    expect(stopped).toEqual(["codex"]);

    const rejecting = new RuntimeProviderRegistry(
      [
        runner("claude", {
          async cancelAll() {
            throw new Error("process already gone");
          },
        }),
        runner("codex", {
          async cancelAll() {
            stopped.push("codex-again");
          },
        }),
      ],
      schemas,
    );

    // Shutdown must not be derailed by a child that has already exited.
    await expect(rejecting.cancelAll()).resolves.toBeUndefined();
    expect(stopped).toContain("codex-again");
  });
});
