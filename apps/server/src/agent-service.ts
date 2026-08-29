import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type {
  AgentProvider,
  AgentServiceRuntimeOptions,
  MiddlewareLifecycleEvent,
  MiddlewareRunRequest,
  NormalizedRunResult,
  RuntimeCapabilities,
  RuntimeProgressSink,
} from "./runtime-contract.js";
import {
  ProviderConnectionService,
  type ProviderConnectionStatus,
} from "./provider-connection-service.js";
import { safeRuntimeError } from "./runtime-errors.js";
import { RuntimeProviderRegistry } from "./runtime-provider-registry.js";
import { createRuntimeProviderRegistry } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();
const middlewareProviders = new Set(["codex", "claude"]);
const middlewarePurposes = new Set([
  "sender_draft",
  "recipient_answer",
  "plan_intent",
  "implement",
  "status",
  "propose_resolution",
  "create_context_pack",
  "publish_dependency_change",
  "revise_plan",
]);
const middlewareSessionModes = new Set(["continue", "fresh", "ephemeral"]);
const middlewareSandboxModes = new Set(["read-only", "workspace-write"]);
const middlewareNetworkModes = new Set(["none", "default"]);

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly runtimeProviders: RuntimeProviderRegistry;
  private readonly providerConnections: ProviderConnectionService;
  private readonly runtimeOptions: AgentServiceRuntimeOptions;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    runtimeProviders?: RuntimeProviderRegistry,
    runtimeOptions: AgentServiceRuntimeOptions = {},
  ) {
    this.runtimeProviders =
      runtimeProviders ?? createRuntimeProviderRegistry(config);
    this.providerConnections = new ProviderConnectionService(
      this.runtimeProviders,
    );
    this.runtimeOptions = runtimeOptions;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  async runtimeCapabilities(): Promise<RuntimeCapabilities> {
    return this.runtimeProviders.capabilities();
  }

  async providerConnectionStatuses(
    agentId: string,
  ): Promise<ProviderConnectionStatus[]> {
    this.getAgent(agentId);
    return Promise.all(
      (["codex", "claude"] as const).map((provider) =>
        this.providerConnections.inspect(agentId, provider),
      ),
    );
  }

  async probeProviderConnection(
    agentId: string,
    provider: AgentProvider,
    correlationId: string = randomUUID(),
    onProgress?: RuntimeProgressSink,
  ): Promise<ProviderConnectionStatus> {
    const agent = this.getAgent(agentId);
    return this.providerConnections.probe(
      {
        bindingId: agent.id,
        agentId: agent.id,
        provider,
        workspacePath: agent.workspacePath,
        correlationId,
      },
      onProgress,
    );
  }

  async runMiddlewareTurn<T = unknown>(
    request: MiddlewareRunRequest,
    onProgress?: RuntimeProgressSink,
  ): Promise<NormalizedRunResult<T>> {
    const agent = this.getAgent(request.agentId);
    await this.validateMiddlewareRequest(request, agent);
    const timestamp = now();
    const run: AgentRun = {
      id: randomUUID(),
      agentId: request.agentId,
      status: "queued",
      prompt: request.persistedSummary.trim(),
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find(
        (item) => item.id === request.agentId,
      );
      if (!storedAgent) throw new HttpError(404, "Agent not found");
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before running middleware");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });

    const execution = this.executeMiddlewareRun<T>(
      agentAtStart,
      run,
      request,
      onProgress,
    );
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    this.activeExecutions.set(request.agentId, settled);
    try {
      return await execution;
    } finally {
      if (this.activeExecutions.get(request.agentId) === settled) {
        this.activeExecutions.delete(request.agentId);
      }
    }
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = safeRuntimeError(error).message;
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async executeMiddlewareRun<T>(
    agentAtStart: Agent,
    run: AgentRun,
    request: MiddlewareRunRequest,
    onProgress?: RuntimeProgressSink,
  ): Promise<NormalizedRunResult<T>> {
    const lifecycleEvent: MiddlewareLifecycleEvent = {
      agentId: request.agentId,
      runId: run.id,
      provider: request.provider,
      purpose: request.purpose,
      correlationId: request.correlationId,
    };
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      await this.runtimeOptions.lifecycle?.onRunStarted?.(lifecycleEvent);
      const result = await this.runtimeProviders.run(request, (progress) => {
        try {
          this.runtimeOptions.lifecycle?.onRuntimeProgress?.({
            ...lifecycleEvent,
            progress,
          });
        } catch {
          // Realtime observers are best-effort and cannot fail the CLI turn.
        }
        try {
          onProgress?.(progress);
        } catch {
          // A disconnected caller cannot fail or cancel the CLI turn.
        }
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = "completed";
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          agent.status = "ready";
          if (
            request.provider === "codex" &&
            request.sessionMode !== "ephemeral" &&
            result.sessionId
          ) {
            agent.codexThreadId = result.sessionId;
          }
          agent.lastError = null;
          agent.updatedAt = completedAt;
        }
      });
      if (request.sessionMode !== "ephemeral" && result.sessionId) {
        await this.runtimeOptions.lifecycle?.onSessionUpdated?.({
          ...lifecycleEvent,
          sessionId: result.sessionId,
        });
      }
      await this.runtimeOptions.lifecycle?.onRunCompleted?.(lifecycleEvent);
      return result as NormalizedRunResult<T>;
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const safeError = safeRuntimeError(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = safeError.message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : safeError.message;
          agent.updatedAt = completedAt;
        }
      });
      if (cancelled) {
        await this.runtimeOptions.lifecycle?.onRunCancelled?.(lifecycleEvent);
      } else {
        await this.runtimeOptions.lifecycle?.onRunFailed?.(lifecycleEvent);
      }
      throw safeError;
    }
  }

  private async validateMiddlewareRequest(
    request: MiddlewareRunRequest,
    agent: Agent,
  ): Promise<void> {
    if (
      !middlewareProviders.has(request.provider) ||
      !middlewarePurposes.has(request.purpose) ||
      !middlewareSessionModes.has(request.sessionMode) ||
      !middlewareSandboxModes.has(request.sandboxMode) ||
      !middlewareNetworkModes.has(request.networkMode)
    ) {
      throw new HttpError(400, "Middleware runtime policy is invalid");
    }
    if (!request.runtimePrompt.trim() || request.runtimePrompt.length > 100_000) {
      throw new HttpError(400, "Middleware runtime prompt is invalid");
    }
    if (request.persistedSummary.length > 1_000) {
      throw new HttpError(400, "Middleware persisted summary is too long");
    }
    if (
      !request.correlationId.trim() ||
      request.correlationId.length > 128 ||
      /[\r\n]/.test(request.correlationId)
    ) {
      throw new HttpError(400, "Middleware correlation ID is invalid");
    }
    if (!Number.isInteger(request.maxTurns) || request.maxTurns < 1 || request.maxTurns > 3) {
      throw new HttpError(400, "Middleware maxTurns must be between 1 and 3");
    }
    if (request.purpose !== "implement" && request.sandboxMode !== "read-only") {
      throw new HttpError(400, "This middleware purpose must use a read-only sandbox");
    }
    if (request.sessionMode !== "continue" && request.sessionId) {
      throw new HttpError(400, "Fresh middleware sessions cannot resume a provider session");
    }
    if (request.sessionId && (request.sessionId.length > 256 || /[\r\n]/.test(request.sessionId))) {
      throw new HttpError(400, "Middleware session ID is invalid");
    }
    if (
      request.purpose === "create_context_pack" &&
      (request.sandboxMode !== "read-only" ||
        request.networkMode !== "none" ||
        request.sessionMode === "continue")
    ) {
      throw new HttpError(
        400,
        "ContextPack runs require a fresh read-only session with no tool network",
      );
    }

    const authorized = this.runtimeOptions.authorizeWorkspace
      ? await this.runtimeOptions.authorizeWorkspace(request, agent)
      : path.resolve(request.workspacePath) === path.resolve(agent.workspacePath);
    if (!authorized) {
      throw new HttpError(403, "Middleware workspace is not authorized for this Agent");
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await Promise.all([
        this.runner.cancel(agentId),
        this.runtimeProviders.cancel(agentId),
      ]);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
