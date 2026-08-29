/**
 * REDACTION — pure, bounded, synchronous. Khoa calls this on every conversation
 * entry before it is appended (khoa.md §12), so it must be cheap and must never
 * throw.
 *
 * Contract: the original value never appears in the return value, in a reason
 * code, or in a thrown error. Callers get the redacted text plus *why*, and
 * that is all.
 */

export const REDACTION_REASONS = [
  "AUTHORIZATION_HEADER",
  "API_KEY",
  "PRIVATE_KEY_BLOCK",
  "CREDENTIAL_ASSIGNMENT",
  "CONNECTION_STRING",
  "ABSOLUTE_LOCAL_PATH",
  "PROVIDER_SESSION_ID",
  "JWT",
] as const;

export type RedactionReason = (typeof REDACTION_REASONS)[number];

export interface RedactionResult {
  value: string;
  reasons: RedactionReason[];
  count: number;
}

const PLACEHOLDER = "[redacted]";

interface Pattern {
  reason: RedactionReason;
  expression: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

/**
 * Order matters: the most specific structures come first so a private key block
 * is not first mangled by the generic assignment rule.
 */
const PATTERNS: Pattern[] = [
  {
    reason: "PRIVATE_KEY_BLOCK",
    expression:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replace: () => PLACEHOLDER,
  },
  {
    reason: "AUTHORIZATION_HEADER",
    expression: /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[\w\-._~+/]+=*/gi,
    replace: (_match, prefix) => prefix + PLACEHOLDER,
  },
  {
    reason: "AUTHORIZATION_HEADER",
    expression: /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi,
    replace: () => PLACEHOLDER,
  },
  {
    reason: "JWT",
    expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => PLACEHOLDER,
  },
  {
    reason: "API_KEY",
    // sk-…, ghp_…, xoxb-…, AKIA…, AIza… and the ark key shape.
    expression:
      /\b(?:sk-[A-Za-z0-9-]{12,}|rk-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b/g,
    replace: () => PLACEHOLDER,
  },
  {
    reason: "CONNECTION_STRING",
    expression: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
    replace: () => PLACEHOLDER,
  },
  {
    reason: "CREDENTIAL_ASSIGNMENT",
    expression:
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;"'}\]]+)/gi,
    replace: (_match, name, separator) => name + separator + PLACEHOLDER,
  },
  {
    reason: "PROVIDER_SESSION_ID",
    expression: /\b(?:session[_-]?id|thread[_-]?id)(\s*[:=]\s*)[A-Za-z0-9-]{8,}/gi,
    replace: (_match, separator) => "sessionId" + separator + PLACEHOLDER,
  },
  {
    reason: "ABSOLUTE_LOCAL_PATH",
    // POSIX home and Windows user directories, plus provider homes.
    expression: /(?:\/(?:home|Users|root)\/[^\s"',;)\]]+|[A-Za-z]:\\Users\\[^\s"',;)\]]+)/g,
    replace: () => PLACEHOLDER,
  },
];

const MAX_INPUT_CHARS = 20_000;

/** Redacts one string. Bounded: input longer than 20k characters is truncated. */
export function redactText(input: string): RedactionResult {
  if (typeof input !== "string" || input.length === 0) {
    return { value: "", reasons: [], count: 0 };
  }
  let value = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) + "…" : input;
  const reasons: RedactionReason[] = [];
  let count = 0;

  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0;
    let matched = false;
    value = value.replace(pattern.expression, (...args) => {
      matched = true;
      count += 1;
      const groups = args.slice(1, -2) as string[];
      return pattern.replace(args[0] as string, ...groups);
    });
    if (matched && !reasons.includes(pattern.reason)) reasons.push(pattern.reason);
  }

  return { value, reasons, count };
}

/**
 * Deep-redacts a JSON-safe value. Object keys are preserved; string values and
 * keys that are themselves credential-shaped are redacted.
 */
export function redactValue<T>(input: T): { value: T; reasons: RedactionReason[]; count: number } {
  const reasons = new Set<RedactionReason>();
  let count = 0;

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 12) return "[depth-limited]";
    if (typeof node === "string") {
      const result = redactText(node);
      for (const reason of result.reasons) reasons.add(reason);
      count += result.count;
      return result.value;
    }
    if (Array.isArray(node)) return node.slice(0, 200).map((item) => walk(item, depth + 1));
    if (node && typeof node === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) {
          reasons.add("CREDENTIAL_ASSIGNMENT");
          count += 1;
          output[key] = PLACEHOLDER;
          continue;
        }
        output[key] = walk(item, depth + 1);
      }
      return output;
    }
    return node;
  };

  return { value: walk(input, 0) as T, reasons: [...reasons], count };
}

const SENSITIVE_KEY =
  /^(?:.*(?:api[_-]?key|secret|token|password|passwd|credential|authorization|private[_-]?key).*|sessionId|threadId|providerSessionId|runtimePrompt)$/i;

/** True when a value still looks like it carries a secret after redaction. */
export function containsSecretLikeContent(input: string): boolean {
  return redactText(input).count > 0;
}

/**
 * Bounded plain-text summary for the shared conversation. Redacts first, then
 * truncates, so a secret can never survive by sitting past the cut.
 */
export function toSafeSummary(input: string, maxChars: number): string {
  const redacted = redactText(input).value.replace(/\s+/g, " ").trim();
  return redacted.length > maxChars ? redacted.slice(0, maxChars - 1) + "…" : redacted;
}
