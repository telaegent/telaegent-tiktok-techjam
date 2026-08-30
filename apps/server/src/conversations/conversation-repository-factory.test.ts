import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createConfiguredConversationRepository } from "./conversation-repository-factory.js";
import { InMemoryConversationRepository } from "./in-memory-repository.js";
import { SupabaseConversationRepository } from "./supabase-conversation-repository.js";

const secretKey = "sb_secret_" + "a".repeat(32);
const supabaseEnvironment = {
  CONVERSATION_PERSISTENCE: "supabase",
  SUPABASE_URL: "https://example-project.supabase.co",
  SUPABASE_SECRET_KEY: secretKey,
} as const;

describe("createConfiguredConversationRepository", () => {
  it("defaults to the in-memory adapter", () => {
    expect(createConfiguredConversationRepository(loadConfig({}))).toBeInstanceOf(
      InMemoryConversationRepository,
    );
  });

  it("uses an injected local repository without silently replacing it", () => {
    const memoryRepository = new InMemoryConversationRepository();

    expect(
      createConfiguredConversationRepository(loadConfig({}), { memoryRepository }),
    ).toBe(memoryRepository);
  });

  it("constructs Supabase persistence only after explicit opt-in", () => {
    const repository = createConfiguredConversationRepository(
      loadConfig(supabaseEnvironment),
      { fetch: vi.fn<typeof fetch>() },
    );

    expect(repository).toBeInstanceOf(SupabaseConversationRepository);
  });

  it("never falls back to memory when the injected local repository is present", () => {
    const memoryRepository = new InMemoryConversationRepository();

    const repository = createConfiguredConversationRepository(
      loadConfig(supabaseEnvironment),
      { memoryRepository, fetch: vi.fn<typeof fetch>() },
    );

    expect(repository).not.toBe(memoryRepository);
    expect(repository).toBeInstanceOf(SupabaseConversationRepository);
  });

  it("loads Supabase credentials when only conversation persistence opts in", () => {
    const config = loadConfig(supabaseEnvironment);

    expect(config.authorizationPersistence).toBe("memory");
    expect(config.supabaseUrl).toBe("https://example-project.supabase.co");
  });

  it("refuses to start when opted in without valid credentials", () => {
    expect(() => loadConfig({ CONVERSATION_PERSISTENCE: "supabase" })).toThrow(
      "Supabase backend persistence configuration is invalid",
    );
  });

  it("keeps credentials inert while both persistence flags stay in memory", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: secretKey,
    });

    expect(config.supabaseUrl).toBe("");
    expect(config.supabaseSecretKey).toBe("");
  });
});
