import { TELAEGENT_ERROR_HTTP_STATUS } from "./constants.js";
import type {
  SafeJsonObject,
  TelaegentErrorCode,
  TelaegentErrorEnvelope,
} from "./types.js";

export interface TelaegentErrorContext {
  correlationId: string;
  safeDetails?: SafeJsonObject | undefined;
  auditEventId?: string | undefined;
}

export class TelaegentProtocolError extends Error {
  readonly statusCode: (typeof TELAEGENT_ERROR_HTTP_STATUS)[TelaegentErrorCode];

  constructor(
    public readonly code: TelaegentErrorCode,
    message: string,
    public readonly context: TelaegentErrorContext,
  ) {
    super(message);
    this.name = "TelaegentProtocolError";
    this.statusCode = TELAEGENT_ERROR_HTTP_STATUS[code];
  }

  toEnvelope(): TelaegentErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.context.safeDetails ? { safeDetails: this.context.safeDetails } : {}),
        correlationId: this.context.correlationId,
        ...(this.context.auditEventId ? { auditEventId: this.context.auditEventId } : {}),
      },
    };
  }
}

export function protocolError(
  code: TelaegentErrorCode,
  message: string,
  context: TelaegentErrorContext,
): TelaegentProtocolError {
  return new TelaegentProtocolError(code, message, context);
}
