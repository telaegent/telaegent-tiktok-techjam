import { randomBytes, randomUUID } from "node:crypto";

const PLACEHOLDER_PREFIXES = ["replace-", "your-"];

export function nodeMajor(version = process.versions.node) {
  return Number.parseInt(version.split(".")[0] ?? "0", 10);
}

export function hasConfiguredValue(value) {
  const normalized = value?.trim() ?? "";
  return (
    normalized.length > 0 &&
    !PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix)) &&
    !normalized.includes("your-project-ref")
  );
}

export function parseEnvFile(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

export function renderLocalEnv(template, random = {}) {
  const appToken = random.appToken ?? randomBytes(32).toString("base64url");
  const cookieSecret = random.cookieSecret ?? randomBytes(32).toString("base64url");
  const instanceId = random.instanceId ?? `local-${randomUUID()}`;
  return template
    .replace(/^HOST=.*$/mu, "HOST=127.0.0.1")
    .replace(/^APP_AUTH_TOKEN=.*$/mu, `APP_AUTH_TOKEN=${appToken}`)
    .replace(/^TELAEGENT_COOKIE_SECRET=.*$/mu, `TELAEGENT_COOKIE_SECRET=${cookieSecret}`)
    .replace(/^RUNTIME_INSTANCE_ID=.*$/mu, `RUNTIME_INSTANCE_ID=${instanceId}`);
}

export function inspectEndToEndEnvironment(values) {
  const problems = [];
  if (values.get("TELAEGENT_IDENTITY_PROVIDER") !== "github") {
    problems.push("TELAEGENT_IDENTITY_PROVIDER must be github");
  }
  if (values.get("AUTHORIZATION_PERSISTENCE") !== "supabase") {
    problems.push("AUTHORIZATION_PERSISTENCE must be supabase");
  }
  if (values.get("CONVERSATION_PERSISTENCE") !== "supabase") {
    problems.push("CONVERSATION_PERSISTENCE must be supabase");
  }
  for (const name of [
    "TELAEGENT_PUBLIC_URL",
    "TELAEGENT_COOKIE_SECRET",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
  ]) {
    if (!hasConfiguredValue(values.get(name))) problems.push(`${name} is not configured`);
  }
  return problems;
}
