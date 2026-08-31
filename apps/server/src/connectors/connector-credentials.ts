import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { isGitHubRepositoryId } from "../authorization/github-repository-id.js";
import { UserAuthenticationError } from "../authentication/types.js";
import { isSafeSupabaseOrigin } from "../supabase-origin.js";
import {
  connectorPrincipalSchema,
  type ConnectorPrincipal,
} from "../repository-proof/contract.js";

const connectorInstanceIdSchema = connectorPrincipalSchema.shape.connectorInstanceId;
const credentialPattern = /^[A-Za-z0-9_-]{43}$/;
const timestampSchema = z.string().datetime({ offset: true });

export const connectorSetupStatusSchema = z.strictObject({
  connectorInstanceId: connectorInstanceIdSchema,
  credential: z
    .strictObject({
      status: z.enum(["active", "expired", "revoked"]),
      expiresAt: timestampSchema,
      lastSeenAt: timestampSchema.nullable(),
    })
    .nullable(),
  bindings: z
    .array(
      z.strictObject({
        connectorBindingId: z.string().uuid(),
        projectId: z.string().uuid(),
        githubRepositoryId: z.string().refine(isGitHubRepositoryId),
        repositoryFullName: z.string().min(3).max(140),
        visibility: z.enum(["public", "private", "internal"]),
        defaultBranch: z.string().min(1).max(255),
        currentBranch: z.string().min(1).max(255).nullable(),
        commitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
        repositoryPermission: z
          .enum(["read", "triage", "write", "maintain", "admin"])
          .nullable(),
        repositoryAccessStatus: z.enum([
          "verified",
          "revalidation_required",
          "revoked",
        ]),
        membershipStatus: z.enum(["active", "suspended", "revoked"]),
        bindingStatus: z.enum([
          "provisioning",
          "ready",
          "stopped",
          "unavailable",
          "revoked",
        ]),
        verifiedAt: timestampSchema.nullable(),
        bindingLastSeenAt: timestampSchema.nullable(),
        unavailableReason: z.string().min(1).max(64).nullable(),
      }),
    )
    .max(25),
  bindingsTruncated: z.boolean(),
});

export type ConnectorSetupStatus = z.infer<typeof connectorSetupStatusSchema>;

export interface ConnectorCredentialRepository {
  create(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
    tokenHashHex: string;
    ttlSeconds: number;
  }>): Promise<boolean>;
  authenticate(tokenHashHex: string): Promise<ConnectorPrincipal | null>;
  revoke(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
  }>): Promise<boolean>;
  loadSetupStatus(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
  }>): Promise<ConnectorSetupStatus | null>;
}

export class ConnectorCredentialService {
  constructor(
    private readonly repository: ConnectorCredentialRepository,
    private readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 3_600 || ttlSeconds > 2_592_000) {
      throw new Error("Connector credential TTL is invalid");
    }
  }

  async issue(authenticatedUserId: string, connectorInstanceId: unknown): Promise<{
    credential: string;
    connectorInstanceId: string;
    expiresAt: string;
  }> {
    const userId = z.string().uuid().parse(authenticatedUserId);
    const instanceId = connectorInstanceIdSchema.parse(connectorInstanceId);
    const credential = randomBytes(32).toString("base64url");
    const created = await this.repository.create({
      authenticatedUserId: userId,
      connectorInstanceId: instanceId,
      tokenHashHex: sha256Hex(credential),
      ttlSeconds: this.ttlSeconds,
    });
    if (!created) throw authenticationFailed();
    return {
      credential,
      connectorInstanceId: instanceId,
      expiresAt: new Date(this.now().getTime() + this.ttlSeconds * 1_000).toISOString(),
    };
  }

  async authenticate(rawCredential: unknown): Promise<ConnectorPrincipal> {
    if (typeof rawCredential !== "string" || !credentialPattern.test(rawCredential)) {
      throw authenticationRequired();
    }
    const principal = await this.repository.authenticate(sha256Hex(rawCredential));
    if (!principal) throw authenticationRequired();
    return connectorPrincipalSchema.parse(principal);
  }

  revoke(authenticatedUserId: string, connectorInstanceId: unknown): Promise<boolean> {
    return this.repository.revoke({
      authenticatedUserId: z.string().uuid().parse(authenticatedUserId),
      connectorInstanceId: connectorInstanceIdSchema.parse(connectorInstanceId),
    });
  }

  async setupStatus(
    authenticatedUserId: string,
    connectorInstanceId: unknown,
  ): Promise<ConnectorSetupStatus> {
    const status = await this.repository.loadSetupStatus({
      authenticatedUserId: z.string().uuid().parse(authenticatedUserId),
      connectorInstanceId: connectorInstanceIdSchema.parse(connectorInstanceId),
    });
    if (!status) throw unavailable();
    return connectorSetupStatusSchema.parse(status);
  }

  /**
   * Rebuild one process-local relay registration from durable state after a
   * backend restart. Authentication has already bound both principal fields;
   * only a fully active, verified, ready binding may be restored.
   */
  async restoreReadyBinding(
    principal: Readonly<ConnectorPrincipal>,
    rawConnectorBindingId: unknown,
  ): Promise<{ connectorBindingId: string; githubRepositoryId: string } | null> {
    const connectorBindingId = z.string().uuid().parse(rawConnectorBindingId);
    const status = await this.repository.loadSetupStatus({
      authenticatedUserId: z.string().uuid().parse(principal.authenticatedUserId),
      connectorInstanceId: connectorInstanceIdSchema.parse(principal.connectorInstanceId),
    });
    if (!status) return null;
    const parsed = connectorSetupStatusSchema.parse(status);
    const binding = parsed.bindings.find(
      (candidate) => candidate.connectorBindingId === connectorBindingId,
    );
    if (
      !binding ||
      binding.bindingStatus !== "ready" ||
      binding.repositoryAccessStatus !== "verified" ||
      binding.membershipStatus !== "active"
    ) {
      return null;
    }
    return {
      connectorBindingId: binding.connectorBindingId,
      githubRepositoryId: binding.githubRepositoryId,
    };
  }
}

export function createConnectorPrincipalResolver(
  service: ConnectorCredentialService,
): (request: FastifyRequest) => Promise<ConnectorPrincipal> {
  return async (request) => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ") || header.includes(",")) {
      throw authenticationRequired();
    }
    return service.authenticate(header.slice(7));
  };
}

export class SupabaseConnectorCredentialRepository
  implements ConnectorCredentialRepository
{
  private readonly rpcBaseUrl: string;

  constructor(
    supabaseUrl: string,
    private readonly secretKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    const url = new URL(supabaseUrl);
    if (!isSafeSupabaseOrigin(url)) {
      throw new Error("Connector credential persistence configuration is invalid");
    }
    this.rpcBaseUrl = url.origin + "/rest/v1/rpc/";
  }

  async create(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
    tokenHashHex: string;
    ttlSeconds: number;
  }>): Promise<boolean> {
    return z.boolean().parse(await this.rpc("create_connector_credential", {
      p_user_id: input.authenticatedUserId,
      p_connector_instance_id: input.connectorInstanceId,
      p_token_hash_hex: input.tokenHashHex,
      p_ttl_seconds: input.ttlSeconds,
    }));
  }

  async authenticate(tokenHashHex: string): Promise<ConnectorPrincipal | null> {
    const value = await this.rpc("authenticate_connector_credential", {
      p_token_hash_hex: tokenHashHex,
    });
    return value === null ? null : connectorPrincipalSchema.parse(value);
  }

  async revoke(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
  }>): Promise<boolean> {
    return z.boolean().parse(await this.rpc("revoke_connector_credential", {
      p_user_id: input.authenticatedUserId,
      p_connector_instance_id: input.connectorInstanceId,
    }));
  }
  async loadSetupStatus(input: Readonly<{
    authenticatedUserId: string;
    connectorInstanceId: string;
  }>): Promise<ConnectorSetupStatus | null> {
    const value = await this.rpc("load_connector_setup_status", {
      p_user_id: input.authenticatedUserId,
      p_connector_instance_id: input.connectorInstanceId,
      p_max_bindings: 25,
    });
    return value === null ? null : connectorSetupStatusSchema.parse(value);
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.rpcBaseUrl + name, {
        method: "POST",
        headers: {
          apikey: this.secretKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) throw unavailable();
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 16_384) throw unavailable();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof UserAuthenticationError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authenticationRequired(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_REQUIRED",
    "Connector authentication required",
  );
}

function authenticationFailed(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_FAILED",
    "Connector credential could not be issued",
  );
}

function unavailable(): UserAuthenticationError {
  return new UserAuthenticationError(
    "AUTHENTICATION_UNAVAILABLE",
    "Connector authentication is temporarily unavailable",
    503,
  );
}
