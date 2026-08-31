import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectEndToEndEnvironment,
  nodeMajor,
  parseEnvFile,
  renderLocalEnv,
} from "./setup-core.mjs";

test("reads the Node major version", () => {
  assert.equal(nodeMajor("22.14.0"), 22);
});

test("creates a loopback-only local env with generated secrets", () => {
  const rendered = renderLocalEnv(
    "HOST=0.0.0.0\nAPP_AUTH_TOKEN=replace-me\nTELAEGENT_COOKIE_SECRET=replace-me\nRUNTIME_INSTANCE_ID=default\n",
    { appToken: "app-secret", cookieSecret: "cookie-secret", instanceId: "local-test" },
  );
  assert.match(rendered, /^HOST=127\.0\.0\.1$/mu);
  assert.match(rendered, /^APP_AUTH_TOKEN=app-secret$/mu);
  assert.match(rendered, /^TELAEGENT_COOKIE_SECRET=cookie-secret$/mu);
  assert.match(rendered, /^RUNTIME_INSTANCE_ID=local-test$/mu);
});

test("reports every missing full end-to-end setting", () => {
  const values = parseEnvFile("TELAEGENT_IDENTITY_PROVIDER=disabled\nAUTHORIZATION_PERSISTENCE=memory\n");
  const problems = inspectEndToEndEnvironment(values);
  assert.ok(problems.includes("TELAEGENT_IDENTITY_PROVIDER must be github"));
  assert.ok(problems.includes("SUPABASE_SECRET_KEY is not configured"));
});

test("accepts a complete full end-to-end environment", () => {
  const values = parseEnvFile(`
TELAEGENT_IDENTITY_PROVIDER=github
AUTHORIZATION_PERSISTENCE=supabase
CONVERSATION_PERSISTENCE=supabase
TELAEGENT_PUBLIC_URL=http://localhost:5173
TELAEGENT_COOKIE_SECRET=${"a".repeat(43)}
GITHUB_OAUTH_CLIENT_ID=client_identifier
GITHUB_OAUTH_CLIENT_SECRET=${"b".repeat(24)}
SUPABASE_URL=https://example.supabase.co
SUPABASE_SECRET_KEY=sb_secret_${"c".repeat(24)}
`);
  assert.deepEqual(inspectEndToEndEnvironment(values), []);
});
