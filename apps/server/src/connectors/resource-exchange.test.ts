import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryProviderSessionStore, ProviderSessionManager } from "../provider-session-manager.js";
import type { RuntimeProgressEvent } from "../runtime-contract.js";
import { ConnectorWorker, type ConnectorWorkerTransport } from "./connector-worker.js";
import type { ConnectorJobResult } from "./connector-turn-executor.js";
import { LocalFileBroker } from "./file-broker.js";
import type { ConnectorDelivery } from "./long-poll-job-relay.js";
import {
  fulfilResourceRequests,
  type ResourceExchangeRequest,
  type ResourceExchangeResponse,
} from "./resource-exchange.js";
import { InMemoryResourceRegistry } from "./resource-registry.js";
import type { ResourceDenyCode } from "./resource-policy.js";
import { InMemoryResourceTaskBudgetLedger } from "./resource-budget.js";

const taskId = "task_one";
const peer = "10000000-0000-4000-8000-00000000b002";
const bindingId = "50000000-0000-4000-8000-000000000005";
const grantId = "30000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-31T12:00:00.000Z");

let workspace: string;
let registry: InMemoryResourceRegistry;
let landingPageId: string;
let envId: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "telaegent-exchange-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "LandingPage.tsx"), "export const page = 1;\n");
  await writeFile(path.join(workspace, ".env"), "SECRET=live-value\n");
  registry = new InMemoryResourceRegistry(() => now);
  landingPageId = await registry.mint(taskId, path.join(workspace, "src", "LandingPage.tsx"));
  // A registered identifier for a secret: proves screening does not depend on
  // the file being unknown to the registry.
  envId = await registry.mint(taskId, path.join(workspace, ".env"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function exchange(overrides: Partial<ResourceExchangeRequest> = {}): ResourceExchangeRequest {
  return {
    requestId: "exchange-1",
    taskId,
    taskExpiresAt: "2126-08-31T12:00:00.000Z",
    connectorBindingId: bindingId,
    peerUserId: peer,
    requests: [{ kind: "resource", resourceId: landingPageId, reason: "needs the page" }],
    grants: [
      {
        grantId,
        resourceId: landingPageId,
        operation: "read",
        mode: "task",
        expiresAt: null,
      },
    ],
    ...overrides,
  };
}

function deps(onRefusal?: (code: ResourceDenyCode | "UNREADABLE") => void) {
  return {
    registry,
    budget: new InMemoryResourceTaskBudgetLedger(),
    broker: new LocalFileBroker(workspace),
    workspacePath: workspace,
    now: () => now,
    ...(onRefusal ? { onRefusal: (code: ResourceDenyCode | "UNREADABLE") => onRefusal(code) } : {}),
  };
}

describe("resource exchange", () => {
  it("delivers a granted file and holds a new one for a human in the same batch", async () => {
    const response = await fulfilResourceRequests(
      exchange({
        requests: [
          { kind: "resource", resourceId: landingPageId, reason: "needs the page" },
          { kind: "hint", hint: "src/settings.ts", reason: "the page imports config" },
        ],
      }),
      deps(),
    );
    // Build plan 8.5: the peer keeps working with what it already has while a
    // human decides about the rest.
    expect(response.outcomes[0]).toMatchObject({
      status: "delivered",
      content: "export const page = 1;\n",
    });
    expect(response.outcomes[1]).toMatchObject({
      status: "pending_approval",
      request: { kind: "hint", hint: "src/settings.ts" },
    });
  });

  it("refuses a granted secret and says nothing about why", async () => {
    const refusals: string[] = [];
    const response = await fulfilResourceRequests(
      exchange({
        requests: [{ kind: "resource", resourceId: envId, reason: "config" }],
        grants: [
          { grantId, resourceId: envId, operation: "read", mode: "task", expiresAt: null },
        ],
      }),
      deps((code) => refusals.push(code)),
    );
    expect(response.outcomes[0]).toEqual({ status: "refused" });
    // The reason exists, but only on the owner's machine.
    expect(refusals).toEqual(["SECRET_PATH"]);
    expect(JSON.stringify(response)).not.toContain("SECRET");
  });

  it("re-screens file contents on later reads under a task grant", async () => {
    const configPath = path.join(workspace, "config.txt");
    await writeFile(configPath, "mode=review\n");
    const configId = await registry.mint(taskId, configPath);
    const request = exchange({
      requests: [{ kind: "resource", resourceId: configId, reason: "config" }],
      grants: [
        { grantId, resourceId: configId, operation: "read", mode: "task", expiresAt: null },
      ],
    });

    const first = await fulfilResourceRequests(request, deps());
    expect(first.outcomes[0]).toMatchObject({ status: "delivered", content: "mode=review\n" });

    await writeFile(configPath, 'mode=review\n{"password":"fake-review-password"}\n');
    const refusals: string[] = [];
    const second = await fulfilResourceRequests(request, deps((code) => refusals.push(code)));

    expect(second.outcomes[0]).toEqual({ status: "refused" });
    expect(refusals).toEqual(["SECRET_CONTENT"]);
    expect(JSON.stringify(second)).not.toContain("fake-review-password");
  });

  it("accumulates the byte budget so many small reads cannot beat one limit", async () => {
    const response = await fulfilResourceRequests(
      exchange({
        requests: [
          { kind: "resource", resourceId: landingPageId, reason: "first" },
          { kind: "resource", resourceId: landingPageId, reason: "second" },
        ],
      }),
      { ...deps(), limits: { maxRequestsPerTask: 8, maxBytesPerTask: 23, maxBytesPerResource: 23 } },
    );
    expect(response.outcomes[0]).toMatchObject({ status: "delivered" });
    // The first read consumed the whole task budget; splitting does not refill it.
    expect(response.outcomes[1]).toEqual({ status: "refused" });
  });

  it("keeps request and byte budgets across separate exchange batches", async () => {
    const shared = {
      ...deps(),
      limits: {
        maxRequestsPerTask: 1,
        maxBytesPerTask: 1_048_576,
        maxBytesPerResource: 262_144,
      },
    };

    const first = await fulfilResourceRequests(exchange({ requestId: "batch-1" }), shared);
    const second = await fulfilResourceRequests(exchange({ requestId: "batch-2" }), shared);

    expect(first.outcomes[0]).toMatchObject({ status: "delivered" });
    expect(second.outcomes[0]).toEqual({ status: "refused" });
  });

  it("does not refill a task budget when an individual grant is replaced", async () => {
    const budget = new InMemoryResourceTaskBudgetLedger();
    const shared = {
      ...deps(),
      budget,
      limits: {
        maxRequestsPerTask: 1,
        maxBytesPerTask: 1_048_576,
        maxBytesPerResource: 262_144,
      },
    };
    const first = await fulfilResourceRequests(
      exchange({
        requestId: "grant-1",
        grants: [{
          grantId,
          resourceId: landingPageId,
          operation: "read",
          mode: "once",
          expiresAt: "2026-08-31T12:01:00.000Z",
        }],
      }),
      shared,
    );
    const second = await fulfilResourceRequests(
      exchange({
        requestId: "grant-2",
        grants: [{
          grantId: "30000000-0000-4000-8000-000000000002",
          resourceId: landingPageId,
          operation: "read",
          mode: "task",
          expiresAt: "2126-08-31T11:00:00.000Z",
        }],
      }),
      shared,
    );

    expect(first.outcomes[0]).toMatchObject({ status: "delivered" });
    expect(second.outcomes[0]).toEqual({ status: "refused" });
  });

  it("refuses an exchange after the database-derived task expiry", async () => {
    const refusal = vi.fn();
    const response = await fulfilResourceRequests(
      exchange({ taskExpiresAt: "2026-08-31T11:59:59.999Z" }),
      deps(refusal),
    );

    expect(response.outcomes).toEqual([{ status: "refused" }]);
    expect(refusal).toHaveBeenCalledWith("GRANT_EXPIRED");
  });

  it("refuses an identifier minted for a different task", async () => {
    const otherTask = new InMemoryResourceRegistry(() => now);
    const foreign = await otherTask.mint("task_two", path.join(workspace, "src/LandingPage.tsx"));
    const response = await fulfilResourceRequests(
      exchange({
        requests: [{ kind: "resource", resourceId: foreign, reason: "replay" }],
        grants: [
          { grantId, resourceId: foreign, operation: "read", mode: "task", expiresAt: null },
        ],
      }),
      deps(),
    );
    expect(response.outcomes[0]).toEqual({ status: "refused" });
  });
});

class ServingTransport implements ConnectorWorkerTransport {
  readonly responses: ResourceExchangeResponse[] = [];
  constructor(private readonly deliveries: ConnectorDelivery[]) {}

  async poll(): Promise<ConnectorDelivery | null> {
    return this.deliveries.shift() ?? null;
  }
  async progress(_jobId: string, _event: RuntimeProgressEvent): Promise<void> {}
  async result(_jobId: string, _result: ConnectorJobResult): Promise<void> {}
  async failure(_jobId: string, _code: string): Promise<void> {}
  async resourceResponse(response: ResourceExchangeResponse): Promise<void> {
    this.responses.push(response);
  }
}

describe("preparing a scope expansion for the owning human", () => {
  // Written without escapes so a shell that eats one backslash cannot quietly
  // turn a traversal case into a harmless relative path.
  const backslash = String.fromCharCode(92);
  const windowsAbsolute = ["C:", "Windows", "win.ini"].join(backslash);
  const windowsTraversal = ["..", "..", "secrets.txt"].join(backslash);

  it("mints the identifier a human approval would attach authority to", async () => {
    const response = await fulfilResourceRequests(
      exchange({
        requests: [
          { kind: "hint", hint: "src/LandingPage.tsx", reason: "the page imports it" },
        ],
        grants: [],
      }),
      deps(),
    );
    // Build plan 8.3: the owner's machine mints, the cloud only records. The
    // identifier is the same one this task already holds for that file, so
    // approving twice cannot fragment one file into two authorities.
    expect(response.outcomes[0]).toEqual({
      status: "pending_approval",
      request: { kind: "hint", hint: "src/LandingPage.tsx", reason: "the page imports it" },
      candidate: {
        resourceId: landingPageId,
        resourceDisplayLabel: "src/LandingPage.tsx",
      },
    });
    // A candidate is a handle, not authority. Nothing was read.
    expect(JSON.stringify(response)).not.toContain("export const page");
  });

  it("offers no candidate for a secret, and the peer cannot tell it apart from a missing file", async () => {
    const refusals: string[] = [];
    const response = await fulfilResourceRequests(
      exchange({
        requests: [
          { kind: "hint", hint: ".env", reason: "config" },
          { kind: "hint", hint: "src/settings.ts", reason: "config" },
        ],
        grants: [],
      }),
      deps((code) => refusals.push(code)),
    );
    // A hard-denied file and a file that does not exist answer identically, so
    // a peer cannot use the shape of the answer to map the repository.
    expect(response.outcomes[0]).toEqual({
      status: "pending_approval",
      request: { kind: "hint", hint: ".env", reason: "config" },
    });
    expect(response.outcomes[1]).toEqual({
      status: "pending_approval",
      request: { kind: "hint", hint: "src/settings.ts", reason: "config" },
    });
    // Both reasons exist, and both stay here. A file that is not there cannot
    // be proven to lie inside the workspace either, so it is refused with the
    // containment code rather than an existence code the peer might learn from.
    expect(refusals).toEqual(["SECRET_PATH", "OUTSIDE_WORKSPACE"]);
    expect(JSON.stringify(response)).not.toContain("SECRET_PATH");
  });

  it("never resolves a hint that tries to name a file instead of describing one", async () => {
    const response = await fulfilResourceRequests(
      exchange({
        requests: [
          { kind: "hint", hint: "../../etc/passwd", reason: "one" },
          { kind: "hint", hint: windowsTraversal, reason: "two" },
          { kind: "hint", hint: "/etc/passwd", reason: "three" },
          { kind: "hint", hint: windowsAbsolute, reason: "four" },
          { kind: "hint", hint: "src/../.env", reason: "five" },
        ],
        grants: [],
      }),
      deps(),
    );
    // An agent may only ever describe a file. None of these become a candidate,
    // so no human is ever offered a button that reaches outside the project.
    for (const outcome of response.outcomes) {
      expect(outcome).toMatchObject({ status: "pending_approval" });
      expect(outcome).not.toHaveProperty("candidate");
    }
  });

  it("offers the same identifier back when authority over a known file has lapsed", async () => {
    const response = await fulfilResourceRequests(
      exchange({
        requests: [{ kind: "resource", resourceId: landingPageId, reason: "again" }],
        grants: [],
      }),
      deps(),
    );
    // The peer still holds an identifier this task minted; what it no longer
    // holds is a grant. Re-approval renews the grant, never the identifier.
    expect(response.outcomes[0]).toEqual({
      status: "pending_approval",
      request: { kind: "resource", resourceId: landingPageId, reason: "again" },
      candidate: {
        resourceId: landingPageId,
        resourceDisplayLabel: "src/LandingPage.tsx",
      },
    });
  });

  it("offers no candidate for an identifier this task never minted", async () => {
    const response = await fulfilResourceRequests(
      exchange({
        requests: [{ kind: "resource", resourceId: `resource_${"z".repeat(24)}`, reason: "guess" }],
        grants: [],
      }),
      deps(),
    );
    // An unknown identifier is refused outright: escalating it would let a peer
    // put a file it invented in front of the owning human.
    expect(response.outcomes[0]).toEqual({ status: "refused" });
  });
});

describe("connector worker serving resource requests", () => {
  function worker(transport: ConnectorWorkerTransport, run = vi.fn(), withRegistry = true) {
    const sessions = new ProviderSessionManager(
      { run } as never,
      new InMemoryProviderSessionStore(),
      async (_scope, request) => request,
    );
    return new ConnectorWorker(
      {
        connectorBindingId: bindingId,
        authenticatedUserId: "10000000-0000-4000-8000-000000000001",
        githubRepositoryId: "9223372036854775807",
        workspacePath: workspace,
      },
      sessions,
      transport,
      {
        cancel: async () => false,
        // The registry is built on a frozen clock, so the worker must share it.
        // On real time, pruneExpiredResources() retires entries without a
        // taskExpiresAt after LEGACY_ENTRY_RETENTION_MS, which made this suite
        // start failing permanently once 24h had passed since that fixed date.
        now: () => now.getTime(),
        ...(withRegistry
          ? { resources: { registry, budget: new InMemoryResourceTaskBudgetLedger() } }
          : {}),
      },
    );
  }

  it("serves a file without launching a provider", async () => {
    const transport = new ServingTransport([
      { kind: "resource_request", request: exchange() },
    ]);
    const run = vi.fn();
    await expect(worker(transport, run).runOnce()).resolves.toBe("completed");
    // Delivering a file is a reference-monitor operation, not an agent turn, so
    // no model ever sees the authorization decision.
    expect(run).not.toHaveBeenCalled();
    expect(transport.responses[0]?.outcomes[0]).toMatchObject({ status: "delivered" });
    // The content is intentionally relayed in flight; the canonical owner path
    // behind its opaque ID must never join that cloud payload.
    expect(JSON.stringify(transport.responses[0])).not.toContain(workspace);
  });

  it("refuses everything when no registry is configured", async () => {
    const transport = new ServingTransport([
      { kind: "resource_request", request: exchange() },
    ]);
    await expect(worker(transport, vi.fn(), false).runOnce()).resolves.toBe("completed");
    // A connector that cannot prove any identifier fails closed rather than
    // guessing which file was meant.
    expect(transport.responses[0]?.outcomes).toEqual([{ status: "refused" }]);
  });

  it("rejects a request addressed to another binding", async () => {
    const transport = new ServingTransport([
      {
        kind: "resource_request",
        request: exchange({ connectorBindingId: "50000000-0000-4000-8000-00000000ffff" }),
      },
    ]);
    await expect(worker(transport).runOnce()).rejects.toThrow(
      "Resource request does not match the local repository binding",
    );
  });
});
