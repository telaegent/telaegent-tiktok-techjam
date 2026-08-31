import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorValuesInApplicationEnvironment,
  inspectConnectorEnvironment,
  inspectEndToEndEnvironment,
  nodeMajor,
  parseEnvFile,
  renderConnectorEnv,
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

test("creates a stable connector installation file without inventing a bearer", () => {
  const rendered = renderConnectorEnv(
    "TELAEGENT_URL=http://localhost:3000\nTELAEGENT_CONNECTOR_INSTANCE_ID=replace-me\nTELAEGENT_CONNECTOR_CREDENTIAL=\n",
    { instanceId: "local-connector-test" },
  );
  assert.match(rendered, /^TELAEGENT_CONNECTOR_INSTANCE_ID=local-connector-test$/mu);
  assert.match(rendered, /^TELAEGENT_CONNECTOR_CREDENTIAL=$/mu);
});

test("validates connector configuration separately from application configuration", () => {
  const complete = parseEnvFile(`
TELAEGENT_URL=http://localhost:3000
TELAEGENT_CONNECTOR_INSTANCE_ID=local-connector-test
TELAEGENT_CONNECTOR_CREDENTIAL=${"a".repeat(40)}
`);
  assert.deepEqual(inspectConnectorEnvironment(complete), []);
  assert.ok(
    inspectConnectorEnvironment(parseEnvFile("TELAEGENT_URL=http://example.com\n"))
      .includes("TELAEGENT_URL is not a safe connector origin"),
  );
});

test("detects connector-only values misplaced in the application env", () => {
  const values = parseEnvFile("PORT=3000\nTELAEGENT_CONNECTOR_CREDENTIAL=secret\n");
  assert.deepEqual(connectorValuesInApplicationEnvironment(values), [
    "TELAEGENT_CONNECTOR_CREDENTIAL",
  ]);
});
