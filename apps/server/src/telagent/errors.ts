import { TELAGENT_ERROR_HTTP_STATUS } from "./constants.js";
import type {
  SafeJsonObject,
  TelagentErrorCode,
  TelagentErrorEnvelope,
} from "./types.js";

export interface TelagentErrorContext {
  correlationId: string;
  safeDetails?: SafeJsonObject | undefined;
  auditEventId?: string | undefined;
}

export class TelagentProtocolError extends Error {
  readonly statusCode: (typeof TELAGENT_ERROR_HTTP_STATUS)[TelagentErrorCode];

  constructor(
    public readonly code: TelagentErrorCode,
    message: string,
    public readonly context: TelagentErrorContext,
  ) {
    super(message);
    this.name = "TelagentProtocolError";
    this.statusCode = TELAGENT_ERROR_HTTP_STATUS[code];
  }

  toEnvelope(): TelagentErrorEnvelope {
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
  code: TelagentErrorCode,
  message: string,
  context: TelagentErrorContext,
): TelagentProtocolError {
  return new TelagentProtocolError(code, message, context);
}
