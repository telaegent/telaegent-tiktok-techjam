import path from "node:path";
import { z } from "zod";
import {
  LocalFileBroker,
  isBrokerFailure,
  isLocatedResource,
  type DeliveredSnapshotAudit,
} from "./file-broker.js";
import {
  DEFAULT_RESOURCE_POLICY_LIMITS,
  decideResourceRequest,
  type AssertedGrant,
  type ResourceDenyCode,
  type ResourcePolicyLimits,
} from "./resource-policy.js";
import {
  connectorResourceRequestSchema,
  resourceDisplayLabelSchema,
  type ConnectorResourceRequest,
} from "./resource-request.js";
import { resourceIdSchema, type ResourceRegistry } from "./resource-registry.js";
import { projectRelativeDisplayLabel } from "./workspace-label.js";
import {
  InMemoryResourceTaskBudgetLedger,
  type ResourceTaskBudgetLedger,
} from "./resource-budget.js";

// The request shape lives in a leaf module because a private agent's turn now
// emits it too, and the protocol layer must not import a filesystem to say so.
export {
  connectorResourceRequestSchema,
  type ConnectorResourceRequest,
} from "./resource-request.js";

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
  // Carried from the database-derived route. The local ledger uses the task
  // lifetime, not a possibly shorter individual grant lifetime, so replacing
  // a grant cannot refill a task-wide budget.
  taskExpiresAt: z.string().datetime({ offset: true }),
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
  | {
      status: "pending_approval";
      request: ConnectorResourceRequest;
      /**
       * The identifier a human approval would attach authority to (build plan
       * 8.1). Present only when the peer's description names a real, screened
       * file inside this project; a bare pending is deliberately what a peer
       * sees for a file that is missing, secret, or simply awaiting a human, so
       * the three are indistinguishable from the outside.
       *
       * Holding this identifier is not authority. It becomes readable only if
       * the owning human approves and the cloud records a grant against it.
       */
      candidate?: { resourceId: string; resourceDisplayLabel: string } | undefined;
    }
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
          candidate: z
            .strictObject({
              resourceId: resourceIdSchema,
              resourceDisplayLabel: resourceDisplayLabelSchema,
            })
            .optional(),
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
  /** Shared for the life of the connector binding; durable in production. */
  budget?: ResourceTaskBudgetLedger;
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
 * Budgets accumulate across every batch for the task (and connector restarts
 * in production), so a peer cannot bypass a task-wide limit by splitting one
 * large read into many requests.
 */
/**
 * Prepares the handle a human approval would grant authority over.
 *
 * The ordering here is the whole point of build plan 8.3: the owner's machine
 * mints the identifier from a file it resolved and screened itself, and only
 * then can the cloud record a grant against it. The cloud can never invent an
 * identifier, so it can never name a file nobody local agreed to expose.
 *
 * Returns nothing rather than a reason when the description does not name a
 * safe file. The refusal code stays here, on the owner's machine.
 */
async function proposeCandidate(
  taskId: string,
  item: ConnectorResourceRequest,
  canonicalPath: string | null,
  deps: ResourceExchangeDeps,
): Promise<{ resourceId: string; resourceDisplayLabel: string } | null> {
  // An identifier that escalated is one this task already minted and the policy
  // already screened; it needs no human-facing file, only a fresh grant.
  if (item.kind === "resource") {
    if (canonicalPath === null) return null;
    const resourceDisplayLabel = projectRelativeDisplayLabel(
      deps.workspacePath,
      canonicalPath,
    );
    return resourceDisplayLabel === null
      ? null
      : { resourceId: item.resourceId, resourceDisplayLabel };
  }
  const located = await deps.broker.locate(item.hint);
  if (!isLocatedResource(located)) {
    deps.onRefusal?.(located.code, taskId);
    return null;
  }
  const resourceDisplayLabel = projectRelativeDisplayLabel(
    deps.workspacePath,
    located.canonicalPath,
  );
  if (resourceDisplayLabel === null) return null;
  return {
    resourceId: await deps.registry.mint(taskId, located.canonicalPath),
    resourceDisplayLabel,
  };
}

export async function fulfilResourceRequests(
  request: Readonly<ResourceExchangeRequest>,
  deps: ResourceExchangeDeps,
): Promise<ResourceExchangeResponse> {
  const limits = deps.limits ?? DEFAULT_RESOURCE_POLICY_LIMITS;
  const now = deps.now ?? (() => new Date());
  const budget = deps.budget ?? inMemoryBudgetFor(deps.registry);
  const outcomes: ResourceOutcome[] = [];

  for (const item of request.requests) {
    const currentTime = now();
    if (Date.parse(request.taskExpiresAt) <= currentTime.getTime()) {
      deps.onRefusal?.("GRANT_EXPIRED", request.taskId);
      outcomes.push({ status: "refused" });
      continue;
    }
    const usage = await budget.usage(request.taskId, currentTime);
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
        requestsAlreadyMade: usage.requestsMade,
        bytesAlreadyRead: usage.bytesRead,
        now: currentTime,
      },
      deps.workspacePath,
      limits,
    );

    if (decision.outcome === "escalate") {
      const candidate = await proposeCandidate(request.taskId, item, canonicalPath, deps);
      outcomes.push({
        status: "pending_approval",
        request: item,
        ...(candidate ? { candidate } : {}),
      });
      continue;
    }
    if (decision.outcome === "deny") {
      deps.onRefusal?.(decision.code, request.taskId);
      outcomes.push({ status: "refused" });
      continue;
    }

    const reserved = await budget.reserveRead(
      request.taskId,
      limits.maxBytesPerResource,
      limits,
      request.taskExpiresAt,
      currentTime,
    );
    if (reserved.outcome !== "reserved") {
      deps.onRefusal?.(
        reserved.outcome === "request_budget" ? "REQUEST_BUDGET" : "BYTE_BUDGET",
        request.taskId,
      );
      outcomes.push({ status: "refused" });
      continue;
    }
    const read = await deps.broker.read(
      {
        taskId: request.taskId,
        resourceId: item.kind === "resource" ? item.resourceId : "",
        recipientUserId: request.peerUserId,
        canonicalPath: decision.canonicalPath,
        authorizationMode: decision.mode,
        maxBytes: reserved.reservation.reservedBytes,
      },
      now,
    );
    if (isBrokerFailure(read)) {
      await budget.settleRead(reserved.reservation, 0);
      deps.onRefusal?.(read.code, request.taskId);
      outcomes.push({ status: "refused" });
      continue;
    }
    await budget.settleRead(reserved.reservation, read.audit.byteLength);
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

const implicitBudgets = new WeakMap<ResourceRegistry, ResourceTaskBudgetLedger>();

function inMemoryBudgetFor(registry: ResourceRegistry): ResourceTaskBudgetLedger {
  const existing = implicitBudgets.get(registry);
  if (existing) return existing;
  const created = new InMemoryResourceTaskBudgetLedger();
  implicitBudgets.set(registry, created);
  return created;
}
