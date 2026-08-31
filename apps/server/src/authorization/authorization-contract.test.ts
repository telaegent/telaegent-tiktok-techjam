import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AuthorizedPrivateRuntime,
  AuthorizePrivateRuntimeInput,
  PrivateRuntimeAuthorizationRepository,
  PrivateRuntimeAuthorizationSnapshot,
  ProjectConnection,
  RuntimeBinding,
} from "./index.js";

describe("private runtime authorization contract", () => {
  it("matches the callable seam required by the provider runtime", () => {
    expectTypeOf<AuthorizePrivateRuntimeInput>().toEqualTypeOf<{
      authenticatedUserId: string;
      githubRepositoryId: string;
      conversationId: string;
    }>();
    expectTypeOf<AuthorizedPrivateRuntime>().toEqualTypeOf<{
      userId: string;
      githubRepositoryId: string;
      runtimeBindingId: string;
    }>();
  });

  it("loads authorization facts through one snapshot operation", () => {
    expectTypeOf<PrivateRuntimeAuthorizationRepository>().toHaveProperty(
      "loadPrivateRuntimeAuthorizationSnapshot",
    );
    expectTypeOf<
      PrivateRuntimeAuthorizationRepository["loadPrivateRuntimeAuthorizationSnapshot"]
    >().returns.resolves.toEqualTypeOf<PrivateRuntimeAuthorizationSnapshot>();
  });

  it("exposes a workspace only for a ready runtime binding", () => {
    const ready = {
      runtimeBindingId: "runtime-1",
      userId: "user-1",
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      status: "ready",
    } satisfies RuntimeBinding;
    const unavailable = {
      runtimeBindingId: "runtime-1",
      userId: "user-1",
      projectId: "project-1",
      githubRepositoryId: "1345851083",
      status: "unavailable",
    } satisfies RuntimeBinding;

    expect("workspacePath" in ready).toBe(false);
    expect("workspacePath" in unavailable).toBe(false);
  });

  it("makes project-connection timestamps agree with their state", () => {
    const connected = {
      projectConnectionId: "connection-1",
      projectId: "project-1",
      requesterUserId: "user-1",
      recipientUserId: "user-2",
      status: "connected",
      requestedAt: "2026-08-30T00:00:00.000Z",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      revokedAt: null,
    } satisfies ProjectConnection;

    expect(connected.acceptedAt).not.toBeNull();
    expect(connected.revokedAt).toBeNull();
  });
});
