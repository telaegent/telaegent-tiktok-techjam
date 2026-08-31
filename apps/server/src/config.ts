import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isSafeSupabaseOrigin } from "./supabase-origin.js";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  ENABLE_LEGACY_LOCAL_PLAYGROUND: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_API_KEY: z.string().optional(),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  RUNTIME_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  CLAUDE_BIN: z.string().default("claude"),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  CLAUDE_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  CLAUDE_API_KEY: z.string().optional(),
  CLAUDE_BASE_URL: z.string().url().optional(),
  CLAUDE_MODEL: z.string().optional(),
  RUNTIME_OUTPUT_SCHEMA_ROOT: z
    .string()
    .default(path.resolve("apps/server/src/telagent/output-schemas")),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  TELAEGENT_IDENTITY_PROVIDER: z.enum(["disabled", "github"]).default("disabled"),
  TELAEGENT_PUBLIC_URL: z.string().optional(),
  TELAEGENT_COOKIE_SECRET: z.string().optional(),
  TELAEGENT_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(2_592_000)
    .default(1_209_600),
  CONNECTOR_CREDENTIAL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(2_592_000)
    .default(1_209_600),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GITHUB_OAUTH_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(5_000),
  AUTHORIZATION_PERSISTENCE: z.enum(["memory", "supabase"]).default("memory"),
  CONVERSATION_PERSISTENCE: z.enum(["memory", "supabase"]).default("memory"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.ap-southeast.bytepluses.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const supabase = loadSupabaseBackendConfig(env);
  const identity = loadGitHubIdentityConfig(env);
  const config = {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    enableLegacyLocalPlayground: env.ENABLE_LEGACY_LOCAL_PLAYGROUND,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexApiKey: env.CODEX_API_KEY?.trim() ?? "",
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    runtimeIdleTimeoutMs: env.RUNTIME_IDLE_TIMEOUT_MS,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    claudeBin: env.CLAUDE_BIN,
    claudeTimeoutMs: env.CLAUDE_TIMEOUT_MS,
    claudeMaxOutputBytes: env.CLAUDE_MAX_OUTPUT_BYTES,
    claudeApiKey: env.CLAUDE_API_KEY?.trim() ?? "",
    claudeBaseUrl: env.CLAUDE_BASE_URL?.replace(/\/+$/, "") ?? "",
    claudeModel: env.CLAUDE_MODEL?.trim() ?? "",
    runtimeOutputSchemaRoot: path.resolve(env.RUNTIME_OUTPUT_SCHEMA_ROOT),
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    telaegentIdentityProvider: env.TELAEGENT_IDENTITY_PROVIDER,
    telaegentPublicOrigin: identity.publicOrigin,
    telaegentCookieSecret: identity.cookieSecret,
    telaegentSessionTtlSeconds: env.TELAEGENT_SESSION_TTL_SECONDS,
    connectorCredentialTtlSeconds: env.CONNECTOR_CREDENTIAL_TTL_SECONDS,
    githubOAuthClientId: identity.clientId,
    githubOAuthClientSecret: identity.clientSecret,
    githubOAuthTimeoutMs: env.GITHUB_OAUTH_TIMEOUT_MS,
    authorizationPersistence: env.AUTHORIZATION_PERSISTENCE,
    conversationPersistence: env.CONVERSATION_PERSISTENCE,
    supabaseUrl: supabase.url,
    supabaseSecretKey: supabase.secretKey,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
  // The elevated database key remains readable by the narrow composition
  // factory but cannot leak through routine object spreading/JSON logging.
  Object.defineProperty(config, "supabaseSecretKey", {
    value: supabase.secretKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(config, "telaegentCookieSecret", {
    value: identity.cookieSecret,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(config, "githubOAuthClientSecret", {
    value: identity.clientSecret,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return config;
}

function loadGitHubIdentityConfig(
  env: Readonly<{
    TELAEGENT_IDENTITY_PROVIDER: "disabled" | "github";
    TELAEGENT_PUBLIC_URL?: string | undefined;
    TELAEGENT_COOKIE_SECRET?: string | undefined;
    GITHUB_OAUTH_CLIENT_ID?: string | undefined;
    GITHUB_OAUTH_CLIENT_SECRET?: string | undefined;
    NODE_ENV: "development" | "test" | "production";
  }>,
): Readonly<{
  publicOrigin: string;
  cookieSecret: string;
  clientId: string;
  clientSecret: string;
}> {
  if (env.TELAEGENT_IDENTITY_PROVIDER !== "github") {
    return { publicOrigin: "", cookieSecret: "", clientId: "", clientSecret: "" };
  }
  const rawPublicUrl = env.TELAEGENT_PUBLIC_URL?.trim() ?? "";
  const cookieSecret = env.TELAEGENT_COOKIE_SECRET?.trim() ?? "";
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? "";
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawPublicUrl);
  } catch {
    throw invalidGitHubIdentityConfig();
  }
  const localDevelopmentOrigin =
    env.NODE_ENV !== "production" &&
    publicUrl.protocol === "http:" &&
    new Set(["localhost", "127.0.0.1", "::1"]).has(publicUrl.hostname);
  let cookieSecretBytes: Buffer;
  try {
    cookieSecretBytes = Buffer.from(cookieSecret, "base64url");
  } catch {
    throw invalidGitHubIdentityConfig();
  }
  if (
    (publicUrl.protocol !== "https:" && !localDevelopmentOrigin) ||
    publicUrl.username.length > 0 ||
    publicUrl.password.length > 0 ||
    publicUrl.search.length > 0 ||
    publicUrl.hash.length > 0 ||
    (publicUrl.pathname !== "/" && publicUrl.pathname !== "") ||
    cookieSecretBytes.length < 32 ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(cookieSecret) ||
    cookieSecret.startsWith("replace-") ||
    !/^[A-Za-z0-9_-]{10,128}$/.test(clientId) ||
    clientId.startsWith("replace-") ||
    !/^[A-Za-z0-9_-]{20,255}$/.test(clientSecret) ||
    clientSecret.startsWith("replace-")
  ) {
    throw invalidGitHubIdentityConfig();
  }
  return {
    publicOrigin: publicUrl.origin,
    cookieSecret,
    clientId,
    clientSecret,
  };
}

function invalidGitHubIdentityConfig(): Error {
  return new Error("GitHub identity configuration is invalid");
}

function loadSupabaseBackendConfig(
  env: Readonly<{
    AUTHORIZATION_PERSISTENCE: "memory" | "supabase";
    CONVERSATION_PERSISTENCE: "memory" | "supabase";
    TELAEGENT_IDENTITY_PROVIDER: "disabled" | "github";
    SUPABASE_URL?: string | undefined;
    SUPABASE_SECRET_KEY?: string | undefined;
  }>,
): Readonly<{ url: string; secretKey: string }> {
  // Credentials are inert until something that needs the database is
  // explicitly switched on. This prevents a copied local .env from silently
  // turning database access on.
  if (
    env.AUTHORIZATION_PERSISTENCE !== "supabase" &&
    env.CONVERSATION_PERSISTENCE !== "supabase" &&
    env.TELAEGENT_IDENTITY_PROVIDER !== "github"
  ) {
    return { url: "", secretKey: "" };
  }

  const rawUrl = env.SUPABASE_URL?.trim() ?? "";
  const secretKey = env.SUPABASE_SECRET_KEY ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalidSupabaseBackendConfig();
  }
  if (
    !isSafeSupabaseOrigin(url) ||
    !/^sb_secret_[A-Za-z0-9_-]{20,480}$/.test(secretKey)
  ) {
    throw invalidSupabaseBackendConfig();
  }

  return { url: url.origin, secretKey };
}

function invalidSupabaseBackendConfig(): Error {
  // Never include configuration values: this error can reach startup logs.
  return new Error("Supabase backend persistence configuration is invalid");
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Telagent. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "byteplus_modelark"',
    "",
    "[model_providers.byteplus_modelark]",
    'name = "BytePlus ModelArk"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
