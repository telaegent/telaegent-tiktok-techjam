import path from "node:path";
import { resourceIdSchema } from "./resource-registry.js";

/**
 * Why a request was refused. These codes stay on the owner's machine.
 *
 * A peer learns only that a request was not fulfilled. Telling it the
 * difference between "that file is a secret", "that file is outside the
 * project" and "no such resource" would turn every refusal into a probe of the
 * owner's private layout.
 */
export type ResourceDenyCode =
  | "SECRET_PATH"
  | "OUTSIDE_WORKSPACE"
  | "UNKNOWN_RESOURCE"
  | "GRANT_MISSING"
  | "GRANT_EXPIRED"
  | "GRANT_OPERATION"
  | "REQUEST_BUDGET"
  | "BYTE_BUDGET";

/** The single sentence a peer is ever shown for any refusal. */
export const RESOURCE_DENIAL_MESSAGE = "That resource is not available";

export type ResourceRequest =
  | { kind: "resource"; resourceId: string }
  | { kind: "hint"; hint: string };

/**
 * A grant as the cloud asserts it on the job envelope.
 *
 * The cloud owns `resource_capability_grants` and is authoritative for whether
 * a grant exists. It is not authoritative for what the identifier points at:
 * the connector still resolves, contains and screens the path itself, so a
 * compromised or buggy relay cannot turn an existing grant into a read of a
 * file the owner never approved.
 */
export interface AssertedGrant {
  grantId: string;
  resourceId: string;
  operation: string;
  mode: "once" | "task";
  expiresAt: string | null;
}

export interface ResourcePolicyInput {
  taskId: string;
  request: ResourceRequest;
  grants: readonly AssertedGrant[];
  /** Resolved locally from the registry; null when this task never held it. */
  canonicalPath: string | null;
  /** True only when the path is inside this binding's workspace right now. */
  withinWorkspace: boolean;
  requestsAlreadyMade: number;
  bytesAlreadyRead: number;
  now: Date;
}

export type ResourcePolicyDecision =
  | { outcome: "allow"; grantId: string; canonicalPath: string; mode: "once" | "task" }
  | { outcome: "escalate"; request: ResourceRequest }
  | { outcome: "deny"; code: ResourceDenyCode };

export interface ResourcePolicyLimits {
  maxRequestsPerTask: number;
  maxBytesPerTask: number;
  maxBytesPerResource: number;
}

export const DEFAULT_RESOURCE_POLICY_LIMITS: ResourcePolicyLimits = {
  maxRequestsPerTask: 16,
  maxBytesPerTask: 1_048_576,
  maxBytesPerResource: 262_144,
};

/** Directory names that are never readable, at any depth. */
const DENIED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".docker",
  ".kube",
  ".config",
]);

/**
 * File names that are never readable.
 *
 * Deliberately a deny list of shapes rather than a content scan: the decision
 * has to be deterministic and identical on every machine, and a content scan
 * would have to read the secret in order to refuse it.
 */
const DENIED_BASENAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.(npmrc|pypirc|netrc|htpasswd|dockercfg|pgpass)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^(credentials|secrets?|service-account)(\.[A-Za-z0-9]+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|keychain|asc|ppk)$/i,
  /\.(env|secret|secrets)\.[A-Za-z0-9]+$/i,
];

/**
 * Decides whether a path may ever be read, ignoring grants entirely.
 *
 * Runs before grant checking so that no approval, however it was obtained, can
 * produce a read of a credential file. A human who clicks Allow on a secret
 * still gets a refusal.
 */
export function isDeniedPath(canonicalPath: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(canonicalPath));
  // Split on both separators without a regex literal. An escaped backslash in a
  // character class is easy to lose in transit, and losing it here would stop
  // every nested Windows path from ever matching the deny list.
  const segments = relative
    .split(path.sep)
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  const basename = segments[segments.length - 1]!;
  if (segments.slice(0, -1).some((segment) => DENIED_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }
  if (DENIED_SEGMENTS.has(basename.toLowerCase())) return true;
  return DENIED_BASENAMES.some((pattern) => pattern.test(basename));
}

/**
 * The deterministic half of the capability loop.
 *
 * Pure by construction: every input is supplied, nothing is read from disk or
 * from the network, and no model is consulted. The same inputs always produce
 * the same decision, which is what makes the loop auditable.
 */
export function decideResourceRequest(
  input: Readonly<ResourcePolicyInput>,
  workspacePath: string,
  limits: Readonly<ResourcePolicyLimits> = DEFAULT_RESOURCE_POLICY_LIMITS,
): ResourcePolicyDecision {
  if (input.requestsAlreadyMade >= limits.maxRequestsPerTask) {
    return { outcome: "deny", code: "REQUEST_BUDGET" };
  }
  if (input.bytesAlreadyRead >= limits.maxBytesPerTask) {
    return { outcome: "deny", code: "BYTE_BUDGET" };
  }

  // A hint may be a bounded project-relative path such as "src/settings.ts"
  // (build plan 8.3). It is still never resolved or matched here: a hint always
  // reaches the owning human for approval before any registration or read, so a
  // peer can suggest a file but can never select one.
  const request = input.request;
  if (request.kind === "hint") return { outcome: "escalate", request };

  if (!resourceIdSchema.safeParse(request.resourceId).success) {
    return { outcome: "deny", code: "UNKNOWN_RESOURCE" };
  }
  if (input.canonicalPath === null) {
    return { outcome: "deny", code: "UNKNOWN_RESOURCE" };
  }
  if (isDeniedPath(input.canonicalPath, workspacePath)) {
    return { outcome: "deny", code: "SECRET_PATH" };
  }
  if (!input.withinWorkspace) {
    return { outcome: "deny", code: "OUTSIDE_WORKSPACE" };
  }

  const grant = input.grants.find(
    (candidate) => candidate.resourceId === request.resourceId,
  );
  // No grant is not a refusal: it is the cold path. The owner has never been
  // asked about this resource in this task, so ask them.
  if (!grant) return { outcome: "escalate", request };
  if (grant.operation !== "read") return { outcome: "deny", code: "GRANT_OPERATION" };
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= input.now.getTime()) {
    return { outcome: "deny", code: "GRANT_EXPIRED" };
  }

  return {
    outcome: "allow",
    grantId: grant.grantId,
    canonicalPath: input.canonicalPath,
    mode: grant.mode,
  };
}
