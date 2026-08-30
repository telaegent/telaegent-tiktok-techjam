import type {
  AgentProvider,
  RuntimeCapabilityReason,
  RuntimeProgressSink,
  RuntimeProviderCapability,
  RuntimeProviderProbeResult,
} from "./runtime-contract.js";
import {
  RuntimeProviderError,
  type RuntimeErrorCode,
} from "./runtime-errors.js";

export type ProviderConnectionState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "reconnect_required"
  | "unavailable";

export type ProviderConnectionReason =
  | RuntimeCapabilityReason
  | RuntimeErrorCode
  | null;

export interface ProviderConnectionStatus {
  bindingId: string;
  provider: AgentProvider;
  state: ProviderConnectionState;
  installed: boolean;
  authenticated: boolean;
  reason: ProviderConnectionReason;
  checkedAt: string;
  lastProbeAt?: string;
  lastProbeLatencyMs?: number;
}

export interface ProviderConnectionTarget {
  bindingId: string;
  provider: AgentProvider;
  correlationId: string;
}

export interface ProviderConnectionRuntime {
  capability(
    bindingId: string,
    provider: AgentProvider,
  ): Promise<RuntimeProviderCapability>;
  probe(
    request: ProviderConnectionTarget,
    onProgress?: RuntimeProgressSink,
  ): Promise<RuntimeProviderProbeResult>;
}

export class ProviderConnectionService {
  private readonly statuses = new Map<string, ProviderConnectionStatus>();
  private readonly activeProbes = new Map<
    string,
    Promise<ProviderConnectionStatus>
  >();

  constructor(
    private readonly runtime: ProviderConnectionRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  peek(bindingId: string, provider: AgentProvider): ProviderConnectionStatus | null {
    const status = this.statuses.get(this.key(bindingId, provider));
    return status ? structuredClone(status) : null;
  }

  async inspect(
    bindingId: string,
    provider: AgentProvider,
  ): Promise<ProviderConnectionStatus> {
    const key = this.key(bindingId, provider);
    if (this.activeProbes.has(key)) {
      const connecting = this.statuses.get(key);
      if (connecting) return structuredClone(connecting);
    }

    const previous = this.statuses.get(key);
    const capability = await this.runtime.capability(bindingId, provider);
    const state: ProviderConnectionState = !capability.installed
      ? "unavailable"
      : !capability.authenticated
        ? previous?.state === "connected" ||
          previous?.state === "reconnect_required"
          ? "reconnect_required"
          : "not_connected"
        : previous?.state === "connected"
          ? "connected"
          : "not_connected";
    return this.store({
      bindingId,
      provider,
      state,
      installed: capability.installed,
      authenticated: capability.authenticated,
      reason: capability.reason,
      checkedAt: this.now().toISOString(),
      ...(previous?.lastProbeAt ? { lastProbeAt: previous.lastProbeAt } : {}),
      ...(previous?.lastProbeLatencyMs !== undefined
        ? { lastProbeLatencyMs: previous.lastProbeLatencyMs }
        : {}),
    });
  }

  async probe(
    target: ProviderConnectionTarget,
    onProgress?: RuntimeProgressSink,
  ): Promise<ProviderConnectionStatus> {
    const key = this.key(target.bindingId, target.provider);
    const active = this.activeProbes.get(key);
    if (active) return active;

    const execution = this.performProbe(target, onProgress);
    this.activeProbes.set(key, execution);
    try {
      return await execution;
    } finally {
      if (this.activeProbes.get(key) === execution) {
        this.activeProbes.delete(key);
      }
    }
  }

  private async performProbe(
    target: ProviderConnectionTarget,
    onProgress?: RuntimeProgressSink,
  ): Promise<ProviderConnectionStatus> {
    const previous = this.statuses.get(
      this.key(target.bindingId, target.provider),
    );
    this.store({
      bindingId: target.bindingId,
      provider: target.provider,
      state: "connecting",
      installed: previous?.installed ?? false,
      authenticated: previous?.authenticated ?? false,
      reason: null,
      checkedAt: this.now().toISOString(),
      ...(previous?.lastProbeAt ? { lastProbeAt: previous.lastProbeAt } : {}),
      ...(previous?.lastProbeLatencyMs !== undefined
        ? { lastProbeLatencyMs: previous.lastProbeLatencyMs }
        : {}),
    });

    const capability = await this.runtime.capability(
      target.bindingId,
      target.provider,
    );
    if (!capability.installed) {
      return this.store({
        bindingId: target.bindingId,
        provider: target.provider,
        state: "unavailable",
        installed: false,
        authenticated: false,
        reason: capability.reason,
        checkedAt: this.now().toISOString(),
      });
    }
    if (!capability.authenticated) {
      return this.store({
        bindingId: target.bindingId,
        provider: target.provider,
        state: "reconnect_required",
        installed: true,
        authenticated: false,
        reason: capability.reason,
        checkedAt: this.now().toISOString(),
      });
    }

    const probeAt = this.now().toISOString();
    try {
      const result = await this.runtime.probe(target, onProgress);
      return this.store({
        bindingId: target.bindingId,
        provider: target.provider,
        state: "connected",
        installed: true,
        authenticated: true,
        reason: null,
        checkedAt: this.now().toISOString(),
        lastProbeAt: probeAt,
        lastProbeLatencyMs: result.durationMs,
      });
    } catch (error) {
      const runtimeError =
        error instanceof RuntimeProviderError
          ? error
          : new RuntimeProviderError("RUNTIME_FAILED", "Provider probe failed");
      return this.store({
        bindingId: target.bindingId,
        provider: target.provider,
        state:
          runtimeError.code === "RUNTIME_AUTHENTICATION_FAILED"
            ? "reconnect_required"
            : "unavailable",
        installed: true,
        authenticated:
          runtimeError.code !== "RUNTIME_AUTHENTICATION_FAILED",
        reason: runtimeError.code,
        checkedAt: this.now().toISOString(),
        lastProbeAt: probeAt,
      });
    }
  }

  private store(status: ProviderConnectionStatus): ProviderConnectionStatus {
    this.statuses.set(this.key(status.bindingId, status.provider), status);
    return structuredClone(status);
  }

  private key(bindingId: string, provider: AgentProvider): string {
    return `${bindingId}\u0000${provider}`;
  }
}
