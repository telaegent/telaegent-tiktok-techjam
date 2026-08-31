/**
 * Minimal backend-only PostgREST RPC transport.
 *
 * It deliberately does not send an Authorization bearer header: modern
 * `sb_secret_...` keys are API keys, not user JWTs. The `apikey` header selects
 * the trusted service role, while browser roles have no execute privilege on
 * any Telaegent RPC.
 *
 * Responses are read under a hard byte ceiling so a misbehaving or hostile
 * database endpoint cannot exhaust server memory, and no response body, URL, or
 * transport detail is ever attached to a thrown error.
 *
 * `apps/server/src/authorization/supabase-authorization-client.ts` predates this
 * module and carries its own equivalent copy. Collapsing the two is worthwhile
 * but belongs to whoever owns the authorization client.
 */

import { isSafeSupabaseOrigin } from "./supabase-origin.js";

const defaultMaximumResponseBytes = 1_048_576;
const secretKeyPattern = /^sb_secret_[A-Za-z0-9_-]{20,480}$/;
const functionNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

export interface SupabaseRpcTransportOptions {
  supabaseUrl: string;
  secretKey: string;
  /** Test seam; production uses Node's global fetch. */
  fetch?: typeof fetch | undefined;
  maximumResponseBytes?: number | undefined;
}

export class SupabaseRpcTransport {
  readonly #origin: string;
  readonly #secretKey: string;
  readonly #fetch: typeof fetch;
  readonly #maximumResponseBytes: number;

  constructor(options: Readonly<SupabaseRpcTransportOptions>) {
    const url = validateSupabaseUrl(options.supabaseUrl);
    if (!secretKeyPattern.test(options.secretKey)) {
      throw configurationError();
    }
    const maximumResponseBytes =
      options.maximumResponseBytes ?? defaultMaximumResponseBytes;
    if (
      !Number.isInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1_024 ||
      maximumResponseBytes > 16_777_216
    ) {
      throw configurationError();
    }
    this.#origin = url.origin;
    this.#secretKey = options.secretKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maximumResponseBytes = maximumResponseBytes;
    if (typeof this.#fetch !== "function") {
      throw configurationError();
    }
  }

  /**
   * Calls one database function and returns its untrusted JSON result.
   *
   * A successful-but-unparseable response resolves to `undefined` so a strict
   * caller-side mapper classifies it as an invalid payload rather than as a
   * transport failure. Only genuine transport or non-2xx responses reject.
   */
  async call(
    functionName: string,
    params: Readonly<Record<string, unknown>>,
    options?: Readonly<{ signal?: AbortSignal | undefined }>,
  ): Promise<unknown> {
    // The function name becomes a URL path segment, so it is restricted to a
    // conservative identifier shape rather than escaped.
    if (!functionNamePattern.test(functionName)) {
      throw new Error("Supabase RPC function name is invalid");
    }

    const response = await this.#fetch(this.#origin + "/rest/v1/rpc/" + functionName, {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: this.#secretKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      await discardBody(response);
      throw new Error("Supabase RPC is unavailable");
    }

    const text = await readBoundedBody(response, this.#maximumResponseBytes);
    if (text === null) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}

function validateSupabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }
  if (!isSafeSupabaseOrigin(url)) {
    throw configurationError();
  }
  return url;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      await discardBody(response);
      return null;
    }
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is invalid regardless of cancellation outcome.
        }
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response bodies and transport details are intentionally never surfaced.
  }
}

function configurationError(): Error {
  // Never include configuration values: this error can reach startup logs.
  return new Error("Supabase RPC transport configuration is invalid");
}
