/**
 * Every connector transport route must be in its own allowlist.
 *
 * `app.ts` runs an `APP_AUTH_TOKEN` pre-handler in front of everything under
 * `/api/`, and a route escapes it only by appearing in the module's exported
 * route set. Registering a route is one edit; allowlisting it is another, in a
 * different place, and nothing links the two.
 *
 * That gap has now shipped twice. `/api/runtime/models` 401'd for every signed
 * -in browser until #157 added it by hand, and
 * `/api/connectors/bindings/:connectorBindingId/probing` 401'd for every
 * connector -- new bindings included -- because it was registered beside
 * `/probe` and `/ready` but never added beside them in the set.
 *
 * Both were invisible to the suite: nothing sets `APP_AUTH_TOKEN`, so the
 * pre-handler never ran in a test. This asserts the relationship directly
 * instead of waiting for the next route to be forgotten.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ConnectorCredentialService } from "./connector-credentials.js";
import { createConnectorPrincipalResolver } from "./connector-credentials.js";
import { LongPollConnectorJobRelay } from "./long-poll-job-relay.js";
import { connectorTransportRoutes } from "./routes.js";

/** Credentials the resolver can be built from; no request reaches it here. */
class UnusedCredentialRepository {
  async insert(): Promise<void> {}
  async find(): Promise<null> {
    return null;
  }
  async revoke(): Promise<void> {}
  async setupStatus(): Promise<null> {
    return null;
  }
}

async function connectorRoutesRegisteredBy(): Promise<string[]> {
  const credentials = new ConnectorCredentialService(
    new UnusedCredentialRepository() as never,
    3_600,
  );
  const registered = new Set<string>();
  const app = await createApp(
    loadConfig({ NODE_ENV: "test" }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      relay: new LongPollConnectorJobRelay(),
      credentials,
      authenticatedUserId: async () => "11111111-1111-4111-8111-111111111111",
      resolveConnectorPrincipal: createConnectorPrincipalResolver(credentials),
    },
  );
  // `onRoute` has already fired for everything by the time the instance is
  // ready, so read the routing table rather than hooking it.
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = /(\/api\/connectors\/[^\s(]*)/.exec(line);
    if (match?.[1]) registered.add(match[1].replace(/\/$/, ""));
  }
  await app.close();
  return [...registered];
}

describe("connector transport route authorization", () => {
  it("allowlists every connector route it registers", async () => {
    const registered = await connectorRoutesRegisteredBy();

    // A sanity floor: if the scrape returns nothing, the assertion below would
    // pass vacuously and hide exactly the bug it exists to catch.
    expect(registered.length).toBeGreaterThan(5);

    const missing = registered.filter(
      (url) => !connectorTransportRoutes.has(url),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the three binding lifecycle routes together", async () => {
    // These are registered adjacently and were the site of the omission: one
    // of the three was allowlisted late, so name them explicitly.
    for (const url of [
      "/api/connectors/bindings/:connectorBindingId/probing",
      "/api/connectors/bindings/:connectorBindingId/probe",
      "/api/connectors/bindings/:connectorBindingId/ready",
    ]) {
      expect(connectorTransportRoutes.has(url)).toBe(true);
    }
  });
});
