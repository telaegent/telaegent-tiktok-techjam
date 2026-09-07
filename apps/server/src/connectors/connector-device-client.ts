import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const issuedSchema = z.strictObject({
  deviceAuthorization: z.strictObject({
    deviceCode: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
    userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
    intervalSeconds: z.number().int().min(1).max(30),
  }),
});
const approvedSchema = z.strictObject({
  outcome: z.literal("approved"),
  connector: z.strictObject({
    connectorInstanceId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
    expiresAt: z.string().datetime({ offset: true }),
  }),
});

export function createConnectorInstanceId(): string {
  return `connector_${randomUUID().replaceAll("-", "")}`;
}

export interface ConnectorDeviceClientDependencies {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<void>;
}

export async function authorizeConnectorDevice(
  serverOrigin: string,
  connectorInstanceId: string,
  fetchImplementation: typeof fetch = fetch,
  dependencies: ConnectorDeviceClientDependencies = {},
): Promise<{ credential: string; connectorInstanceId: string }> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? delay;
  const launchBrowser = dependencies.openBrowser ?? openBrowser;
  const credential = randomBytes(32).toString("base64url");
  const issuedResponse = await fetchImplementation(
    new URL("/api/connectors/device-authorizations", serverOrigin),
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        connectorInstanceId,
        credentialHash: createHash("sha256").update(credential, "utf8").digest("hex"),
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!issuedResponse.ok) throw new Error("Telaegent device authorization could not start");
  const issued = issuedSchema.parse(await issuedResponse.json()).deviceAuthorization;
  const approvalUrl = new URL("/app/connect-device", serverOrigin);
  approvalUrl.searchParams.set("code", issued.userCode);
  const verificationUriComplete = approvalUrl.toString();
  process.stdout.write(
    [
      "TELAEGENT AUTHORIZATION REQUIRED",
      `Open: ${verificationUriComplete}`,
      `Code: ${issued.userCode}`,
      "Waiting for approval in your browser...",
      "",
    ].join("\n"),
  );
  void launchBrowser(verificationUriComplete).catch(() => {
    process.stderr.write("Could not open a browser automatically; use the URL above.\n");
  });

  const expiresAtMs = Date.parse(issued.expiresAt);
  let intervalMs = issued.intervalSeconds * 1_000;
  for (;;) {
    if (now() >= expiresAtMs) throw new Error("Telaegent device authorization expired");
    await sleep(intervalMs);
    let response: Response;
    try {
      response = await fetchImplementation(
        new URL("/api/connectors/device-authorizations/token", serverOrigin),
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: issued.deviceCode }),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 201) {
      const parsed = approvedSchema.safeParse(body);
      if (!parsed.success) continue;
      const approved = parsed.data.connector;
      if (approved.connectorInstanceId !== connectorInstanceId) {
        throw new Error("Telaegent approved another connector installation");
      }
      return { credential, connectorInstanceId: approved.connectorInstanceId };
    }
    if (response.status === 202) continue;
    if (response.status === 429) {
      intervalMs = Math.min(30_000, intervalMs + 2_000);
      continue;
    }
    if (response.status >= 500) continue;
    if (response.status === 403) throw new Error("Telaegent device authorization was denied");
    if (response.status === 410) throw new Error("Telaegent device authorization expired");
    throw new Error("Telaegent device authorization failed");
  }
}

async function openBrowser(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true });
  } else if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
  } else {
    await execFileAsync("xdg-open", [url]);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
