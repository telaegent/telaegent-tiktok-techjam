import { describe, expect, it } from "vitest";
import {
  containsSecretLikeContent,
  redactText,
  redactValue,
  toSafeSummary,
} from "./redaction.js";

const SECRETS = {
  arkKey: "sk-live-9f3a2b7c4d5e6f7a8b9c0d1e",
  githubToken: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  slackToken: "xoxb-1234567890-abcdefghij",
  awsKey: "AKIAIOSFODNN7EXAMPLE",
  googleKey: "AIzaSyA1234567890abcdefghijklmnopqrstu",
  bearer: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
  password: 'DB_PASSWORD="hunter2-not-in-the-log"',
  connection: "postgres://admin:s3cr3t-pass@db.internal:5432/phoenix",
  homePath: "/home/hien/.codex/sessions/rollout-2026.jsonl",
  privateKey:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----",
};

describe("redaction removes the secret, not just flags it", () => {
  it.each(Object.entries(SECRETS))("removes %s", (_label, secret) => {
    const result = redactText("context: " + secret + " :end");
    expect(result.count).toBeGreaterThan(0);
    expect(result.value).toContain("[redacted]");
  });

  it("never leaves the raw literal anywhere in the result", () => {
    const haystack = Object.values(SECRETS).join("\n");
    const result = redactText(haystack);
    const serialized = JSON.stringify(result);

    for (const literal of [
      SECRETS.arkKey,
      SECRETS.githubToken,
      SECRETS.awsKey,
      SECRETS.googleKey,
      "hunter2-not-in-the-log",
      "s3cr3t-pass",
      "MIIEowIBAAKCAQEA1234567890",
    ]) {
      expect(serialized).not.toContain(literal);
    }
  });

  it("reports why without quoting what", () => {
    const result = redactText(SECRETS.privateKey);
    expect(result.reasons).toEqual(["PRIVATE_KEY_BLOCK"]);
    expect(JSON.stringify(result.reasons)).not.toContain("MIIE");
  });

  it("leaves ordinary prose and code untouched", () => {
    const prose =
      "Sessions are created through SessionRepository.create and expire after 30 minutes.";
    expect(redactText(prose)).toEqual({ value: prose, reasons: [], count: 0 });
  });
});

describe("deep redaction of structured payloads", () => {
  it("redacts by key name as well as by value shape", () => {
    const payload = {
      topic: "Redis session architecture",
      providerSessionId: "01JB7YZ3QWERTYUIOP",
      nested: { ARK_API_KEY: SECRETS.arkKey, note: "uses " + SECRETS.bearer },
      sources: [{ path: "src/auth/session.ts", commit: "af31d4e" }],
    };

    const result = redactValue(payload);
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain(SECRETS.arkKey);
    expect(serialized).not.toContain("01JB7YZ3QWERTYUIOP");
    expect(serialized).toContain("Redis session architecture");
    expect(serialized).toContain("src/auth/session.ts");
    expect(result.count).toBeGreaterThan(0);
  });

  it("does not throw on unusual input", () => {
    expect(() => redactValue(null)).not.toThrow();
    expect(() => redactValue(undefined)).not.toThrow();
    expect(() => redactText("" as string)).not.toThrow();
  });
});

describe("safe summaries", () => {
  it("redacts before truncating so a secret cannot survive past the cut", () => {
    const summary = toSafeSummary("x".repeat(40) + " " + SECRETS.arkKey, 60);
    expect(summary).not.toContain("sk-live");
    expect(summary.length).toBeLessThanOrEqual(60);
  });

  it("collapses whitespace and bounds length", () => {
    expect(toSafeSummary("a\n\n   b\tc", 100)).toBe("a b c");
    expect(toSafeSummary("y".repeat(500), 20)).toHaveLength(20);
  });
});

describe("secret detection", () => {
  it("flags secret-bearing text and clears clean text", () => {
    expect(containsSecretLikeContent("api_key = " + SECRETS.arkKey)).toBe(true);
    expect(containsSecretLikeContent("Use the fake SessionRepository in tests.")).toBe(false);
  });
});

/* ========================================================================== *
 * Type annotations are not credentials
 *
 * Found by the live evaluation, not by me: asked "what does the Session
 * interface look like", the agent answered with the field list, and the
 * credential-assignment rule redacted `refreshTokenHash: string` and marked the
 * whole draft unsendable. The answer was correct, safe, and exactly what was
 * asked for.
 *
 * These pin the narrowing in both directions - the type keywords pass, and
 * anything that is not literally a type keyword still gets redacted.
 * ========================================================================== */

describe("credential assignment vs type annotation", () => {
  it("leaves a TypeScript field declaration alone", () => {
    const source = "refreshTokenHash: string";
    const result = redactText(source);
    expect(result.value).toBe(source);
    expect(result.count).toBe(0);
    expect(result.reasons).not.toContain("CREDENTIAL_ASSIGNMENT");
  });

  it("leaves optional, array and union type annotations alone", () => {
    for (const source of [
      "apiKey?: string",
      "tokens: string[]",
      "secret: string|null",
      "password: unknown",
      "privateKey: Buffer",
    ]) {
      expect(redactText(source).count, source).toBe(0);
    }
  });

  it("still redacts an actual assigned value", () => {
    for (const source of [
      'apiKey: "sk-live-not-a-real-key-000"',
      "token = abcdef0123456789",
      "password: hunter2",
      "client_secret: 'stringy-but-not-a-type'",
    ]) {
      const result = redactText(source);
      expect(result.count, source).toBeGreaterThan(0);
      expect(result.value, source).toContain("[redacted]");
    }
  });

  it("does not let a value merely containing a type word through", () => {
    // `stringify` is not `string`. An allowlist matched loosely would be a way
    // to smuggle a secret past the rule by naming it well.
    const result = redactText("token: stringify");
    expect(result.count).toBe(1);
  });
});
