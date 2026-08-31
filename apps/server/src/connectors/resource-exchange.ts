import { z } from "zod";
import { LocalFileBroker, isBrokerFailure, type DeliveredSnapshotAudit } from "./file-broker.js";
import {
  DEFAULT_RESOURCE_POLICY_LIMITS,
  decideResourceRequest,
  type AssertedGrant,
  type ResourceDenyCode,
  type ResourcePolicyLimits,
} from "./resource-policy.js";
import { resourceIdSchema, type ResourceRegistry } from "./resource-registry.js";

const reason = z.string().min(1).max(2_000).refine((value) => !value.includes("\0"));

/**
 * What a peer's agent may say.
 *
 * Either it names an identifier it was already given, or it describes the file
 * it believes it needs. There is deliberately no third form: an agent can never
 * express a canonical path, so it can never reach outside what it was handed.
 */
export const connectorResourceRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("resource"),
    resourceId: resourceIdSchema,
    reason,
  }),
  z.strictObject({
    kind: z.literal("hint"),
    // Bounded project-relative text (build plan 8.3). Never resolved locally;
    // it exists to be shown to the owning human, who chooses the file.
    hint: z.string().min(1).max(512).refine((value) => !value.includes("\0")),
    reason,
  }),
]);

export type ConnectorResourceRequest = z.infer<typeof connectorResourceRequestSchema>;

export const assertedGrantSchema = z.strictObject({
  grantId: z.string().uuid(),
  resourceId: resourceIdSchema,
  operation: z.string().min(1).max(32),
  mode: z.enum(["once", "task"]),
  expiresAt: z.string().datetime().nullable(),
});

export const resourceExchangeRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  taskId: z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/),
  connectorBindingId: z.string().uuid(),
  /** The peer the delivered bytes are for; recorded in the audit trail. */
  peerUserId: z.string().uuid(),
  requests: z.array(connectorResourceRequestSchema).min(1).max(16),
  grants: z.array(assertedGrantSchema).max(64),
});

export type ResourceExchangeRequest = z.infer<typeof resourceExchangeRequestSchema>;

/**
 * The result of one request.
 *
 * `refused` deliberately carries no reason. The owner's machine knows why; the
 * peer learns only that it did not get the file, so a refusal cannot be used to
 * probe which files exist or which of them are secret.
 */
export type ResourceOutcome =
  | {
      status: "delivered";
      resourceId: string;
      content: string;
      truncated: boolean;
      audit: DeliveredSnapshotAudit;
    }
  | { status: "pending_approval"; request: ConnectorResourceRequest }
  | { status: "refused" };

export interface ResourceExchangeResponse {
  requestId: string;
  outcomes: ResourceOutcome[];
}

/**
 * Wire shape of a connector's answer.
 *
 * The cloud validates this on arrival and hands it straight to the waiting
 * caller. `content` is bounded by the same per-resource limit the owner's
 * broker enforces, so a connector cannot return more than its own policy
 * allowed it to read.
 */
export const resourceExchangeResponseSchema = z.strictObject({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  outcomes: z
    .array(
      z.discriminatedUnion("status", [
        z.strictObject({
          status: z.literal("delivered"),
          resourceId: resourceIdSchema,
          content: z.string().max(DEFAULT_RESOURCE_POLICY_LIMITS.maxBytesPerResource),
          truncated: z.boolean(),
          audit: z.strictObject({
            resourceId: resourceIdSchema,
            taskId: z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/),
            recipientUserId: z.string().uuid(),
            byteLength: z
              .number()
              .int()
              .min(0)
              .max(DEFAULT_RESOURCE_POLICY_LIMITS.maxBytesPerResource),
            contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
            authorizationMode: z.enum(["once", "task"]),
            truncated: z.boolean(),
            deliveredAt: z.string().datetime(),
          }),
        }),
        z.strictObject({
          status: z.literal("pending_approval"),
          request: connectorResourceRequestSchema,
        }),
        // A refusal carries no reason on the wire, and none is accepted here
        // either: a connector must not be able to leak one by adding a field.
        z.strictObject({ status: z.literal("refused") }),
      ]),
    )
    .min(1)
    .max(16),
});

export interface ResourceExchangeDeps {
  registry: ResourceRegistry;
  broker: LocalFileBroker;
  workspacePath: string;
  limits?: ResourcePolicyLimits;
  now?: () => Date;
  /** Local-only sink for refusal codes; never sent to the cloud or the peer. */
  onRefusal?: (code: ResourceDenyCode | "UNREADABLE", taskId: string) => void;
}

/**
 * Serves one batch of resource requests from the owner's machine.
 *
 * Requests are answered independently (build plan 8.5): an already-granted file
 * is delivered in the same batch in which a new file goes for approval, so the
 * peer can keep working while a human decides.
 *
 * Budgets accumulate across the batch, so a peer cannot bypass the per-task
 * byte limit by splitting one large read into many small requests.
 */
export async function fulfilResourceRequests(
  request: Readonly<ResourceExchangeRequest>,
  deps: ResourceExchangeDeps,
): Promise<ResourceExchangeResponse> {
  const limits = deps.limits ?? DEFAULT_RESOURCE_POLICY_LIMITS;
  const now = deps.now ?? (() => new Date());
  const outcomes: ResourceOutcome[] = [];
  let requestsMade = 0;
  let bytesRead = 0;

  for (const item of request.requests) {
    const canonicalPath =
      item.kind === "resource"
        ? await deps.registry.resolve(request.taskId, item.resourceId)
        : null;
    const decision = decideResourceRequest(
      {
        taskId: request.taskId,
        request: item,
        grants: request.grants as readonly AssertedGrant[],
        canonicalPath,
        // Containment is proven for real by the broker immediately before the
        // read; this is the policy's cheap precondition, not the check itself.
        withinWorkspace: canonicalPath !== null,
        requestsAlreadyMade: requestsMade,
        bytesAlreadyRead: bytesRead,
        now: now(),
      },
      deps.workspacePath,
      limits,
    );

    if (decision.outcome === "escalate") {
      outcomes.push({ status: "pending_approval", request: item });
      continue;
    }
    if (decision.outcome === "deny") {
      deps.onRefusal?.(decision.code, request.taskId);
      outcomes.push({ status: "refused" });
      continue;
    }

    requestsMade += 1;
    const remaining = Math.max(0, limits.maxBytesPerTask - bytesRead);
    const read = await deps.broker.read(
      {
        taskId: request.taskId,
        resourceId: item.kind === "resource" ? item.resourceId : "",
        recipientUserId: request.peerUserId,
        canonicalPath: decision.canonicalPath,
        authorizationMode: decision.mode,
        maxBytes: Math.min(limits.maxBytesPerResource, remaining),
      },
      now,
    );
    if (isBrokerFailure(read)) {
      deps.onRefusal?.(read.code, request.taskId);
      outcomes.push({ status: "refused" });
      continue;
    }
    bytesRead += read.audit.byteLength;
    outcomes.push({
      status: "delivered",
      resourceId: read.audit.resourceId,
      content: read.content,
      truncated: read.audit.truncated,
      audit: read.audit,
    });
  }

  return { requestId: request.requestId, outcomes };
}
