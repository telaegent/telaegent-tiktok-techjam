const MAX_ERROR_BODY_BYTES = 4_096;
const safeServerCode = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Safe connector-facing HTTP failure. It deliberately retains only protocol
 * metadata: status and a bounded machine code. Response messages can contain
 * validation input or private runtime detail and are never copied here.
 */
export class ConnectorHttpResponseError extends Error {
  constructor(
    operation: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Telaegent connector ${operation} failed (HTTP ${status}, code ${code})`);
    this.name = "ConnectorHttpResponseError";
  }
}

export async function connectorHttpResponseError(
  response: Response,
  operation: string,
): Promise<ConnectorHttpResponseError> {
  const body = await readBoundedBody(response);
  let code = `HTTP_${response.status}`;
  if (body !== null) {
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed.code === "string" && safeServerCode.test(parsed.code)) {
        code = parsed.code;
      }
    } catch {
      // A non-JSON body contributes no diagnostic data. Status is sufficient.
    }
  }
  return new ConnectorHttpResponseError(operation, response.status, code);
}

async function readBoundedBody(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) return "";
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ERROR_BODY_BYTES) {
    await body.cancel();
    return null;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
