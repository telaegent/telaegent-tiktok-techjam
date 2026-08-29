import { normalizeProtocolPath } from "./schemas.js";
import type {
  ExistingApprovalScope,
  PermissionClass,
  PermissionDecision,
  PermissionEvaluationContext,
  RequestHumanDecisionInput,
} from "./types.js";

const forbiddenNamePattern =
  /(?:^|[._-])(secret|secrets|credential|credentials|token|tokens|api[_-]?key|private[_-]?key|id_rsa|ssh|aws)(?:[._-]|$)/i;
const forbiddenContentRequestPattern =
  /\b(hidden reasoning|chain[- ]of[- ]thought|private transcript|full transcript|api key|credentials?|private key)\b/i;

function deny(code: string, safeReason: string): PermissionDecision {
  return { kind: "deny", permissionClass: "ALWAYS_DENY", code, safeReason };
}

function allow(safeScope: unknown): PermissionDecision {
  return { kind: "allow", permissionClass: "AUTO_METADATA", safeScope };
}

function askHuman(
  permissionClass: Exclude<PermissionClass, "AUTO_METADATA" | "ALWAYS_DENY">,
  approverOwnerIds: string[],
  expiresAt: string,
  safeScope: unknown,
): PermissionDecision {
  return { kind: "ask_human", permissionClass, approverOwnerIds, expiresAt, safeScope };
}

function forbiddenPathRule(pathRule: string): string | null {
  const normalized = normalizeProtocolPath(pathRule).toLocaleLowerCase("en-US");
  const segments = normalized.replace(/\/\*\*$/, "").split("/");
  if (segments.some((segment) => segment === ".git")) return "FORBID_GIT_METADATA";
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    return "FORBID_ENV_FILES";
  }
  if (segments.some((segment) => forbiddenNamePattern.test(segment))) {
    return "FORBID_SECRET_LIKE_PATH";
  }
  return null;
}

function pathMatchesRule(file: string, rule: string): boolean {
  const normalizedFile = normalizeProtocolPath(file);
  const normalizedRule = normalizeProtocolPath(rule);
  if (normalizedRule.endsWith("/**")) {
    const prefix = normalizedRule.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  return normalizedFile === normalizedRule;
}

function isApprovalUsable(
  approval: ExistingApprovalScope | undefined,
  permissionClass: ExistingApprovalScope["permissionClass"],
  now: string,
): approval is ExistingApprovalScope {
  return (
    approval?.permissionClass === permissionClass &&
    Date.parse(approval.expiresAt) > Date.parse(now) &&
    approval.approvedByOwnerIds.length > 0
  );
}

function derivedHumanDecision(
  payload: RequestHumanDecisionInput,
  context: PermissionEvaluationContext,
): PermissionDecision {
  switch (payload.reasonCode) {
    case "SOURCE_ACCESS_REQUIRED":
      if (!context.request.recipient) {
        return deny("RECIPIENT_REQUIRED", "Source access requires a recipient owner");
      }
      return askHuman(
        "RECIPIENT_SOURCE_APPROVAL",
        [context.request.recipient.ownerId],
        context.request.delivery.expiresAt,
        { reasonCode: payload.reasonCode, optionIds: payload.options.map((option) => option.id) },
      );
    case "DUAL_COMMITMENT_REQUIRED":
    case "AMBIGUOUS_RESOLUTION":
      if (!context.participantOwnerIds) {
        return deny("PARTICIPANTS_REQUIRED", "Dual commitment requires two participant owners");
      }
      return askHuman(
        "DUAL_OWNER_COMMITMENT",
        [...context.participantOwnerIds],
        context.request.delivery.expiresAt,
        { reasonCode: payload.reasonCode, optionIds: payload.options.map((option) => option.id) },
      );
    case "AFFECTED_PLAN_APPROVAL_REQUIRED":
    case "STALE_STATUS":
    case "EXCHANGE_LIMIT_REACHED":
      return askHuman(
        "AFFECTED_OWNER_APPROVAL",
        [context.affectedOwnerId ?? context.request.sender.ownerId],
        context.request.delivery.expiresAt,
        { reasonCode: payload.reasonCode, optionIds: payload.options.map((option) => option.id) },
      );
  }
}

function validateTrustBoundary(context: PermissionEvaluationContext): PermissionDecision | null {
  const { request, authenticatedActor } = context;
  if (Date.parse(request.delivery.expiresAt) <= Date.parse(context.now)) {
    return deny("REQUEST_EXPIRED", "The request has expired");
  }
  if (authenticatedActor.projectId !== request.projectId) {
    return deny("PROJECT_SCOPE_MISMATCH", "The request is outside the authenticated project");
  }
  if (
    authenticatedActor.ownerId !== request.sender.ownerId ||
    (authenticatedActor.actorType === "agent" &&
      authenticatedActor.agentId !== request.sender.agentId)
  ) {
    return deny("SENDER_IDENTITY_MISMATCH", "The request sender does not match the authenticated actor");
  }
  if (
    authenticatedActor.provider &&
    authenticatedActor.provider !== request.sender.provider
  ) {
    return deny("PROVIDER_IDENTITY_MISMATCH", "The provider claim does not match the Agent binding");
  }
  if (!context.projectAgentIds.includes(request.sender.agentId)) {
    return deny("SENDER_NOT_IN_PROJECT", "The sender Agent is not bound to the project");
  }
  if (request.recipient && !context.projectAgentIds.includes(request.recipient.agentId)) {
    return deny("RECIPIENT_NOT_IN_PROJECT", "The recipient Agent is not bound to the project");
  }
  return null;
}

export function evaluatePermission(context: PermissionEvaluationContext): PermissionDecision {
  const trustFailure = validateTrustBoundary(context);
  if (trustFailure) return trustFailure;

  const { request } = context;
  if (context.statusStale && request.operation !== "relay_update_progress") {
    return askHuman(
      "AFFECTED_OWNER_APPROVAL",
      [context.affectedOwnerId ?? request.sender.ownerId],
      request.delivery.expiresAt,
      { reason: "STALE_STATUS", requestId: request.requestId },
    );
  }

  switch (request.operation) {
    case "relay_publish_intent":
    case "relay_update_progress":
    case "relay_ask_status":
    case "relay_report_dependency_change":
    case "relay_complete_task":
      return allow({
        projectId: request.projectId,
        senderAgentId: request.sender.agentId,
        operation: request.operation,
      });
    case "relay_request_context": {
      if (
        forbiddenContentRequestPattern.test(request.payload.topic) ||
        forbiddenContentRequestPattern.test(request.payload.purpose)
      ) {
        return deny("FORBIDDEN_INFORMATION_REQUEST", "Private or credential-bearing information cannot be shared");
      }
      for (const pathRule of request.payload.requestedPaths) {
        const rule = forbiddenPathRule(pathRule);
        if (rule) return deny(rule, "The requested path is always forbidden");
      }
      if (!request.recipient) {
        return deny("RECIPIENT_REQUIRED", "Context requests require a recipient owner");
      }
      return askHuman(
        "RECIPIENT_SOURCE_APPROVAL",
        [request.recipient.ownerId],
        request.delivery.expiresAt,
        {
          projectId: request.projectId,
          purpose: request.payload.purpose,
          requestedPaths: request.payload.requestedPaths,
          persistence: request.payload.persistence,
        },
      );
    }
    case "relay_create_context_pack": {
      if (
        !isApprovalUsable(
          context.existingApproval,
          "RECIPIENT_SOURCE_APPROVAL",
          context.now,
        )
      ) {
        return deny("SOURCE_APPROVAL_REQUIRED", "A current source approval is required");
      }
      const approvedRules = context.existingApproval.approvedPaths ?? [];
      const outsideScope = request.payload.sources.find(
        (source) => !approvedRules.some((rule) => pathMatchesRule(source.path, rule)),
      );
      if (outsideScope) {
        return deny("SOURCE_OUTSIDE_APPROVED_SCOPE", "A cited source is outside the approved scope");
      }
      return allow({
        approvalVersion: context.existingApproval.targetVersion,
        sourcePaths: request.payload.sources.map((source) => source.path),
      });
    }
    case "relay_suggest_resolution": {
      if (!context.participantOwnerIds) {
        return deny("PARTICIPANTS_REQUIRED", "Resolution requires both participant owners");
      }
      return askHuman(
        "DUAL_OWNER_COMMITMENT",
        [...context.participantOwnerIds],
        request.delivery.expiresAt,
        {
          coordinationRequestId: request.payload.coordinationRequestId,
          proposalVersion: request.payload.proposalVersion,
        },
      );
    }
    case "relay_propose_replan":
      return askHuman(
        "AFFECTED_OWNER_APPROVAL",
        [context.affectedOwnerId ?? request.sender.ownerId],
        request.delivery.expiresAt,
        {
          dependencyChangeId: request.payload.dependencyChangeId,
          affectedFiles: request.payload.affectedFiles,
        },
      );
    case "relay_request_human_decision":
      return derivedHumanDecision(request.payload, context);
    case "relay_reply": {
      const inherited = context.inheritedPermissionClass;
      if (!inherited) {
        return deny("INHERITED_PERMISSION_REQUIRED", "A reply cannot create a new permission scope");
      }
      if (inherited === "ALWAYS_DENY") {
        return deny("INHERITED_POLICY_DENIED", "The original request was forbidden");
      }
      if (inherited === "AUTO_METADATA") {
        return allow({ replyToRequestId: request.payload.replyToRequestId });
      }
      if (isApprovalUsable(context.existingApproval, inherited, context.now)) {
        return allow({
          replyToRequestId: request.payload.replyToRequestId,
          approvalVersion: context.existingApproval.targetVersion,
        });
      }
      return deny("INHERITED_APPROVAL_REQUIRED", "The original request does not have a current approval");
    }
  }
}

export function canHumanApprove(
  actorType: "human" | "agent",
  ownerId: string,
  decision: Extract<PermissionDecision, { kind: "ask_human" }>,
): boolean {
  return actorType === "human" && decision.approverOwnerIds.includes(ownerId);
}
