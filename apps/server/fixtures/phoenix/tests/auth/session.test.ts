import { describe, expect, it } from "vitest";
import { FakeSessionRepository } from "../../src/auth/fake-session-repository";
import { SessionService } from "../../src/auth/session";
import { SESSION_TTL_SECONDS } from "../../src/auth/session-repository";

const at = (iso: string) => () => new Date(iso);

describe("SessionService", () => {
  it("creates a session whose expiry matches the configured TTL", async () => {
    const clock = at("2026-01-01T00:00:00.000Z");
    const service = new SessionService(new FakeSessionRepository(clock), clock);

    const session = await service.startSession("user_1");

    expect(new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime()).toBe(
      SESSION_TTL_SECONDS * 1000,
    );
  });

  it("records the device when one is supplied", async () => {
    const service = new SessionService(new FakeSessionRepository());
    const session = await service.startSession("user_1", "device-abc");
    expect(session.deviceId).toBe("device-abc");
  });

  it("omits the device when none is supplied", async () => {
    const service = new SessionService(new FakeSessionRepository());
    const session = await service.startSession("user_1");
    expect(session.deviceId).toBeUndefined();
  });

  it("revokes an expired session when it is resolved", async () => {
    const repository = new FakeSessionRepository(at("2026-01-01T00:00:00.000Z"));
    const service = new SessionService(repository, at("2026-01-02T00:00:00.000Z"));
    const session = await repository.create({ userId: "user_1" });

    expect(await service.resolve(session.id)).toBeNull();
    expect(repository.size).toBe(0);
  });

  it("signs out idempotently", async () => {
    const repository = new FakeSessionRepository();
    const service = new SessionService(repository);
    const session = await repository.create({ userId: "user_1" });

    await service.endSession(session.id);
    await expect(service.endSession(session.id)).resolves.toBeUndefined();
  });
});
