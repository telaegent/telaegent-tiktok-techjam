/**
 * PORTS — workstream #6's injection boundary. Hien owns the shape; Khoa
 * implements it over AgentService and node's filesystem.
 *
 * Two rules make this file necessary:
 *
 *   1. plan.md §7.1: no Telaegent component may call a runner directly, yet
 *      `relay_ask_status` and `relay_create_context_pack` both need a provider
 *      run. Resolved by injection rather than by Khoa owning the sequence
 *      (finding C6): #6 keeps the try/finally, Khoa keeps the runner.
 *
 *   2. hien.md §6 requires a test proving the read/copy helper was never
 *      called for `.env`. That is only assertable if the filesystem is a port
 *      rather than a top-level `import fs from "node:fs"` (finding C7).
 *
 * Consequence worth stating: nothing under telaegent/ that #6 owns imports
 * node:fs, node:child_process, or any runner. See ports.node.ts for the real
 * implementation and testing/fake-ports.ts for the instrumented one.
 */

import type {
  MiddlewareRunRequest,
  NormalizedRunResult,
  SafeAuditHint,
  SafeConversationEntry,
  DenialCode,
  PermissionDecision,
  TelaegentToolName,
} from "./contract.js";

/* ========================================================================== *
 * Filesystem port
 * ========================================================================== */

export interface PortFileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  /** True when the *link itself* is a symlink (lstat semantics). */
  isSymbolicLink: boolean;
}

export interface FileSystemPort {
  /** lstat semantics — must NOT follow the final symlink. */
  lstat(absolutePath: string): Promise<PortFileStat>;
  /** Fully resolved real path. Throws if the path does not exist. */
  realpath(absolutePath: string): Promise<string>;
  readDir(absolutePath: string): Promise<string[]>;

  /** Never called for a denied path. The `.env` test asserts exactly this. */
  readFile(absolutePath: string): Promise<Buffer>;
  /** Never called for a denied path. */
  copyFile(from: string, to: string): Promise<void>;

  mkdir(absolutePath: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(absolutePath: string, data: string): Promise<void>;
  /** Recursive delete. Implementations must refuse a path that is not absolute. */
  removeTree(absolutePath: string): Promise<void>;
  exists(absolutePath: string): Promise<boolean>;
}

/* ========================================================================== *
 * Process ports
 * ========================================================================== */

export interface GitPort {
  /**
   * execFile with an argument ARRAY. No shell, ever — no model-supplied string
   * is ever concatenated into a command line.
   */
  (args: string[], cwd: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export interface TestRunnerPort {
  /** Runs the fixture's own tests inside `workspacePath`. No network. */
  (workspacePath: string): Promise<{ passed: boolean; summary: string }>;
}

/* ========================================================================== *
 * The port bundle
 * ========================================================================== */

export interface TelaegentPorts {
  /**
   * Khoa's thin wrapper over AgentService.runMiddlewareTurn. The ONLY route
   * from workstream #6 to a provider.
   */
  runMiddlewareTurn(
    request: MiddlewareRunRequest,
  ): Promise<NormalizedRunResult<unknown>>;

  fs: FileSystemPort;
  git: GitPort;
  runFixtureTests: TestRunnerPort;

  /** Injectable clock so TTL and expiry tests never sleep. */
  now(): Date;

  /** Directory temporary context workspaces are created under. */
  temporaryRoot: string;

  /** #6 reports audit facts; Khoa persists them inside his atomic mutation. */
  auditHint(event: SafeAuditHint): void;
}

/* ========================================================================== *
 * Dispatcher contract
 * ========================================================================== */

export interface ToolActor {
  ownerId: string;
  agentId: string;
}

export interface AuthorizedToolCall {
  callId: string;
  name: TelaegentToolName;
  /** Untrusted until re-parsed with Duy's schema inside the dispatcher. */
  arguments: unknown;
  permissionDecision: PermissionDecision;
  actor: ToolActor;
  projectId: string;
  correlationId: string;
}

/**
 * Everything the dispatcher is allowed to know about current state. Supplied by
 * Khoa from the store; the dispatcher never queries the store itself.
 */
export interface DispatchContext {
  conversationId: string;
  intentId?: string | undefined;
  activeAgreement?: import("./contract.js").ActiveAgreement | undefined;
  activeIntents: import("./contract.js").Intent[];
  /** Agent workspace root for the acting agent. Absolute, already validated. */
  workspacePath: string;
  provider: import("./contract.js").AgentProvider;
  /**
   * The source approval, when one is in force. Khoa passes through the same
   * `ExistingApprovalScope` he used to build the permission evaluation context,
   * widened with the commit and scope the isolated workspace needs (finding C5).
   * The dispatcher never loads this itself.
   */
  sourceGrant?: import("./contract.js").ResolvedSourceGrant | undefined;
  /** Pending request this call replies to, when the tool is relay_reply. */
  pendingRequest?:
    | {
        requestId: string;
        recipientOwnerId: string;
        recipientAgentId: string;
        version: number;
        expiresAt: string;
        purpose: string;
      }
    | undefined;
  exchangeNumber: number;
}

export interface SafeEvidence {
  branch?: string | undefined;
  commit?: string | undefined;
  changedFiles?: string[] | undefined;
  sourceManifestDigest?: string | undefined;
}

/**
 * The dispatcher returns DATA. It never writes to the store — Khoa applies the
 * result inside the same atomic mutation as the audit event.
 */
export type ToolExecutionResult =
  | {
      kind: "artifact";
      entry: SafeConversationEntry;
      evidence?: SafeEvidence | undefined;
      /** Validated record for Khoa to persist, when the tool produces one. */
      record?: Record<string, unknown> | undefined;
    }
  | { kind: "denied"; code: DenialCode; safeReason: string }
  | {
      kind: "escalate";
      code: "EXCHANGE_LIMIT" | "OWNERSHIP_VIOLATION" | "INVALID_AGENT_OUTPUT";
      safeReason: string;
    };
