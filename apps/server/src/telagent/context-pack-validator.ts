/**
 * CONTEXTPACK VALIDATOR.
 *
 * A ContextPack candidate is model output built from files that are themselves
 * untrusted text. This module is the last gate before that artifact reaches
 * Alice, and it is deliberately paranoid in a fixed order:
 *
 *   1  request approved, same project + task, current version, not expired
 *   2  candidate parses its schema
 *   3  at least one source
 *   4  every cited source exists in the TRUSTED manifest
 *   5  no cited source falls outside the approved rules
 *   6  task scope matches the request
 *   7  pack expiry does not outlive the approval
 *   8  size limits
 *   9  secret-like content in any textual field
 *   10 prompt-injection indicators in any textual field
 *   11 model-supplied commit/hash metadata REPLACED with manifest values
 *   12 a NEW object is returned; the candidate is never mutated or persisted
 *
 * If redaction would destroy the meaning or the source integrity, this rejects
 * rather than delivering something partially true.
 */

import { z } from "zod";
import {
  CONTEXT_LIMITS,
  type DenialCode,
  type ResolvedSourceGrant,
  type ValidatedContextPack,
} from "./contract.js";
import type { NormalizedRule, PolicyResult } from "./context-policy.js";
import { matchesRules, normalizeSourcePath } from "./context-policy.js";
import type { TrustedManifest } from "./context-workspace.js";
import { containsSecretLikeContent } from "./redaction.js";

/* ========================================================================== *
 * Candidate schema.
 *
 * Duy's `createContextPackInputSchema` is the contract, but it requires a
 * `commit` and `sha256` on every source. Those are exactly the two fields this
 * validator refuses to trust — step 11 overwrites both from the manifest. So
 * the candidate is parsed with a *relaxed* copy that accepts them as optional
 * and ignores their values, which means a model that guesses wrong is rejected
 * for citing an unknown source, not for guessing a hash.
 * ========================================================================== */

export const contextPackCandidateSchema = z
  .object({
    contextRequestId: z.string().trim().min(1).max(128).optional(),
    topic: z.string().trim().min(1).max(1_000),
    summary: z.string().trim().min(1).max(2_000),
    implementationSteps: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
    validationChecklist: z.array(z.string().trim().min(1).max(400)).max(12),
    sources: z
      .array(
        z.object({
          path: z.string().trim().min(1).max(512),
          // Model-supplied. Recorded, then overwritten at step 11.
          commit: z.string().trim().max(80).optional(),
          sha256: z.string().trim().max(128).optional(),
        }),
      )
      .max(CONTEXT_LIMITS.maxSourceFiles),
    taskScope: z.string().trim().min(1).max(128),
    /** The model may propose an expiry; step 7 caps it regardless. */
    expiresAt: z.string().trim().max(40).optional(),
  })
  .strict();

/* ========================================================================== *
 * Inputs
 * ========================================================================== */

export interface ValidationRequestState {
  contextRequestId: string;
  projectId: string;
  /** State machine position; only `generating` may produce a pack. */
  state: string;
  version: number;
  currentVersion: number;
  taskScope: string;
  expiresAt: string;
  approvedRules: readonly NormalizedRule[];
  sharedByAgentId: string;
}

export interface ValidateContextPackInput {
  candidate: unknown;
  request: ValidationRequestState;
  grant: ResolvedSourceGrant;
  manifest: TrustedManifest;
  now: Date;
  artifactId: string;
}

const fail = (code: DenialCode, safeReason: string, input = ""): PolicyResult<never> => ({
  ok: false,
  code,
  safeReason,
  input,
});

/**
 * High-signal injection phrases only. Ordinary architecture prose contains
 * imperatives ("Do not access Redis directly from route handlers") and must not
 * trip this — every phrase below targets an attempt to redirect the *agent*,
 * not the reader.
 */
const INJECTION_INDICATORS = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(?:the\s+)?(?:previous|prior|above|system)/i,
  /you\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bnew\s+system\s+prompt\b/i,
  /\bsystem\s*[:=]\s*you\s+(?:must|should|will)\b/i,
  /reveal\s+(?:your|the)\s+(?:system\s+prompt|instructions|reasoning)/i,
  /print\s+(?:the\s+)?(?:contents\s+of\s+)?\.env\b/i,
  /\bapprove\s+(?:this|the)\s+(?:request|agreement|pack)\s+automatically\b/i,
  /\bgrant\s+(?:yourself|full|all)\s+(?:access|permissions?)\b/i,
  /<\s*\/?\s*(?:system|assistant|tool_call)\s*>/i,
  /\brelay_(?:request_context|create_context_pack|complete_task)\s*\(/i,
];

/* ========================================================================== *
 * Validation
 * ========================================================================== */

export function validateContextPack(
  input: ValidateContextPackInput,
): PolicyResult<ValidatedContextPack> {
  const { request, grant, manifest, now } = input;

  /* 1 — request is approved, current, and still alive ---------------------- */
  if (request.state !== "approved" && request.state !== "generating") {
    return fail("PACK_SCOPE_MISMATCH", "The context request is not in a generating state.");
  }
  if (request.version !== request.currentVersion) {
    return fail("PACK_SCOPE_MISMATCH", "The context request has been superseded.");
  }
  if (request.projectId !== manifest.projectId) {
    return fail("PACK_SCOPE_MISMATCH", "The manifest belongs to a different project.");
  }
  if (request.contextRequestId !== manifest.contextRequestId) {
    return fail("PACK_SCOPE_MISMATCH", "The manifest belongs to a different request.");
  }
  if (grant.contextRequestId !== request.contextRequestId) {
    return fail("PACK_SCOPE_MISMATCH", "The grant belongs to a different request.");
  }
  const approvalExpiry = new Date(grant.expiresAt).getTime();
  if (!Number.isFinite(approvalExpiry) || approvalExpiry <= now.getTime()) {
    return fail("PACK_EXPIRED", "The source approval has expired.");
  }
  if (new Date(request.expiresAt).getTime() <= now.getTime()) {
    return fail("PACK_EXPIRED", "The context request has expired.");
  }
  if (grant.sourceCommit !== manifest.sourceCommit) {
    return fail(
      "PACK_STALE_SOURCE",
      "The approved commit and the generated manifest disagree.",
    );
  }

  /* 2 — candidate parses --------------------------------------------------- */
  const parsed = contextPackCandidateSchema.safeParse(input.candidate);
  if (!parsed.success) {
    return fail(
      "PACK_SCOPE_MISMATCH",
      "The pack did not match its output schema: " +
        parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join(".") || "(root)")
          .join(", "),
    );
  }
  const candidate = parsed.data;

  /* 3 — at least one source ------------------------------------------------ */
  if (candidate.sources.length === 0) {
    return fail("PACK_NO_SOURCES", "A ContextPack must cite at least one source.");
  }

  /* 4 & 5 — every source is in the manifest AND inside the approved rules --- */
  const manifestByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const citedPaths: string[] = [];

  for (const source of candidate.sources) {
    const normalized = normalizeSourcePath(source.path);
    if (!normalized.ok) return normalized;

    if (!matchesRules(normalized.value, request.approvedRules)) {
      return fail(
        "FORBID_UNAPPROVED_PATH",
        "The pack cites a source outside the approved scope.",
        normalized.value,
      );
    }
    if (!manifestByPath.has(normalized.value)) {
      return fail(
        "PACK_STALE_SOURCE",
        "The pack cites a source that was never copied into the isolated workspace.",
        normalized.value,
      );
    }
    if (citedPaths.includes(normalized.value)) continue;
    citedPaths.push(normalized.value);
  }

  /* 6 — task scope --------------------------------------------------------- */
  if (candidate.taskScope !== request.taskScope || candidate.taskScope !== grant.taskScope) {
    return fail(
      "PACK_SCOPE_MISMATCH",
      "The pack scope does not match the approved task scope.",
    );
  }

  /* 7 — expiry does not outlive the approval ------------------------------- */
  const packExpiry = Math.min(
    now.getTime() + CONTEXT_LIMITS.packTtlMs,
    approvalExpiry,
  );

  /* 9 & 10 — secrets and injection indicators, before size ----------------- */
  const textualFields = [
    candidate.topic,
    candidate.summary,
    ...candidate.implementationSteps,
    ...candidate.validationChecklist,
  ];

  for (const field of textualFields) {
    if (containsSecretLikeContent(field)) {
      // Deliberately not redacted-and-delivered: a pack that needed a secret to
      // make its point is not a pack Alice can trust.
      return fail(
        "PACK_SECRET_CONTENT",
        "The pack contained credential-like content and was rejected rather than redacted.",
      );
    }
  }
  for (const field of textualFields) {
    for (const indicator of INJECTION_INDICATORS) {
      if (indicator.test(field)) {
        return fail(
          "PACK_INJECTION_INDICATORS",
          "The pack contained instructions aimed at the receiving Agent and was rejected.",
        );
      }
    }
  }

  /* 11 — trusted metadata replaces model metadata -------------------------- */
  const sources = citedPaths.map((citedPath) => {
    const entry = manifestByPath.get(citedPath);
    /* c8 ignore next */
    if (!entry) throw new Error("unreachable: cited path verified above");
    return { path: entry.path, commit: entry.commit, sha256: entry.sha256 };
  });

  /* 12 — a new object; the candidate is never mutated or stored ------------ */
  const validated: ValidatedContextPack = {
    artifactId: input.artifactId,
    requestId: request.contextRequestId,
    projectId: request.projectId,
    topic: candidate.topic,
    summary: candidate.summary,
    implementationSteps: [...candidate.implementationSteps],
    validationChecklist: [...candidate.validationChecklist],
    sources,
    sharedBy: request.sharedByAgentId,
    taskScope: request.taskScope,
    expiresAt: new Date(packExpiry).toISOString(),
    bytes: 0,
    state: "validated",
  };

  /* 8 — size, measured on the artifact that would actually be stored -------- */
  const bytes = Buffer.byteLength(JSON.stringify(validated), "utf8");
  if (bytes > CONTEXT_LIMITS.maxPackBytes) {
    return fail(
      "LIMIT_PACK_TOO_LARGE",
      "The validated pack exceeds " + CONTEXT_LIMITS.maxPackBytes + " bytes.",
    );
  }

  return { ok: true, value: { ...validated, bytes } };
}

/** True once the pack's own TTL has passed. Khoa expires on this. */
export function isPackExpired(pack: ValidatedContextPack, now: Date): boolean {
  return new Date(pack.expiresAt).getTime() <= now.getTime();
}
