import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import telaegentLogo from "../../../ui/logo/telaegent-logo-transparent-dark.png";
import telaegentLogoBright from "../../../ui/logo/telaegent-logo-transparent-bright.png";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";
import connectionsIcon from "../../../ui/icon/connections.svg";
import projectsIcon from "../../../ui/icon/project.svg";
import settingsIcon from "../../../ui/icon/setting.svg";
import {
  api,
  ApiError,
  type AgentProvider,
  type CapabilityScopeDecision,
  type CapabilityScopeRequest,
  type ConnectorPairing,
  type ConnectorSetupStatus,
  type ConversationMessage,
  type PrivateDraftView,
  type ProjectCollaborator,
  type ProjectConversation,
  type ProjectSummary,
  type TelaegentWebUser,
} from "./api";
import {
  assertConversationScope,
  connectedCollaborators,
  selectConnectedPeer,
} from "./project-conversation";
import { AdaptivePoller, SingleFlightByKey } from "./adaptive-poller";
import {
  APP_PATH,
  productLocationFromUrl,
  productPath,
  type ProductRoute,
} from "./app-routing";
import { shouldSubmitComposerOnKeyDown } from "./composer-keyboard";
import { buildConnectorCommand } from "./connector-command";
import {
  connectorPresence,
  type ConnectorPresence,
} from "./connector-presence";
import {
  partitionProjects,
  projectAction,
  projectAvailability,
} from "./project-list";
import {
  initialProductEntryRoute,
  productEntryRouteAfterDiscovery,
} from "./product-entry";
import "./product-app.css";

type Theme = "light" | "dark";
type OnboardingStep =
  | "requirements"
  | "identity"
  | "github"
  | "agent"
  | "ready";
type GithubStage = "idle" | "issuing" | "connector" | "connected" | "error";

function connectorSetupIsReady(connector: ConnectorSetupStatus): boolean {
  return (
    connector.liveReady &&
    connector.credential?.status === "active" &&
    connector.bindings.some(
      (binding) =>
        binding.bindingStatus === "ready" &&
        binding.membershipStatus === "active" &&
        binding.repositoryAccessStatus === "verified",
    )
  );
}
type WorkspaceTab = "chat" | "people" | "settings";
type AsyncLoadState = "idle" | "loading" | "ready" | "error";

type Collaborator = {
  id: string;
  initial: string;
  name: string;
  topic: string;
  provider: string;
  branch: string;
  status: "connected" | "pending" | "available";
};

type SharedMessage = {
  id: string;
  side: "outgoing" | "incoming";
  author: string;
  provider: string;
  body: string;
  meta: string;
};

const repositoryIdPattern = /^[1-9][0-9]*$/;

function projectConfigurationError(githubRepositoryId: string): string | null {
  if (!repositoryIdPattern.test(githubRepositoryId)) {
    return "The selected project does not have a valid stable GitHub repository ID.";
  }
  return null;
}

function formatProvider(provider: AgentProvider): string {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Approved message";
  return `Approved · ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function formatTaskExpiry(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "when this task ends";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError("Unexpected conversation error", 500, null, true);
}

function startVisiblePolling(
  poller: AdaptivePoller,
  immediate = true,
): () => void {
  const syncVisibility = () => poller.setPaused(document.hidden);
  const refreshOnFocus = () => {
    if (!document.hidden) poller.refresh();
  };
  poller.setPaused(document.hidden);
  poller.start(immediate);
  document.addEventListener("visibilitychange", syncVisibility);
  window.addEventListener("focus", refreshOnFocus);
  return () => {
    document.removeEventListener("visibilitychange", syncVisibility);
    window.removeEventListener("focus", refreshOnFocus);
    poller.stop();
  };
}

function apiErrorGuidance(error: ApiError): string {
  if (error.status === 404) {
    return "The canonical conversation API is not enabled on this server deployment.";
  }
  if (error.status === 401)
    return "Sign in again before opening this conversation.";
  if (error.status === 403) {
    return "Your project connection or repository authorization does not allow this action.";
  }
  if (error.status === 424 || error.code === "RUNTIME_AUTHENTICATION_FAILED") {
    return "Sign in to the selected coding provider locally, then ask the Telaegent connector to check again.";
  }
  if (error.code === "RUNTIME_UNAVAILABLE") {
    return "Make sure the local Telaegent connector is online and the selected provider is available.";
  }
  if (error.code === "RUNTIME_SESSION_NOT_FOUND") {
    return "The local provider session is unavailable. Retry to rebuild it from approved project memory.";
  }
  if (error.code === "RUNTIME_TIMEOUT") {
    return "The local provider timed out. Check the connector and retry when it is responsive.";
  }
  if (error.code === "UNSUPPORTED_RUNTIME_POLICY") {
    return "The local connector cannot enforce the required project policy and must be updated or reconnected.";
  }
  return error.message;
}

function draftFailureGuidance(draft: PrivateDraftView): string {
  switch (draft.failure?.code) {
    case "RUNTIME_UNAVAILABLE":
      return "Make sure your local Telaegent connector is online and the selected provider is available.";
    case "RUNTIME_AUTHENTICATION_FAILED":
      return `Sign in to ${formatProvider(draft.provider)} locally, then ask the connector to check again.`;
    case "RUNTIME_SESSION_NOT_FOUND":
      return "The connector lost the private provider session. Retry to rebuild it from approved project memory.";
    case "RUNTIME_TIMEOUT":
      return "The local agent took too long. Check the connector and retry when the provider is responsive.";
    case "RUNTIME_OUTPUT_LIMIT":
      return "The provider returned too much output. Narrow the request before preparing another draft.";
    case "INVALID_AGENT_OUTPUT":
      return "The provider response did not match the private message protocol. You can retry safely.";
    case "UNSUPPORTED_RUNTIME_POLICY":
      return "This connector cannot enforce the required project policy. Update or reconnect it before retrying.";
    case "RUNTIME_CANCELLED":
      return "The local turn was cancelled and no shared message was created.";
    default:
      return draft.failure?.retryable
        ? "Check the local connector and retry the private turn."
        : "Reconnect the local provider before preparing another draft.";
  }
}

function collaboratorView(collaborator: ProjectCollaborator): Collaborator {
  return {
    id: collaborator.userId,
    initial: collaborator.githubLogin.slice(0, 2).toUpperCase(),
    name: `@${collaborator.githubLogin}`,
    topic: "Approved project conversation",
    provider: "Local agent",
    branch: "Repository scoped",
    status:
      collaborator.connectionStatus === "connected"
        ? "connected"
        : collaborator.connectionStatus.startsWith("pending")
          ? "pending"
          : "available",
  };
}

function repositoryParts(fullName: string): { owner: string; name: string } {
  const separator = fullName.indexOf("/");
  return separator > 0
    ? {
        owner: fullName.slice(0, separator),
        name: fullName.slice(separator + 1),
      }
    : { owner: "GitHub", name: fullName };
}

function TypingDots({ label = "Working" }: { label?: string }) {
  return (
    <span className="app-typing-dots" role="status" aria-label={label}>
      <i />
      <i />
      <i />
    </span>
  );
}

function StatusMark({ tone = "ok" }: { tone?: "ok" | "warn" | "quiet" }) {
  return <i className={`app-status-mark ${tone}`} aria-hidden="true" />;
}

function Onboarding({
  theme,
  onToggleTheme,
  onComplete,
  onExit,
  user,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onComplete: () => void;
  onExit: () => void;
  user: TelaegentWebUser | null;
}) {
  const [step, setStep] = useState<OnboardingStep>("requirements");
  const [githubStage, setGithubStage] = useState<GithubStage>("idle");
  const [connectorPairing, setConnectorPairing] =
    useState<ConnectorPairing | null>(null);
  const [connectorError, setConnectorError] = useState<ApiError | null>(null);
  const [checkingConnector, setCheckingConnector] = useState(false);
  const [connectedAgents, setConnectedAgents] = useState<string[]>([]);
  const [connectorCommandCopied, setConnectorCommandCopied] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const steps: OnboardingStep[] = [
    "requirements",
    "identity",
    "github",
    "agent",
    "ready",
  ];
  const stepIndex = steps.indexOf(step);

  function toggleAgent(agent: string) {
    setConnectedAgents((current) =>
      current.includes(agent)
        ? current.filter((item) => item !== agent)
        : [...current, agent],
    );
  }

  async function createConnectorPairing() {
    setGithubStage("issuing");
    setConnectorError(null);
    try {
      const result = await api.createConnectorPairing();
      setConnectorPairing(result.pairing);
      setConnectorCommandCopied(false);
      setGithubStage("connector");
    } catch (error) {
      setConnectorError(normalizeApiError(error));
      setGithubStage("error");
    }
  }

  async function copyConnectorCommand() {
    if (!connectorPairing) return;
    await navigator.clipboard.writeText(
      buildConnectorCommand(window.location.origin, connectorPairing),
    );
    setConnectorCommandCopied(true);
  }

  async function verifyConnectorSetup() {
    if (!connectorPairing || checkingConnector) return;
    setCheckingConnector(true);
    setConnectorError(null);
    try {
      const { connector } = await api.connectorSetupStatus(
        connectorPairing.connectorInstanceId,
      );
      if (connector.credential?.status !== "active") {
        throw new ApiError(
          "The connector credential is no longer active. Create a new one and retry.",
          409,
          "CONNECTOR_CREDENTIAL_INACTIVE",
        );
      }
      const verifiedBinding = connectorSetupIsReady(connector);
      if (!verifiedBinding) {
        throw new ApiError(
          "The connector has not finished verifying this repository yet. Keep it running and check again.",
          409,
          "CONNECTOR_NOT_READY",
          true,
        );
      }
      // Remove the already-consumed pairing code from React state as soon as
      // onboarding no longer needs to render it.
      setConnectorPairing(null);
      setGithubStage("connected");
      onCompleteRef.current();
    } catch (error) {
      const normalized = normalizeApiError(error);
      setConnectorError(normalized);
      if (normalized.code === "CONNECTOR_CREDENTIAL_INACTIVE") {
        setConnectorPairing(null);
        setGithubStage("error");
      }
    } finally {
      setCheckingConnector(false);
    }
  }

  useEffect(() => {
    if (githubStage !== "connector" || !connectorPairing) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const { connector } = await api.connectorSetupStatus(
          connectorPairing.connectorInstanceId,
        );
        if (!active) return;
        if (connectorSetupIsReady(connector)) {
          setConnectorError(null);
          setConnectorPairing(null);
          setGithubStage("connected");
          onCompleteRef.current();
          return;
        }
      } catch {
        // Before the CLI exchanges the code there is intentionally no durable
        // credential/status row. Keep waiting without showing a false error.
      }
      if (active) timer = window.setTimeout(() => void poll(), 1_500);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [githubStage, connectorPairing]);

  return (
    <main className="onboarding-shell">
      <header className="onboarding-topbar">
        <button
          className="app-wordmark"
          type="button"
          onClick={onExit}
          aria-label="Back to landing"
        >
          <img
            src={theme === "dark" ? telaegentLogoBright : telaegentLogo}
            alt="Telaegent"
          />
        </button>
        <button
          className="app-text-button"
          type="button"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </header>

      <div className="onboarding-layout">
        <aside className="onboarding-progress" aria-label="Setup progress">
          <span>Setup</span>
          {steps.map((item, index) => (
            <div className={index <= stepIndex ? "current" : ""} key={item}>
              <i>{index + 1}</i>
              <p>{item === "agent" ? "Coding agent" : item}</p>
            </div>
          ))}
        </aside>

        <section className="onboarding-card" aria-live="polite">
          {step === "requirements" && (
            <>
              <span className="app-eyebrow">Setup requirements</span>
              <h1>Get your local tools ready.</h1>
              <p>
                Telaegent connects to the tools already installed and signed in
                on your computer. Complete this checklist before continuing.
              </p>
              <div
                className="onboarding-requirements"
                aria-label="Setup requirements"
              >
                <div>
                  <span className="app-eyebrow">Install locally</span>
                  <strong>Three things you need</strong>
                </div>
                <ol>
                  <li>
                    <strong>GitHub CLI</strong>
                    <small>
                      Install <code>gh</code>, then sign in with{" "}
                      <code>gh auth login</code>.
                    </small>
                  </li>
                  <li>
                    <strong>Claude Code or Codex CLI</strong>
                    <small>
                      Install at least one coding agent and sign in locally.
                    </small>
                  </li>
                  <li>
                    <strong>Telaegent connector</strong>
                    <small>
                      From the repository folder, run{" "}
                      <code>npx telaegent connect .</code>.
                    </small>
                  </li>
                </ol>
                <p>Repositories, credentials, and agent sessions stay on your machine.</p>
              </div>
              <button
                className="app-primary-action"
                type="button"
                onClick={() => setStep("identity")}
              >
                Continue to sign in
              </button>
            </>
          )}

          {step === "identity" && (
            <>
              <span className="app-eyebrow">Your Telaegent account</span>
              <h1>Start with your developer identity.</h1>
              <p>
                Sign in to Telaegent first. Repository access and collaborator
                permissions stay separate, so you always know what you are
                granting.
              </p>
              <button
                className="app-primary-action"
                type="button"
                onClick={() => setStep("github")}
              >
                Continue setup
              </button>
              <small>
                {user
                  ? `Signed in as @${user.githubLogin}`
                  : "Local demo account"}{" "}
                · no personal agent history is imported
              </small>
            </>
          )}

          {step === "github" && (
            <>
              <span className="app-eyebrow">Repository connection</span>
              <h1>Connect this local repository.</h1>
              <p>
                Run the connector in the repository you choose. Your checkout,
                GitHub login, credentials, and local path stay on this machine.
              </p>

              {githubStage === "idle" && (
                <div className="setup-row">
                  <div>
                    <strong>Local Telaegent connector</strong>
                    <small>Not connected for this repository</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => void createConnectorPairing()}
                  >
                    Connect
                  </button>
                </div>
              )}

              {githubStage === "issuing" && (
                <div className="setup-row">
                  <div>
                    <strong>Preparing a secure one-time command</strong>
                    <small>
                      Bound to this Telaegent account and installation only
                    </small>
                  </div>
                  <TypingDots label="Preparing secure connector command" />
                </div>
              )}

              {githubStage === "connector" && connectorPairing && (
                <div className="device-flow">
                  <div>
                    <span>Run from your repository</span>
                    <strong>Connect this repository</strong>
                  </div>
                  <div>
                    <span>What remains local</span>
                    <code>repo · gh · Claude/Codex · sessions</code>
                  </div>
                  <p>
                    Open a terminal in the repository you want to connect, then
                    run this command. It works on Windows, macOS, and Linux.
                  </p>
                  <div className="connector-command-block">
                    <code className="connector-command">
                      {buildConnectorCommand(
                        window.location.origin,
                        connectorPairing,
                      )}
                    </code>
                    <p>
                      The connector uses the current Git repository. Its local
                      path, checkout, GitHub login, and coding-agent sessions
                      stay on this device. This one-time command expires{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(connectorPairing.expiresAt))}
                      .
                    </p>
                  </div>
                  <div className="inline-actions">
                    <button
                      className="app-secondary-action"
                      type="button"
                      onClick={() => void copyConnectorCommand()}
                    >
                      {connectorCommandCopied
                        ? "Command copied"
                        : "Copy command"}
                    </button>
                    <button
                      className="app-primary-action"
                      type="button"
                      disabled={checkingConnector}
                      onClick={() => void verifyConnectorSetup()}
                    >
                      {checkingConnector ? "Checking…" : "Check connection"}
                    </button>
                    <button
                      className="app-text-button"
                      type="button"
                      disabled={checkingConnector}
                      onClick={() => void createConnectorPairing()}
                    >
                      New command
                    </button>
                  </div>
                  {connectorError && (
                    <div className="api-state error" role="alert">
                      <strong>
                        {connectorError.code ?? "Connector not ready"}
                      </strong>
                      <p>{connectorError.message}</p>
                    </div>
                  )}
                </div>
              )}

              {githubStage === "error" && connectorError && (
                <div className="api-state error" role="alert">
                  <strong>
                    {connectorError.code ?? "Connector setup unavailable"}
                  </strong>
                  <p>{apiErrorGuidance(connectorError)}</p>
                  <button
                    className="app-secondary-action"
                    type="button"
                    onClick={() => void createConnectorPairing()}
                  >
                    Try again
                  </button>
                </div>
              )}

              {githubStage === "connected" && (
                <div className="setup-row connected">
                  <div>
                    <strong>
                      <StatusMark /> Repository connector verified
                    </strong>
                    <small>
                      The backend confirmed an active membership, repository
                      proof, and opaque local binding.
                    </small>
                  </div>
                  <button type="button" onClick={() => setStep("agent")}>
                    Continue
                  </button>
                </div>
              )}
            </>
          )}

          {step === "agent" && (
            <>
              <span className="app-eyebrow">Your project agent</span>
              <h1>Choose who works privately with you.</h1>
              <p>
                Choose only a provider the connector terminal reported as
                TELAEGENT IS CONNECTED. Provider login and project sessions stay
                local; unrelated conversations are never imported.
              </p>
              <div className="provider-picker">
                {["Claude Code", "Codex"].map((agent) => {
                  const connected = connectedAgents.includes(agent);
                  return (
                    <button
                      className={connected ? "connected" : ""}
                      type="button"
                      key={agent}
                      onClick={() => toggleAgent(agent)}
                    >
                      <span>
                        <strong>{agent}</strong>
                        <small>
                          {connected
                            ? "Selected for this project"
                            : "Choose provider"}
                        </small>
                      </span>
                      <span>{connected ? "Selected" : "Select"}</span>
                    </button>
                  );
                })}
              </div>
              <button
                className="app-primary-action"
                type="button"
                disabled={connectedAgents.length === 0}
                onClick={() => setStep("ready")}
              >
                Continue
              </button>
            </>
          )}

          {step === "ready" && (
            <>
              <span className="app-eyebrow">Setup complete</span>
              <h1>You&apos;re ready to choose a project.</h1>
              <p>
                Repositories set the boundary for conversations, agent context,
                collaborators, and approvals.
              </p>
              <div className="ready-summary">
                <span>
                  <StatusMark /> Repository connector registered
                </span>
                <span>
                  <StatusMark /> GitHub repository proof active
                </span>
                <span>
                  <StatusMark /> {connectedAgents.join(" + ")} selected for this
                  project
                </span>
              </div>
              <button
                className="app-primary-action"
                type="button"
                onClick={onComplete}
              >
                Choose a repository
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function ProductNav({
  route,
  onNavigate,
}: {
  route: ProductRoute;
  onNavigate: (route: ProductRoute) => void;
}) {
  const items: Array<{ route: ProductRoute; label: string; icon: string }> = [
    { route: "projects", label: "Projects", icon: projectsIcon },
    { route: "connections", label: "Connections", icon: connectionsIcon },
    { route: "settings", label: "Settings", icon: settingsIcon },
  ];

  return (
    <nav className="app-rail" aria-label="Product navigation">
      {items.map((item) => (
        <button
          className={
            route === item.route ||
            (item.route === "projects" &&
              (route === "workspace" || route === "add-project"))
              ? "selected"
              : ""
          }
          type="button"
          key={item.route}
          data-route={item.route}
          onClick={() => onNavigate(item.route)}
        >
          <img src={item.icon} alt="" aria-hidden="true" />
          <strong>{item.label}</strong>
        </button>
      ))}
    </nav>
  );
}

function ProjectsScreen({
  onOpenProject,
  onConnectProject,
  onAddProject,
  onReconnect,
  connectionState,
  projects,
  loading,
  error,
  onRetry,
}: {
  onOpenProject: (project: ProjectSummary) => void;
  onConnectProject: (project: ProjectSummary) => void;
  onAddProject: () => void;
  onReconnect: () => void;
  connectionState: ConnectorPresence;
  projects: ProjectSummary[];
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
}) {
  const grouped = partitionProjects(projects);

  function projectRow(project: ProjectSummary) {
    const repository = repositoryParts(project.repositoryFullName);
    const availability = projectAvailability(project);
    const action = projectAction(project);
    return (
      <article
        className="project-row"
        key={project.projectId}
      >
        <span className="repo-mark" aria-hidden="true">
          {repository.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="repo-title">
          <small>{repository.owner}</small>
          <strong>{repository.name}</strong>
          <p>
            <span>{project.visibility} repository</span>
            <span>Default branch {project.defaultBranch}</span>
          </p>
        </span>
        <span className="repo-meta">
          <small>
            {project.connectedCollaboratorCount} connected collaborator
            {project.connectedCollaboratorCount === 1 ? "" : "s"}
          </small>
          <strong>
            {project.binding.currentBranch ?? project.defaultBranch}
          </strong>
          <small>
            {availability === "Open" ? "Connector online" : availability}
          </small>
        </span>
        <button
          className={`repo-action ${action.toLowerCase()}`}
          type="button"
          aria-label={`${action} ${project.repositoryFullName}`}
          onClick={() =>
            action === "Open"
              ? onOpenProject(project)
              : onConnectProject(project)
          }
        >
          {action}
        </button>
      </article>
    );
  }

  return (
    <div className="app-page projects-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Connected through GitHub</span>
        <h1>Your projects</h1>
        <p>
          Choose a repository. Everything inside stays scoped to that project.
        </p>
        <button
          className="app-primary-action projects-add-action"
          type="button"
          onClick={onAddProject}
        >
          Add project
        </button>
      </header>

      {connectionState === "disconnected" && (
        <section
          className="connector-recovery"
          aria-labelledby="connector-recovery-title"
        >
          <div>
            <span className="connector-recovery-state">
              <StatusMark tone="warn" /> Disconnected
            </span>
            <strong id="connector-recovery-title">
              Reconnect your local Telaegent connector
            </strong>
            <p>
              Local agent work is paused. Open a terminal in the repository you
              want to use, then run a new secure connection command.
            </p>
          </div>
          <button
            className="app-primary-action"
            type="button"
            onClick={onReconnect}
          >
            Generate new command
          </button>
        </section>
      )}

      <div className="projects-layout">
        <section className="project-list" aria-label="Connected repositories">
          {loading && (
            <div className="api-state">
              <TypingDots label="Loading projects" />
              <p>Loading repositories verified by your connector.</p>
            </div>
          )}
          {!loading && error && (
            <div className="api-state error" role="alert">
              <strong>{error.code ?? "Project discovery unavailable"}</strong>
              <p>{apiErrorGuidance(error)}</p>
              {error.retryable && (
                <button type="button" onClick={onRetry}>
                  Retry
                </button>
              )}
            </div>
          )}
          {!loading && !error && grouped.active.length === 0 && (
            <div className="api-state">
              <strong>No active repositories</strong>
              <p>
                Run the local connector from the intended Git repository root,
                confirm its GitHub name, then refresh this page.
              </p>
            </div>
          )}
          {!loading && !error && grouped.active.length > 0 && (
            <div className="project-group-heading">
              <strong>Active projects</strong>
              <small>Verified repositories with a connector online now</small>
            </div>
          )}
          {!loading && !error && grouped.active.map(projectRow)}
          {!loading && !error && grouped.historical.length > 0 && (
            <div className="project-group-heading historical">
              <strong>Previous connections</strong>
              <small>Offline, stopped, or no longer verified</small>
            </div>
          )}
          {!loading && !error && grouped.historical.map(projectRow)}
        </section>

        <aside className="connection-request-card">
          <span className="app-eyebrow">Project trust</span>
          <h2>Connections stay repository-scoped.</h2>
          <p>
            Only repositories independently proven by your local GitHub CLI
            appear here.
          </p>
          <div className="permission-copy">
            <span>
              <StatusMark /> Approved messages are durable
            </span>
            <span>
              <StatusMark tone="quiet" /> Local paths and credentials stay local
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function AddProjectScreen({
  onBack,
  onConnected,
  project,
  autoGenerate = false,
}: {
  onBack: () => void;
  onConnected: () => void;
  project?: ProjectSummary | null;
  autoGenerate?: boolean;
}) {
  const [stage, setStage] = useState<GithubStage>(
    autoGenerate ? "issuing" : "idle",
  );
  const [pairing, setPairing] = useState<ConnectorPairing | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const autoGenerateStartedRef = useRef(false);

  const createCommand = useCallback(async () => {
    setStage("issuing");
    setError(null);
    try {
      const result = await api.createConnectorPairing();
      setPairing(result.pairing);
      setCopied(false);
      setStage("connector");
    } catch (nextError) {
      setError(normalizeApiError(nextError));
      setStage("error");
    }
  }, []);

  useEffect(() => {
    if (!autoGenerate || autoGenerateStartedRef.current) return;
    autoGenerateStartedRef.current = true;
    void createCommand();
  }, [autoGenerate, createCommand]);

  async function copyCommand() {
    if (!pairing) return;
    await navigator.clipboard.writeText(
      buildConnectorCommand(window.location.origin, pairing),
    );
    setCopied(true);
  }

  useEffect(() => {
    if (!autoGenerate || autoGenerateStartedRef.current) return;
    autoGenerateStartedRef.current = true;
    void createCommand();
  }, [autoGenerate]);

  async function checkConnection() {
    if (!pairing || checking) return;
    setChecking(true);
    setError(null);
    try {
      const { connector } = await api.connectorSetupStatus(
        pairing.connectorInstanceId,
      );
      if (!connectorSetupIsReady(connector)) {
        throw new ApiError(
          "The connector has not finished verifying this repository yet. Keep it running and check again.",
          409,
          "CONNECTOR_NOT_READY",
          true,
        );
      }
      setPairing(null);
      setStage("connected");
    } catch (nextError) {
      setError(normalizeApiError(nextError));
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (stage !== "connector" || !pairing) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const { connector } = await api.connectorSetupStatus(
          pairing.connectorInstanceId,
        );
        if (!active) return;
        if (connectorSetupIsReady(connector)) {
          setError(null);
          setPairing(null);
          setStage("connected");
          return;
        }
      } catch {
        // No durable status exists until the one-time command is exchanged.
      }
      if (active) timer = window.setTimeout(() => void poll(), 1_500);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [stage, pairing]);

  return (
    <div className="app-page compact-page add-project-page">
      <button
        className="app-text-button add-project-back"
        type="button"
        onClick={onBack}
      >
        ← Back to projects
      </button>
      <header className="app-page-heading">
        <span className="app-eyebrow">Repository connection</span>
        <h1>Add a project</h1>
        <p>
          {project
            ? `Run Telaegent from your local ${project.repositoryFullName} repository. `
            : "Run Telaegent from the local Git repository you want to add. "}
          The repository path and credentials stay on your computer.
        </p>
      </header>

      {stage === "idle" && (
        <section className="add-project-card">
          <strong>Generate a secure one-time command</strong>
          <p>
            Open a terminal in your repository folder. Telaegent will verify
            that exact GitHub repository before adding it to your projects.
          </p>
          <button
            className="app-primary-action"
            type="button"
            onClick={() => void createCommand()}
          >
            Generate command
          </button>
        </section>
      )}

      {stage === "issuing" && (
        <section className="add-project-card" aria-live="polite">
          <TypingDots label="Generating secure connector command" />
          <p>Generating your secure one-time command…</p>
        </section>
      )}

      {stage === "connector" && pairing && (
        <section className="device-flow add-project-card">
          <div>
            <span>Run from your repository</span>
            <strong>
              {project
                ? `Connect ${project.repositoryFullName}`
                : "Connect this repository"}
            </strong>
          </div>
          <p>
            Open a terminal in the repository you want to add, then run this
            command on Windows, macOS, or Linux.
          </p>
          <div className="connector-command-block">
            <code className="connector-command">
              {buildConnectorCommand(window.location.origin, pairing)}
            </code>
            <p>
              This command expires{" "}
              {new Intl.DateTimeFormat(undefined, {
                hour: "numeric",
                minute: "2-digit",
              }).format(new Date(pairing.expiresAt))}
              .
            </p>
          </div>
          <div className="inline-actions">
            <button
              className="app-secondary-action"
              type="button"
              onClick={() => void copyCommand()}
            >
              {copied ? "Command copied" : "Copy command"}
            </button>
            <button
              className="app-primary-action"
              type="button"
              disabled={checking}
              onClick={() => void checkConnection()}
            >
              {checking ? "Checking…" : "Check connection"}
            </button>
            <button
              className="app-text-button"
              type="button"
              disabled={checking}
              onClick={() => void createCommand()}
            >
              New command
            </button>
          </div>
          {error && (
            <div className="api-state error" role="alert">
              <strong>{error.code ?? "Connector not ready"}</strong>
              <p>{apiErrorGuidance(error)}</p>
            </div>
          )}
        </section>
      )}

      {stage === "error" && error && (
        <section className="api-state error add-project-card" role="alert">
          <strong>{error.code ?? "Connector setup unavailable"}</strong>
          <p>{apiErrorGuidance(error)}</p>
          <button
            className="app-secondary-action"
            type="button"
            onClick={() => void createCommand()}
          >
            Try again
          </button>
        </section>
      )}

      {stage === "connected" && (
        <section
          className="add-project-card add-project-complete"
          aria-live="polite"
        >
          <strong>
            <StatusMark /> Repository added
          </strong>
          <p>
            The connector verified this repository and added it to your project
            list.
          </p>
          <button
            className="app-primary-action"
            type="button"
            onClick={onConnected}
          >
            View projects
          </button>
        </section>
      )}
    </div>
  );
}

type ConnectionMutation = "request" | "accept" | "decline" | "revoke";

type ProjectConnectionGroup = {
  project: ProjectSummary;
  collaborators: ProjectCollaborator[];
  error: ApiError | null;
};

function connectionStatusLabel(
  status: ProjectCollaborator["connectionStatus"],
): string {
  switch (status) {
    case "none":
      return "Available";
    case "pending_outgoing":
      return "Request sent";
    case "pending_incoming":
      return "Your decision";
    case "connected":
      return "Connected";
    case "revoked":
      return "Revoked";
  }
}

function connectionStatusDetail(
  status: ProjectCollaborator["connectionStatus"],
): string {
  switch (status) {
    case "none":
      return "Both of you independently proved access to this repository.";
    case "pending_outgoing":
      return "Waiting for this person to accept the project connection.";
    case "pending_incoming":
      return "They asked to exchange approved messages about this repository.";
    case "connected":
      return "Approved messages can cross; repositories and private drafts stay separate.";
    case "revoked":
      return "This relationship is closed. Either person can request a new one.";
  }
}

function LiveConnectionsScreen({
  projects,
  projectsLoading,
  projectsError,
  onRetryProjects,
}: {
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsError: ApiError | null;
  onRetryProjects: () => void;
}) {
  const [groups, setGroups] = useState<ProjectConnectionGroup[]>([]);
  const [state, setState] = useState<AsyncLoadState>("idle");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<ApiError | null>(null);
  const projectScopeKey = projects
    .map((project) => project.projectId)
    .join(":");

  useEffect(() => {
    if (projectsLoading || projectsError) return;
    if (projects.length === 0) {
      setGroups([]);
      setState("ready");
      return;
    }
    let active = true;
    setState("loading");
    void Promise.all(
      projects.map(async (project): Promise<ProjectConnectionGroup> => {
        try {
          const result = await api.projectCollaborators(project.projectId, {
            limit: 50,
          });
          return {
            project,
            collaborators: result.collaborators,
            error: null,
          };
        } catch (nextError) {
          return {
            project,
            collaborators: [],
            error: normalizeApiError(nextError),
          };
        }
      }),
    ).then((nextGroups) => {
      if (!active) return;
      setGroups(nextGroups);
      setState("ready");
    });
    return () => {
      active = false;
    };
    // The key deliberately reloads when the set of verified projects changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectScopeKey, projectsLoading, projectsError, loadAttempt]);

  async function mutateConnection(
    project: ProjectSummary,
    collaborator: ProjectCollaborator,
    mutation: ConnectionMutation,
  ) {
    const key = `${project.projectId}:${collaborator.userId}`;
    if (mutatingKey !== null) return;
    setMutatingKey(key);
    setMutationError(null);
    try {
      if (mutation === "request") {
        await api.requestProjectConnection(
          project.projectId,
          collaborator.userId,
        );
      } else {
        if (!collaborator.projectConnectionId) {
          throw new ApiError(
            "This connection changed while the page was open. Refresh and try again.",
            409,
            "PROJECT_CONNECTION_STALE",
            true,
          );
        }
        if (mutation === "accept" || mutation === "decline") {
          await api.respondToProjectConnection(
            project.projectId,
            collaborator.projectConnectionId,
            mutation,
          );
        } else {
          await api.revokeProjectConnection(
            project.projectId,
            collaborator.projectConnectionId,
          );
        }
      }
      const refreshed = await api.projectCollaborators(project.projectId, {
        limit: 50,
      });
      setGroups((current) =>
        current.map((group) =>
          group.project.projectId === project.projectId
            ? { ...group, collaborators: refreshed.collaborators, error: null }
            : group,
        ),
      );
    } catch (nextError) {
      setMutationError(normalizeApiError(nextError));
    } finally {
      setMutatingKey(null);
    }
  }
  return (
    <div className="app-page compact-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Project relationships</span>
        <h1>Connections</h1>
        <p>
          A connection belongs to one repository and can be revoked at any time.
        </p>
      </header>
      {projectsLoading && (
        <div className="api-state connections-state">
          <TypingDots label="Loading projects" />
          <p>Loading repositories verified by your connector.</p>
        </div>
      )}
      {!projectsLoading && projectsError && (
        <div className="api-state error connections-state" role="alert">
          <strong>{projectsError.code ?? "Projects unavailable"}</strong>
          <p>{apiErrorGuidance(projectsError)}</p>
          <button type="button" onClick={onRetryProjects}>
            Retry
          </button>
        </div>
      )}
      {!projectsLoading && !projectsError && state === "loading" && (
        <div className="api-state connections-state">
          <TypingDots label="Loading connections" />
          <p>Checking project-scoped relationships.</p>
        </div>
      )}
      {!projectsLoading &&
        !projectsError &&
        state === "ready" &&
        groups.length === 0 && (
          <div className="api-state connections-state">
            <strong>No verified repositories yet</strong>
            <p>Connect a local repository before requesting project trust.</p>
          </div>
        )}
      {mutationError && (
        <div className="api-state error connection-mutation-error" role="alert">
          <strong>{mutationError.code ?? "Connection update failed"}</strong>
          <p>{apiErrorGuidance(mutationError)}</p>
        </div>
      )}
      {!projectsLoading &&
        !projectsError &&
        state === "ready" &&
        groups.map(({ project, collaborators, error }) => (
          <section
            className="settings-section connection-project"
            key={project.projectId}
          >
            <header>
              <div>
                <span>Repository</span>
                <h2>{project.repositoryFullName}</h2>
              </div>
              <span>{collaborators.length} eligible</span>
            </header>
            {error && (
              <div className="api-state error" role="alert">
                <strong>{error.code ?? "Collaborators unavailable"}</strong>
                <p>{apiErrorGuidance(error)}</p>
                <button
                  type="button"
                  onClick={() => setLoadAttempt((value) => value + 1)}
                >
                  Retry
                </button>
              </div>
            )}
            {!error && collaborators.length === 0 && (
              <p className="empty-line">
                No other Telaegent user has independently proved this repository
                yet.
              </p>
            )}
            {collaborators.map((collaborator) => {
              const key = `${project.projectId}:${collaborator.userId}`;
              const busy = mutatingKey === key;
              return (
                <article className="connection-row" key={collaborator.userId}>
                  <span className="app-avatar" aria-hidden="true">
                    {collaborator.githubLogin.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong>@{collaborator.githubLogin}</strong>
                    <small>
                      {connectionStatusDetail(collaborator.connectionStatus)}
                    </small>
                  </div>
                  <span
                    className={`connection-state ${collaborator.connectionStatus}`}
                  >
                    <StatusMark
                      tone={
                        collaborator.connectionStatus === "connected"
                          ? "ok"
                          : collaborator.connectionStatus === "pending_incoming"
                            ? "warn"
                            : "quiet"
                      }
                    />
                    {connectionStatusLabel(collaborator.connectionStatus)}
                  </span>
                  <div className="connection-actions">
                    {(collaborator.connectionStatus === "none" ||
                      collaborator.connectionStatus === "revoked") && (
                      <button
                        className="app-primary-action"
                        type="button"
                        disabled={mutatingKey !== null}
                        onClick={() =>
                          void mutateConnection(
                            project,
                            collaborator,
                            "request",
                          )
                        }
                      >
                        {busy ? "Requesting…" : "Request connection"}
                      </button>
                    )}
                    {collaborator.connectionStatus === "pending_incoming" && (
                      <>
                        <button
                          className="app-secondary-action"
                          type="button"
                          disabled={mutatingKey !== null}
                          onClick={() =>
                            void mutateConnection(
                              project,
                              collaborator,
                              "decline",
                            )
                          }
                        >
                          Decline
                        </button>
                        <button
                          className="app-primary-action"
                          type="button"
                          disabled={mutatingKey !== null}
                          onClick={() =>
                            void mutateConnection(
                              project,
                              collaborator,
                              "accept",
                            )
                          }
                        >
                          {busy ? "Accepting…" : "Accept"}
                        </button>
                      </>
                    )}
                    {collaborator.connectionStatus === "pending_outgoing" && (
                      <button
                        className="app-secondary-action"
                        type="button"
                        disabled={mutatingKey !== null}
                        onClick={() =>
                          void mutateConnection(project, collaborator, "revoke")
                        }
                      >
                        {busy ? "Withdrawing…" : "Withdraw"}
                      </button>
                    )}
                    {collaborator.connectionStatus === "connected" && (
                      <button
                        className="app-secondary-action danger"
                        type="button"
                        disabled={mutatingKey !== null}
                        onClick={() =>
                          void mutateConnection(project, collaborator, "revoke")
                        }
                      >
                        {busy ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        ))}
    </div>
  );
}

function LiveToolsSettings({ projects }: { projects: ProjectSummary[] }) {
  return (
    <div className="app-page compact-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Account and connected tools</span>
        <h1>Settings</h1>
        <p>Cloud-safe state reported by your local connector.</p>
      </header>
      <section className="settings-section">
        <header>
          <h2>Local execution</h2>
        </header>
        <p className="empty-line">
          Provider availability is proven by the local connector. Durable
          per-provider status is not exposed by the backend yet.
        </p>
      </section>
      <section className="settings-section">
        <header>
          <h2>Repositories</h2>
        </header>
        {projects.length === 0 && (
          <p className="empty-line">No verified repositories.</p>
        )}
        {projects.map((project) => (
          <article className="tool-row" key={project.projectId}>
            <div>
              <strong>{project.repositoryFullName}</strong>
              <small>
                Registered by local connector · {project.binding.status}
              </small>
            </div>
            <span className="connection-state">
              <StatusMark
                tone={project.binding.status === "ready" ? "ok" : "warn"}
              />{" "}
              {project.binding.status}
            </span>
          </article>
        ))}
      </section>
    </div>
  );
}

function WorkspaceSidebar({
  project,
  collaborators,
  collaboratorsState,
  collaboratorsError,
  selectedPeerUserId,
  onSelect,
  onRetryCollaborators,
  tab,
  onTabChange,
  onBack,
}: {
  project: ProjectSummary;
  collaborators: ProjectCollaborator[];
  collaboratorsState: AsyncLoadState;
  collaboratorsError: ApiError | null;
  selectedPeerUserId: string | null;
  onSelect: (id: string) => void;
  onRetryCollaborators: () => void;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onBack: () => void;
}) {
  return (
    <aside className="workspace-sidebar">
      <button className="workspace-back" type="button" onClick={onBack}>
        ← All projects
      </button>
      <div className="workspace-repository">
        <span>Repository</span>
        <strong>{project.repositoryFullName}</strong>
        <small>
          {project.binding.currentBranch ?? project.defaultBranch} ·{" "}
          {project.binding.commitSha?.slice(0, 7) ?? "commit unavailable"}
        </small>
      </div>
      <div className="workspace-tabs">
        <button
          className={tab === "chat" ? "selected" : ""}
          type="button"
          onClick={() => onTabChange("chat")}
        >
          Conversation
        </button>
        <button
          className={tab === "people" ? "selected" : ""}
          type="button"
          onClick={() => onTabChange("people")}
        >
          Collaborators
        </button>
        <button
          className={tab === "settings" ? "selected" : ""}
          type="button"
          onClick={() => onTabChange("settings")}
        >
          Project settings
        </button>
      </div>
      {tab === "chat" && (
        <div className="workspace-conversations">
          <span>Conversation</span>
          {collaboratorsState === "loading" && (
            <div className="workspace-conversation-state">
              <TypingDots label="Loading collaborators" />
            </div>
          )}
          {collaboratorsState === "error" && collaboratorsError && (
            <div className="workspace-conversation-state error">
              <small>{apiErrorGuidance(collaboratorsError)}</small>
              {collaboratorsError.retryable && (
                <button type="button" onClick={onRetryCollaborators}>
                  Retry
                </button>
              )}
            </div>
          )}
          {collaboratorsState === "ready" && collaborators.length === 0 && (
            <div className="workspace-conversation-state">
              <small>
                No connected collaborator yet. Open Collaborators to establish
                project trust.
              </small>
            </div>
          )}
          {collaborators
            .map((collaborator) => collaboratorView(collaborator))
            .map((person) => (
              <button
                className={selectedPeerUserId === person.id ? "selected" : ""}
                type="button"
                key={person.id}
                onClick={() => onSelect(person.id)}
              >
                <span className="app-avatar">{person.initial}</span>
                <span>
                  <strong>{person.name}</strong>
                  <small>{person.topic}</small>
                </span>
              </button>
            ))}
        </div>
      )}
      <div className="workspace-agent">
        <span>
          <StatusMark
            tone={project.binding.status === "ready" ? "ok" : "warn"}
          />{" "}
          Connector {project.binding.status}
        </span>
      </div>
    </aside>
  );
}

function mapConversationMessage(
  message: ConversationMessage,
  currentUserId: string | null,
  forceOutgoing = false,
): SharedMessage {
  const outgoing =
    forceOutgoing ||
    (!!currentUserId && message.senderUserId === currentUserId);
  return {
    id: message.messageId,
    side: outgoing ? "outgoing" : "incoming",
    author: outgoing ? "You" : "Teammate",
    provider: formatProvider(message.provider),
    body: message.body,
    meta: formatMessageTime(message.sentAt),
  };
}

function PrivateAgentRoom({
  open,
  draft,
  answering,
  recipient,
  clarification,
  approvedContent,
  editingCandidate,
  busy,
  error,
  onClarificationChange,
  onApprovedContentChange,
  onClarify,
  onNo,
  onEdit,
  onSend,
  onRetry,
}: {
  open: boolean;
  draft: PrivateDraftView | null;
  /** The approved collaborator message this draft answers, on a reply. */
  answering: SharedMessage | null;
  recipient: Collaborator;
  clarification: string;
  approvedContent: string;
  editingCandidate: boolean;
  busy: boolean;
  error: ApiError | null;
  onClarificationChange: (value: string) => void;
  onApprovedContentChange: (value: string) => void;
  onClarify: (event: FormEvent<HTMLFormElement>) => void;
  onNo: () => void;
  onEdit: () => void;
  onSend: () => void;
  onRetry: () => void;
}) {
  const state = draft?.state ?? "created";
  const isWorking = state === "created" || state === "agent_working";
  const lastTurn = draft?.privateTurns.at(-1);
  const showPrivateMessage =
    !!draft?.privateMessage &&
    !(lastTurn?.speaker === "agent" && lastTurn.text === draft.privateMessage);

  return (
    <aside
      className={`workspace-private-room${open ? " open" : ""}`}
      aria-hidden={!open}
    >
      <header>
        <div>
          <strong>
            {state === "ready"
              ? answering
                ? "Reply Approval"
                : "Message Approval"
              : answering
                ? "Reply Preparation"
                : "Message Preparation"}
          </strong>
          <small>
            Private with {draft ? formatProvider(draft.provider) : "your agent"}
            . Not visible to {recipient.name}.
          </small>
        </div>
        <button type="button" onClick={onNo} disabled={busy}>
          No
        </button>
      </header>

      <div className="private-scope-bar">
        <span>{draft?.githubRepositoryId ?? "repository not configured"}</span>
        <span>
          {draft?.draftId
            ? `draft ${draft.draftId.slice(0, 8)}`
            : "private draft"}
        </span>
      </div>

      <div className="workspace-private-thread" aria-live="polite">
        {answering && (
          <article className="private-bubble answering">
            <span>{recipient.name} · approved message</span>
            <p>{answering.body}</p>
          </article>
        )}

        {draft?.roughMessage && (
          <article className="private-bubble user">
            <span>You</span>
            <p>{draft.roughMessage}</p>
          </article>
        )}

        {draft?.privateTurns.map((turn, index) => (
          <article
            className={`private-bubble ${turn.speaker === "owner" ? "user" : "agent"}`}
            key={`${turn.speaker}-${index}`}
          >
            <span>
              {turn.speaker === "owner"
                ? "You"
                : formatProvider(draft.provider)}
            </span>
            <p>{turn.text}</p>
          </article>
        ))}

        {showPrivateMessage && (
          <article className="private-bubble agent">
            <span>{draft ? formatProvider(draft.provider) : "Agent"}</span>
            <p>{draft?.privateMessage}</p>
          </article>
        )}

        {isWorking && (
          <div className="private-thinking">
            <span>
              {state === "created"
                ? "Starting the private turn"
                : "Your agent is preparing the message"}
            </span>
            <TypingDots />
          </div>
        )}

        {state === "needs_clarification" && (
          <form className="private-clarification-form" onSubmit={onClarify}>
            <label htmlFor="draft-clarification">Reply privately</label>
            <textarea
              id="draft-clarification"
              rows={3}
              value={clarification}
              onChange={(event) => onClarificationChange(event.target.value)}
              placeholder="Add the detail your agent needs…"
            />
            <button type="submit" disabled={busy || !clarification.trim()}>
              Continue
            </button>
          </form>
        )}

        {state === "ready" && (
          <article className="private-bubble agent private-candidate">
            <p className="ready-label">Ready to send</p>
            {editingCandidate ? (
              <textarea
                aria-label="Approved message"
                rows={6}
                value={approvedContent}
                onChange={(event) =>
                  onApprovedContentChange(event.target.value)
                }
              />
            ) : (
              <blockquote>{approvedContent || draft?.sendCandidate}</blockquote>
            )}
          </article>
        )}

        {state === "blocked" && (
          <div className="private-runtime-error">
            <strong>This message cannot be sent.</strong>
            <p>
              {draft?.privateMessage ||
                "Telaegent blocked content that cannot cross the project trust boundary."}
            </p>
            {!!draft?.guardFindings.length && (
              <ul>
                {draft.guardFindings.map((finding) => (
                  <li key={finding.code}>{finding.safeReason}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {state === "runtime_failed" && (
          <div className="private-runtime-error">
            <strong>
              {draft?.failure?.code || "The private agent turn stopped"}
            </strong>
            <p>
              {draft?.failure?.message ||
                draft?.privateMessage ||
                "No shared message was created."}
            </p>
            {draft && <small>{draftFailureGuidance(draft)}</small>}
          </div>
        )}

        {error && (
          <div className="api-state error" role="alert">
            <strong>
              {error.code || `Request failed (${error.status || "offline"})`}
            </strong>
            <p>{apiErrorGuidance(error)}</p>
            {!!error.findings.length && (
              <ul>
                {error.findings.map((finding) => (
                  <li key={finding.code}>{finding.safeReason}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <footer className="private-approval-bar">
        <span>
          {state === "ready"
            ? "Only Send crosses the trust boundary."
            : "This work remains private until a message is approved."}
        </span>
        <div>
          {state === "ready" && (
            <button type="button" onClick={onEdit} disabled={busy}>
              Edit
            </button>
          )}
          <button type="button" onClick={onNo} disabled={busy}>
            No
          </button>
          {state === "ready" && (
            <button
              className="send"
              type="button"
              onClick={onSend}
              disabled={busy || !approvedContent.trim()}
            >
              Send
            </button>
          )}
          {(state === "runtime_failed" || (state === "created" && !!error)) &&
            (state !== "runtime_failed"
              ? error?.retryable !== false
              : draft?.failure?.retryable !== false) && (
              <button
                className="send"
                type="button"
                onClick={onRetry}
                disabled={busy}
              >
                Retry
              </button>
            )}
        </div>
      </footer>
    </aside>
  );
}

function ProjectChat({
  project,
  peer,
  conversation,
  conversationState,
  conversationError,
  onRetryConversation,
  currentUserId,
}: {
  project: ProjectSummary;
  peer: ProjectCollaborator | null;
  conversation: ProjectConversation | null;
  conversationState: AsyncLoadState;
  conversationError: ApiError | null;
  onRetryConversation: () => void;
  currentUserId: string | null;
}) {
  const selected = peer ? collaboratorView(peer) : null;
  const [composer, setComposer] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [roughMessage, setRoughMessage] = useState("");
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [messageLoadState, setMessageLoadState] =
    useState<AsyncLoadState>("idle");
  const [messageError, setMessageError] = useState<ApiError | null>(null);
  const [scopeRequests, setScopeRequests] = useState<CapabilityScopeRequest[]>(
    [],
  );
  const [scopeRequestError, setScopeRequestError] = useState<ApiError | null>(
    null,
  );
  const [decidingScopeRequestId, setDecidingScopeRequestId] = useState<
    string | null
  >(null);
  const [draft, setDraft] = useState<PrivateDraftView | null>(null);
  // Set only while a reply draft is open, so the private room can show what is
  // being answered and Retry can reopen the same reply.
  const [answering, setAnswering] = useState<SharedMessage | null>(null);
  const [privateRoomOpen, setPrivateRoomOpen] = useState(false);
  const [clarification, setClarification] = useState("");
  const [approvedContent, setApprovedContent] = useState("");
  const [editingCandidate, setEditingCandidate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const ownMessageIds = useRef(new Set<string>());
  // A network retry or double click reuses the same backend creation key. A
  // deliberate runtime retry clears it and opens a new private attempt.
  const replyCreationKeys = useRef(new Map<string, string>());
  const messageRequests = useRef(
    new SingleFlightByKey<ConversationMessage[]>(),
  );
  const scopeRequestsInFlight = useRef(
    new SingleFlightByKey<CapabilityScopeRequest[]>(),
  );
  const scopeMutationEpoch = useRef(0);
  const configurationError = projectConfigurationError(
    project.githubRepositoryId,
  );
  const conversationId = conversation?.conversationId ?? null;
  const messageScopeKey = `${project.githubRepositoryId}:${conversationId ?? "none"}`;
  const activeMessageScope = useRef(messageScopeKey);
  const activeRepositoryScope = useRef(project.githubRepositoryId);
  activeMessageScope.current = messageScopeKey;
  activeRepositoryScope.current = project.githubRepositoryId;

  function requestScopeRequests(repositoryId: string, fresh = false) {
    const request = async () =>
      (await api.capabilityScopeRequests(repositoryId)).requests;
    return fresh
      ? scopeRequestsInFlight.current.runFresh(repositoryId, request)
      : scopeRequestsInFlight.current.run(repositoryId, request);
  }

  function requestMessages(
    scopeKey: string,
    selectedConversationId: string,
    repositoryId: string,
    fresh = false,
  ) {
    const request = async () =>
      (await api.conversationMessages(selectedConversationId, repositoryId))
        .messages;
    return fresh
      ? messageRequests.current.runFresh(scopeKey, request)
      : messageRequests.current.run(scopeKey, request);
  }

  async function loadScopeRequests(showError = true, fresh = false) {
    if (configurationError) {
      setScopeRequests([]);
      return;
    }
    const repositoryId = project.githubRepositoryId;
    try {
      const requests = await requestScopeRequests(repositoryId, fresh);
      if (activeRepositoryScope.current !== repositoryId) return;
      setScopeRequests(requests);
      setScopeRequestError(null);
    } catch (error) {
      if (showError && activeRepositoryScope.current === repositoryId) {
        setScopeRequestError(normalizeApiError(error));
      }
    }
  }

  async function decideScopeRequest(
    scopeRequestId: string,
    decision: CapabilityScopeDecision,
  ) {
    setDecidingScopeRequestId(scopeRequestId);
    setScopeRequestError(null);
    scopeMutationEpoch.current += 1;
    try {
      await api.decideCapabilityScopeRequest(scopeRequestId, decision);
      scopeMutationEpoch.current += 1;
      setScopeRequests((current) =>
        current.filter((request) => request.scopeRequestId !== scopeRequestId),
      );
      await loadScopeRequests(false, true);
    } catch (error) {
      scopeMutationEpoch.current += 1;
      setScopeRequestError(normalizeApiError(error));
      await loadScopeRequests(false, true);
    } finally {
      setDecidingScopeRequestId(null);
    }
  }

  async function loadMessages(fresh = false) {
    if (configurationError || !conversationId) {
      setMessages([]);
      setMessageLoadState("idle");
      return;
    }
    setMessageLoadState("loading");
    setMessageError(null);
    const scopeKey = messageScopeKey;
    const selectedConversationId = conversationId;
    const repositoryId = project.githubRepositoryId;
    try {
      const nextMessages = await requestMessages(
        scopeKey,
        selectedConversationId,
        repositoryId,
        fresh,
      );
      if (activeMessageScope.current !== scopeKey) return;
      setMessages(
        nextMessages.map((message) =>
          mapConversationMessage(
            message,
            currentUserId,
            ownMessageIds.current.has(message.messageId),
          ),
        ),
      );
      setMessageLoadState("ready");
    } catch (error) {
      if (activeMessageScope.current !== scopeKey) return;
      setMessageError(normalizeApiError(error));
      setMessageLoadState("error");
    }
  }

  useEffect(() => {
    let active = true;
    ownMessageIds.current.clear();
    replyCreationKeys.current.clear();
    setComposer("");
    setRoughMessage("");
    setPrivateRoomOpen(false);
    setDraft(null);
    setAnswering(null);
    setActionError(null);
    if (configurationError || !conversationId) {
      setMessages([]);
      setMessageLoadState("idle");
      return () => {
        active = false;
      };
    }
    setMessageLoadState("loading");
    setMessageError(null);
    const scopeKey = messageScopeKey;
    void requestMessages(scopeKey, conversationId, project.githubRepositoryId)
      .then((nextMessages) => {
        if (!active || activeMessageScope.current !== scopeKey) return;
        setMessages(
          nextMessages.map((message) =>
            mapConversationMessage(
              message,
              currentUserId,
              ownMessageIds.current.has(message.messageId),
            ),
          ),
        );
        setMessageLoadState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessageError(normalizeApiError(error));
        setMessageLoadState("error");
      });
    return () => {
      active = false;
    };
  }, [
    conversationId,
    configurationError,
    currentUserId,
    project.githubRepositoryId,
  ]);

  useEffect(() => {
    if (configurationError || !conversationId || messageLoadState !== "ready")
      return;
    let active = true;
    const scopeKey = messageScopeKey;
    const poller = new AdaptivePoller({
      poll: async () => {
        const nextMessages = await requestMessages(
          scopeKey,
          conversationId,
          project.githubRepositoryId,
        );
        if (!active || activeMessageScope.current !== scopeKey) return false;
        setMessages(
          nextMessages.map((message) =>
            mapConversationMessage(
              message,
              currentUserId,
              ownMessageIds.current.has(message.messageId),
            ),
          ),
        );
        return nextMessages.length > 0;
      },
      onError: () => {
        // Keep the last approved snapshot. An explicit load exposes connection errors.
      },
    });
    const stop = startVisiblePolling(poller, false);
    return () => {
      active = false;
      stop();
    };
  }, [
    configurationError,
    conversationId,
    currentUserId,
    messageLoadState,
    project.githubRepositoryId,
  ]);

  useEffect(() => {
    if (configurationError) {
      setScopeRequests([]);
      setScopeRequestError(null);
      return;
    }
    let active = true;
    setScopeRequests([]);
    setScopeRequestError(null);
    const repositoryId = project.githubRepositoryId;
    const poller = new AdaptivePoller({
      poll: async () => {
        const requestEpoch = scopeMutationEpoch.current;
        const requests = await requestScopeRequests(repositoryId);
        if (
          !active ||
          activeRepositoryScope.current !== repositoryId ||
          scopeMutationEpoch.current !== requestEpoch
        )
          return false;
        setScopeRequests(requests);
        setScopeRequestError(null);
        return requests.length > 0;
      },
      onError: (error) => {
        if (active && activeRepositoryScope.current === repositoryId) {
          setScopeRequestError(normalizeApiError(error));
        }
      },
    });
    const stop = startVisiblePolling(poller);
    return () => {
      active = false;
      stop();
    };
  }, [configurationError, project.githubRepositoryId]);

  useEffect(() => {
    if (!privateRoomOpen || draft?.state !== "agent_working") return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .conversationDraft(draft.draftId)
        .then(({ draft: nextDraft }) => {
          if (!active) return;
          setDraft(nextDraft);
          setActionError(null);
          if (nextDraft.state === "ready") {
            setApprovedContent(nextDraft.sendCandidate ?? "");
            setEditingCandidate(false);
          }
        })
        .catch((error: unknown) => {
          if (active) setActionError(normalizeApiError(error));
        });
    }, 900);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [actionError, draft, privateRoomOpen]);

  async function runDraft(draftId: string) {
    try {
      const result = await api.runConversationDraft(draftId);
      setDraft(result.draft);
      setActionError(null);
    } catch (error) {
      setActionError(normalizeApiError(error));
    }
  }

  async function createAndRunDraft(message: string) {
    if (!conversationId) return;
    setBusy(true);
    setDraft(null);
    setActionError(null);
    try {
      const created = await api.createConversationDraft(conversationId, {
        githubRepositoryId: project.githubRepositoryId,
        provider,
        roughMessage: message,
      });
      setDraft(created.draft);
      setPrivateRoomOpen(true);
      await runDraft(created.draft.draftId);
    } catch (error) {
      setActionError(normalizeApiError(error));
      setPrivateRoomOpen(true);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Opens the recipient half of the round trip.
   *
   * The reply is an ordinary private draft: it stays owner-private and still
   * leaves only through Send, so answering a collaborator faces the same gate
   * as starting a message.
   */
  async function createAndRunReply(message: SharedMessage, forceNew = false) {
    if (!conversationId) return;
    setBusy(true);
    setDraft(null);
    setActionError(null);
    setAnswering(message);
    setRoughMessage("");
    setClarification("");
    setApprovedContent("");
    setEditingCandidate(false);
    try {
      if (forceNew) replyCreationKeys.current.delete(message.id);
      let idempotencyKey = replyCreationKeys.current.get(message.id);
      if (!idempotencyKey) {
        idempotencyKey = `reply:${message.id}:${crypto.randomUUID()}`;
        replyCreationKeys.current.set(message.id, idempotencyKey);
      }
      const created = await api.createConversationReply(conversationId, {
        githubRepositoryId: project.githubRepositoryId,
        provider,
        incomingMessageId: message.id,
        idempotencyKey,
      });
      setDraft(created.draft);
      setPrivateRoomOpen(true);
      await runDraft(created.draft.draftId);
    } catch (error) {
      setActionError(normalizeApiError(error));
      setPrivateRoomOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function submitRoughMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextMessage = composer.trim();
    if (
      !nextMessage ||
      busy ||
      privateRoomOpen ||
      configurationError ||
      !conversationId ||
      conversationState !== "ready"
    )
      return;
    setRoughMessage(nextMessage);
    setAnswering(null);
    setClarification("");
    setApprovedContent("");
    setEditingCandidate(false);
    void createAndRunDraft(nextMessage);
  }

  function handleComposerKeyDown(
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (
      !shouldSubmitComposerOnKeyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
      })
    )
      return;
    event.preventDefault();
    if (busy || privateRoomOpen || !composer.trim()) return;
    event.currentTarget.form?.requestSubmit();
  }

  async function clarifyDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !clarification.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const clarified = await api.clarifyConversationDraft(
        draft.draftId,
        clarification.trim(),
      );
      setDraft(clarified.draft);
      setClarification("");
      await runDraft(draft.draftId);
    } catch (error) {
      setActionError(normalizeApiError(error));
    } finally {
      setBusy(false);
    }
  }

  async function rejectDraft() {
    if (!draft) {
      setPrivateRoomOpen(false);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelConversationDraft(draft.draftId);
      if (answering) replyCreationKeys.current.delete(answering.id);
      setPrivateRoomOpen(false);
      setDraft(null);
      setAnswering(null);
      setComposer("");
    } catch (error) {
      setActionError(normalizeApiError(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendDraft() {
    if (!draft || draft.state !== "ready" || !approvedContent.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await api.sendConversationDraft(draft.draftId, {
        approvedContent: approvedContent.trim(),
        idempotencyKey: `send:${draft.draftId}:${crypto.randomUUID()}`,
      });
      ownMessageIds.current.add(result.message.messageId);
      if (answering) replyCreationKeys.current.delete(answering.id);
      setMessages((current) => [
        ...current,
        mapConversationMessage(result.message, currentUserId, true),
      ]);
      setMessageLoadState("ready");
      setPrivateRoomOpen(false);
      setDraft(null);
      setAnswering(null);
      setComposer("");
      await loadMessages(true);
    } catch (error) {
      setActionError(normalizeApiError(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryDraft() {
    if (draft?.state === "created") {
      setBusy(true);
      await runDraft(draft.draftId);
      setBusy(false);
      return;
    }
    if (answering) {
      await createAndRunReply(answering, true);
      return;
    }
    if (roughMessage) await createAndRunDraft(roughMessage);
  }

  return (
    <section
      className={`project-chat${privateRoomOpen ? " private-open" : ""}`}
    >
      <header className="project-chat-header">
        <div>
          <span className="app-avatar">{selected?.initial ?? "--"}</span>
          <span>
            <strong>{selected?.name ?? "Select a collaborator"}</strong>
            <small>Approved project conversation</small>
          </span>
        </div>
        <div className="chat-header-meta">
          <span>
            {formatProvider(provider)} / {selected?.provider ?? "local agent"}
          </span>
        </div>
      </header>

      <div className="chat-project-strip">
        <span>
          <StatusMark tone={messageLoadState === "error" ? "warn" : "ok"} />{" "}
          {project.repositoryFullName}
        </span>
        <small className="chat-project-repository-id">
          Repository ID {project.githubRepositoryId}
        </small>
      </div>

      <div className="shared-thread" aria-live="polite">
        {(scopeRequests.length > 0 || scopeRequestError) && (
          <section
            className="scope-approval-queue"
            aria-label="File access decisions"
          >
            {scopeRequestError && (
              <div className="scope-approval-error" role="alert">
                <span>{apiErrorGuidance(scopeRequestError)}</span>
                <button type="button" onClick={() => void loadScopeRequests()}>
                  Try again
                </button>
              </div>
            )}
            {scopeRequests.map((request) => {
              const requestingPeer =
                request.peerUserId === peer?.userId
                  ? `@${peer.githubLogin}'s Agent`
                  : `Peer agent ${request.peerUserId.slice(0, 8)}`;
              const deciding =
                decidingScopeRequestId === request.scopeRequestId;
              return (
                <article
                  className="scope-approval-card"
                  key={request.scopeRequestId}
                >
                  <header>
                    <div>
                      <span className="scope-approval-kicker">
                        Your decision is needed
                      </span>
                      <h2>{request.resourceDisplayLabel}</h2>
                      <small className="scope-resource-id">
                        Resource {request.candidateResourceId}
                      </small>
                    </div>
                    <span className="scope-read-badge">Read only</span>
                  </header>
                  <div
                    className="scope-access-route"
                    aria-label={`${requestingPeer} requests read-only access to ${request.requestedHint ?? request.candidateResourceId}`}
                  >
                    <span>{requestingPeer}</span>
                    <span className="scope-route-operation" aria-hidden="true">
                      <i />
                      read
                      <i />
                    </span>
                    <code>
                      {request.requestedHint ?? request.candidateResourceId}
                    </code>
                  </div>
                  <div className="scope-request-reason">
                    <span>Reason</span>
                    <p>{request.requestedReason}</p>
                  </div>
                  <p className="scope-task-note">
                    <strong>One-time access</strong> reads this version.{" "}
                    <strong>Task access</strong> follows updates until{" "}
                    {formatTaskExpiry(request.taskExpiresAt)}.
                  </p>
                  {request.requestedHint && (
                    <details className="scope-technical-details">
                      <summary>Technical details</summary>
                      <code>{request.candidateResourceId}</code>
                    </details>
                  )}
                  <footer>
                    <button
                      className="scope-deny"
                      type="button"
                      disabled={deciding}
                      onClick={() =>
                        void decideScopeRequest(request.scopeRequestId, "deny")
                      }
                    >
                      Deny
                    </button>
                    <div>
                      <button
                        className="scope-task-allow"
                        type="button"
                        disabled={deciding}
                        onClick={() =>
                          void decideScopeRequest(
                            request.scopeRequestId,
                            "task",
                          )
                        }
                      >
                        Allow for this task
                      </button>
                      <button
                        className="scope-once-allow"
                        type="button"
                        disabled={deciding}
                        onClick={() =>
                          void decideScopeRequest(
                            request.scopeRequestId,
                            "once",
                          )
                        }
                      >
                        Allow once
                      </button>
                    </div>
                  </footer>
                  {deciding && (
                    <span className="scope-deciding" role="status">
                      <TypingDots label="Recording your decision" /> Recording
                      your decision
                    </span>
                  )}
                </article>
              );
            })}
          </section>
        )}
        {messageLoadState === "loading" && (
          <div className="turn-status">
            <TypingDots label="Loading approved messages" />
            <span>Loading approved messages</span>
          </div>
        )}
        {conversationState === "loading" && (
          <div className="turn-status">
            <TypingDots label="Opening conversation" />
            <span>Opening the project-scoped conversation</span>
          </div>
        )}
        {conversationState === "error" && conversationError && (
          <div className="api-state error" role="alert">
            <strong>
              {conversationError.code ||
                `Conversation unavailable (${conversationError.status || "offline"})`}
            </strong>
            <p>{apiErrorGuidance(conversationError)}</p>
            {conversationError.retryable && (
              <button type="button" onClick={onRetryConversation}>
                Retry
              </button>
            )}
          </div>
        )}
        {conversationState === "idle" && (
          <div className="api-state">
            <strong>
              {configurationError
                ? "This project cannot open a conversation"
                : "Choose a connected collaborator"}
            </strong>
            <p>
              {configurationError ??
                "A shared conversation opens only for a peer who accepted this project connection."}
            </p>
          </div>
        )}
        {messageLoadState === "error" && messageError && (
          <div className="api-state error" role="alert">
            <strong>
              {messageError.code ||
                `Conversation unavailable (${messageError.status || "offline"})`}
            </strong>
            <p>{apiErrorGuidance(messageError)}</p>
            {messageError.retryable && (
              <button type="button" onClick={() => void loadMessages()}>
                Retry
              </button>
            )}
          </div>
        )}
        {messageLoadState === "ready" && messages.length === 0 && (
          <div className="empty-conversation">
            <span className="app-avatar">{selected?.initial ?? "--"}</span>
            <h2>
              Start a project conversation with{" "}
              {selected?.name ?? "this collaborator"}.
            </h2>
            <p>
              Your rough message goes to your agent privately before{" "}
              {selected?.name ?? "the collaborator"} can see it.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <article
            className={`shared-message ${message.side}`}
            key={message.id}
          >
            <span>
              {message.author} / {message.provider}
            </span>
            <p>{message.body}</p>
            <small>{message.meta}</small>
            {message.side === "incoming" && (
              <button
                className="app-secondary-action shared-message-reply"
                type="button"
                onClick={() => void createAndRunReply(message)}
                disabled={busy || privateRoomOpen}
              >
                Prepare reply
              </button>
            )}
          </article>
        ))}
      </div>

      <form className="shared-composer" onSubmit={submitRoughMessage}>
        <label className="composer-provider-picker">
          <span>Local provider</span>
          <select
            value={provider}
            onChange={(event) =>
              setProvider(event.target.value as AgentProvider)
            }
            disabled={busy}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <div>
          <textarea
            id="project-message"
            rows={2}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={`Ask ${selected?.name ?? "a connected collaborator"} about this project…`}
            disabled={
              !!configurationError ||
              !conversationId ||
              conversationState !== "ready"
            }
          />
          <button
            type="submit"
            disabled={
              busy ||
              !composer.trim() ||
              !!configurationError ||
              !conversationId ||
              conversationState !== "ready"
            }
          >
            Prepare privately
          </button>
        </div>
      </form>

      {selected && (
        <PrivateAgentRoom
          open={privateRoomOpen}
          draft={draft}
          answering={answering}
          recipient={selected}
          clarification={clarification}
          approvedContent={approvedContent}
          editingCandidate={editingCandidate}
          busy={busy}
          error={actionError}
          onClarificationChange={setClarification}
          onApprovedContentChange={setApprovedContent}
          onClarify={clarifyDraft}
          onNo={() => void rejectDraft()}
          onEdit={() => setEditingCandidate(true)}
          onSend={() => void sendDraft()}
          onRetry={() => void retryDraft()}
        />
      )}
    </section>
  );
}

function ProjectPeople({
  project,
  collaborators,
  state,
  error,
  onRetry,
}: {
  project: ProjectSummary;
  collaborators: ProjectCollaborator[];
  state: AsyncLoadState;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <span className="app-eyebrow">{project.repositoryFullName}</span>
        <h1>Project collaborators</h1>
        <p>
          A connection allows project-scoped messages. It never grants direct
          repository access.
        </p>
      </header>
      <div className="collaborator-list">
        {state === "loading" && (
          <div className="api-state">
            <TypingDots label="Loading collaborators" />
            <p>Loading independently verified project members.</p>
          </div>
        )}
        {state === "error" && error && (
          <div className="api-state error" role="alert">
            <strong>{error.code || "Collaborators unavailable"}</strong>
            <p>{apiErrorGuidance(error)}</p>
            {error.retryable && (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
        {state === "ready" && collaborators.length === 0 && (
          <div className="api-state">
            <strong>No other verified member yet</strong>
            <p>
              Another Telaegent user must independently connect this same GitHub
              repository before either side can request project trust.
            </p>
          </div>
        )}
        {collaborators.map((collaborator) => (
          <article key={collaborator.userId}>
            <span className="app-avatar">
              {collaborator.githubLogin.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>@{collaborator.githubLogin}</strong>
              <small>
                {collaborator.connectionStatus.replaceAll("_", " ")}
              </small>
            </div>
            <span className="connection-state">
              <StatusMark
                tone={
                  collaborator.connectionStatus === "connected" ? "ok" : "quiet"
                }
              />{" "}
              {collaborator.connectionStatus.replaceAll("_", " ")}
            </span>
          </article>
        ))}
      </div>
    </div>
  );
}

function ProjectSettings({ project }: { project: ProjectSummary }) {
  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <span className="app-eyebrow">{project.repositoryFullName}</span>
        <h1>Project settings</h1>
        <p>These choices apply only to this repository.</p>
      </header>
      <section className="settings-section">
        <header>
          <h2>Project agent</h2>
        </header>
        <p className="empty-line">
          Choose a provider when preparing a message. Persistent project
          defaults need a backend-owned provider preference contract.
        </p>
      </section>
      <section className="settings-section">
        <header>
          <h2>Active connections</h2>
        </header>
        <p className="empty-line">
          Use the Collaborators workflow to manage project-scoped trust.
          Dedicated connection controls are not available on this settings
          screen yet.
        </p>
      </section>
      <section className="settings-section danger-zone">
        <header>
          <h2>Repository connection</h2>
        </header>
        <article className="tool-row">
          <div>
            <strong>Disconnect {project.repositoryFullName}</strong>
            <small>
              Credential revocation exists, but project-scoped disconnect is not
              exposed to the browser yet.
            </small>
          </div>
        </article>
      </section>
    </div>
  );
}

function Workspace({
  project,
  onBack,
  currentUserId,
}: {
  project: ProjectSummary;
  onBack: () => void;
  currentUserId: string | null;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("chat");
  const [collaborators, setCollaborators] = useState<ProjectCollaborator[]>([]);
  const [collaboratorsState, setCollaboratorsState] =
    useState<AsyncLoadState>("loading");
  const [collaboratorsError, setCollaboratorsError] = useState<ApiError | null>(
    null,
  );
  const [selectedPeerUserId, setSelectedPeerUserId] = useState<string | null>(
    null,
  );
  const [conversation, setConversation] = useState<ProjectConversation | null>(
    null,
  );
  const [conversationPeerUserId, setConversationPeerUserId] = useState<
    string | null
  >(null);
  const [conversationState, setConversationState] =
    useState<AsyncLoadState>("idle");
  const [conversationError, setConversationError] = useState<ApiError | null>(
    null,
  );
  const [conversationAttempt, setConversationAttempt] = useState(0);
  const collaboratorRequest = useRef(0);

  async function loadCollaborators() {
    const requestId = ++collaboratorRequest.current;
    setCollaboratorsState("loading");
    setCollaboratorsError(null);
    setCollaborators([]);
    setSelectedPeerUserId(null);
    setConversation(null);
    setConversationPeerUserId(null);
    setConversationState("idle");
    setConversationError(null);
    try {
      const result = await api.projectCollaborators(project.projectId, {
        limit: 50,
      });
      if (requestId !== collaboratorRequest.current) return;
      setCollaborators(result.collaborators);
      setSelectedPeerUserId((current) =>
        selectConnectedPeer(result.collaborators, current),
      );
      setCollaboratorsState("ready");
    } catch (error) {
      if (requestId !== collaboratorRequest.current) return;
      setCollaborators([]);
      setSelectedPeerUserId(null);
      setCollaboratorsError(normalizeApiError(error));
      setCollaboratorsState("error");
    }
  }

  useEffect(() => {
    let active = true;
    const requestId = ++collaboratorRequest.current;
    setCollaboratorsState("loading");
    setCollaboratorsError(null);
    setCollaborators([]);
    setSelectedPeerUserId(null);
    setConversation(null);
    setConversationPeerUserId(null);
    setConversationState("idle");
    setConversationError(null);
    void api
      .projectCollaborators(project.projectId, { limit: 50 })
      .then((result) => {
        if (!active || requestId !== collaboratorRequest.current) return;
        setCollaborators(result.collaborators);
        setSelectedPeerUserId(selectConnectedPeer(result.collaborators, null));
        setCollaboratorsState("ready");
      })
      .catch((error: unknown) => {
        if (!active || requestId !== collaboratorRequest.current) return;
        setCollaboratorsError(normalizeApiError(error));
        setCollaboratorsState("error");
      });
    return () => {
      active = false;
    };
  }, [project.projectId]);

  useEffect(() => {
    let active = true;
    setConversation(null);
    setConversationPeerUserId(null);
    setConversationError(null);
    if (!selectedPeerUserId || !currentUserId) {
      setConversationState("idle");
      return () => {
        active = false;
      };
    }
    const projectError = projectConfigurationError(project.githubRepositoryId);
    if (projectError) {
      setConversationError(
        new ApiError(projectError, 400, "INVALID_PROJECT_SCOPE", false),
      );
      setConversationState("error");
      return () => {
        active = false;
      };
    }
    const selectedPeer = collaborators.find(
      (candidate) =>
        candidate.userId === selectedPeerUserId &&
        candidate.connectionStatus === "connected",
    );
    if (!selectedPeer) {
      setSelectedPeerUserId(selectConnectedPeer(collaborators, null));
      setConversationState("idle");
      return () => {
        active = false;
      };
    }
    setConversationState("loading");
    void api
      .createProjectConversation(project.projectId, selectedPeerUserId)
      .then((result) => {
        if (!active) return;
        const scoped = assertConversationScope({
          conversation: result.conversation,
          projectId: project.projectId,
          githubRepositoryId: project.githubRepositoryId,
          currentUserId,
          peerUserId: selectedPeerUserId,
        });
        setConversation(scoped);
        setConversationPeerUserId(selectedPeerUserId);
        setConversationState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setConversationError(normalizeApiError(error));
        setConversationState("error");
      });
    return () => {
      active = false;
    };
  }, [
    collaborators,
    conversationAttempt,
    currentUserId,
    project.githubRepositoryId,
    project.projectId,
    selectedPeerUserId,
  ]);

  const connected = connectedCollaborators(collaborators);
  const selectedPeer =
    connected.find((candidate) => candidate.userId === selectedPeerUserId) ??
    null;
  const selectedConversation =
    selectedPeer && conversationPeerUserId === selectedPeer.userId
      ? conversation
      : null;

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar
        project={project}
        collaborators={connected}
        collaboratorsState={collaboratorsState}
        collaboratorsError={collaboratorsError}
        selectedPeerUserId={selectedPeerUserId}
        onSelect={setSelectedPeerUserId}
        onRetryCollaborators={() => void loadCollaborators()}
        tab={tab}
        onTabChange={setTab}
        onBack={onBack}
      />
      <div className="workspace-mobile-tabs">
        <button type="button" onClick={onBack}>
          Projects
        </button>
        {(["chat", "people", "settings"] as WorkspaceTab[]).map((item) => (
          <button
            className={tab === item ? "selected" : ""}
            type="button"
            key={item}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {tab === "chat" && (
        <ProjectChat
          project={project}
          peer={selectedPeer}
          conversation={selectedConversation}
          conversationState={selectedPeer ? conversationState : "idle"}
          conversationError={conversationError}
          onRetryConversation={() =>
            setConversationAttempt((attempt) => attempt + 1)
          }
          currentUserId={currentUserId}
        />
      )}
      {tab === "people" && (
        <ProjectPeople
          project={project}
          collaborators={collaborators}
          state={collaboratorsState}
          error={collaboratorsError}
          onRetry={() => void loadCollaborators()}
        />
      )}
      {tab === "settings" && <ProjectSettings project={project} />}
    </div>
  );
}

export default function ProductApp({
  theme,
  onToggleTheme,
  onExit,
  user,
  onLogout,
  preview = false,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onExit: () => void;
  user: TelaegentWebUser | null;
  onLogout: () => void | Promise<void>;
  preview?: boolean;
}) {
  const initialLocation = productLocationFromUrl(
    window.location.pathname,
    window.location.search,
    preview,
  );
  const isDefaultProductEntry =
    window.location.pathname === APP_PATH ||
    !window.location.pathname.startsWith(`${APP_PATH}/`);
  const requestedPreviewRoute = new URLSearchParams(window.location.search).get(
    "route",
  );
  const initialRoute = isDefaultProductEntry
    ? initialProductEntryRoute({
        authenticated: user !== null,
        preview,
        requestedPreviewRoute,
      })
    : initialLocation.route;
  const [route, setRoute] = useState<ProductRoute>(initialRoute);
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string | null>(
    initialLocation.projectId,
  );
  const [discoveredProjects, setDiscoveredProjects] = useState<
    ProjectSummary[]
  >([]);
  const [projectsLoading, setProjectsLoading] = useState(
    () => !preview && user !== null,
  );
  const [projectsError, setProjectsError] = useState<ApiError | null>(null);
  const [autoGenerateConnectorCommand, setAutoGenerateConnectorCommand] =
    useState(false);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(
    null,
  );
  const [projectToConnect, setProjectToConnect] =
    useState<ProjectSummary | null>(null);
  const projectsRequestInFlightRef = useRef(false);
  const entryProjectDiscoveryRef = useRef<"pending" | "loading" | "resolved">(
    !preview && user && isDefaultProductEntry && initialRoute === "projects"
      ? "pending"
      : "resolved",
  );

  async function loadProjects() {
    if (!user || projectsRequestInFlightRef.current) return;
    const resolvesProductEntry = entryProjectDiscoveryRef.current === "pending";
    projectsRequestInFlightRef.current = true;
    if (resolvesProductEntry) entryProjectDiscoveryRef.current = "loading";
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const result = await api.projects({ limit: 50 });
      setDiscoveredProjects(result.projects);
      setSelectedProject((current) =>
        current
          ? (result.projects.find(
              (project) => project.projectId === current.projectId,
            ) ?? null)
          : null,
      );
      if (
        resolvesProductEntry &&
        entryProjectDiscoveryRef.current === "loading"
      ) {
        navigateProduct(
          productEntryRouteAfterDiscovery(result.projects.length),
          null,
          true,
        );
      }
    } catch (error) {
      setProjectsError(normalizeApiError(error));
    } finally {
      projectsRequestInFlightRef.current = false;
      if (resolvesProductEntry) entryProjectDiscoveryRef.current = "resolved";
      setProjectsLoading(false);
    }
  }

  useEffect(() => {
    if (route === "onboarding" || !user) return;
    void loadProjects();
    // Project discovery is refreshed on navigation; connector/revocation state
    // must not be treated as a permanent browser cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, user?.userId]);

  useEffect(() => {
    const syncRoute = () => {
      const nextLocation = productLocationFromUrl(
        window.location.pathname,
        window.location.search,
        preview,
      );
      setRoute(nextLocation.route);
      setWorkspaceProjectId(nextLocation.projectId);
      if (nextLocation.route !== "workspace") setSelectedProject(null);
    };
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, [preview]);

  useEffect(() => {
    if (route !== "workspace" || !workspaceProjectId) return;
    const restoredProject = discoveredProjects.find(
      (project) => project.projectId === workspaceProjectId,
    );
    if (restoredProject) setSelectedProject(restoredProject);
  }, [discoveredProjects, route, workspaceProjectId]);

  function navigateProduct(
    nextRoute: ProductRoute,
    projectId: string | null = null,
    replace = false,
  ) {
    entryProjectDiscoveryRef.current = "resolved";
    const nextPath = productPath(nextRoute, projectId, preview);
    if (`${window.location.pathname}${window.location.search}` !== nextPath) {
      window.history[replace ? "replaceState" : "pushState"](
        null,
        "",
        nextPath,
      );
    }
    setRoute(nextRoute);
    setWorkspaceProjectId(projectId);
    if (nextRoute !== "workspace") setSelectedProject(null);
  }

  function openProject(project: ProjectSummary) {
    setSelectedProject(project);
    navigateProduct("workspace", project.projectId);
  }

  function connectProject(project: ProjectSummary) {
    setProjectToConnect(project);
    setAutoGenerateConnectorCommand(true);
    navigateProduct("add-project");
  }

  function openConnectorSetup(autoGenerate: boolean) {
    setProjectToConnect(null);
    setAutoGenerateConnectorCommand(autoGenerate);
    navigateProduct("add-project");
  }

  const connectionState = connectorPresence(
    discoveredProjects,
    projectsLoading,
  );

  if (route === "onboarding") {
    return (
      <Onboarding
        theme={theme}
        onToggleTheme={onToggleTheme}
        onExit={onExit}
        user={user}
        onComplete={() => navigateProduct("projects", null, true)}
      />
    );
  }

  return (
    <div className={`product-app-shell${preview ? " preview-mode" : ""}`}>
      <header className="app-topbar">
        <button
          className="app-wordmark"
          type="button"
          onClick={onExit}
          aria-label="Back to Telaegent landing"
        >
          <img
            src={theme === "dark" ? telaegentLogoBright : telaegentLogo}
            alt="Telaegent"
          />
        </button>
        <div className="app-topbar-context">
          {route === "workspace" && selectedProject ? (
            <>
              <span>Project</span>
              <strong>{selectedProject.repositoryFullName}</strong>
            </>
          ) : (
            <strong>{preview ? "Local UI preview" : "Telaegent cloud"}</strong>
          )}
        </div>
        <div className="app-topbar-actions">
          {connectionState === "disconnected" ? (
            <button
              className="connector-presence disconnected"
              type="button"
              onClick={() => openConnectorSetup(true)}
              aria-label="Telaegent disconnected. Generate a new connection command."
            >
              <StatusMark tone="warn" />
              <span>
                <small>Telaegent</small>
                <strong>Disconnected</strong>
              </span>
            </button>
          ) : (
            <div
              className={`connector-presence ${connectionState}`}
              role="status"
              aria-live="polite"
            >
              {connectionState === "connected" ? (
                <StatusMark />
              ) : (
                <TypingDots label="Checking Telaegent connection" />
              )}
              <span>
                <small>Telaegent</small>
                <strong>
                  {connectionState === "connected" ? "Connected" : "Checking"}
                </strong>
              </span>
            </div>
          )}
          <button
            className="app-text-button"
            type="button"
            onClick={onToggleTheme}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <div className="account-summary">
            <span>
              {(user?.githubLogin ?? "Demo").slice(0, 2).toUpperCase()}
            </span>
            <strong>{user?.githubLogin ?? "Demo"}</strong>
          </div>
          <button
            className="app-text-button logout-button"
            type="button"
            onClick={() => void onLogout()}
          >
            Log out
          </button>
        </div>
      </header>
      <div className="app-body">
        <ProductNav route={route} onNavigate={navigateProduct} />
        <main className="app-content">
          {route === "projects" && (
            <ProjectsScreen
              onOpenProject={openProject}
              onConnectProject={connectProject}
              onAddProject={() => openConnectorSetup(false)}
              onReconnect={() => openConnectorSetup(true)}
              connectionState={connectionState}
              projects={discoveredProjects}
              loading={projectsLoading}
              error={projectsError}
              onRetry={() => void loadProjects()}
            />
          )}
          {route === "add-project" && (
            <AddProjectScreen
              project={projectToConnect}
              autoGenerate={autoGenerateConnectorCommand}
              onBack={() => {
                setProjectToConnect(null);
                setAutoGenerateConnectorCommand(false);
                navigateProduct("projects");
              }}
              onConnected={() => {
                setProjectToConnect(null);
                setAutoGenerateConnectorCommand(false);
                navigateProduct("projects");
              }}
            />
          )}
          {route === "connections" && (
            <LiveConnectionsScreen
              projects={discoveredProjects}
              projectsLoading={projectsLoading}
              projectsError={projectsError}
              onRetryProjects={() => void loadProjects()}
            />
          )}
          {route === "settings" && (
            <LiveToolsSettings projects={discoveredProjects} />
          )}
          {route === "workspace" && selectedProject && (
            <Workspace
              project={selectedProject}
              onBack={() => navigateProduct("projects")}
              currentUserId={user?.userId ?? null}
            />
          )}
          {route === "workspace" && !selectedProject && (
            <div className="app-page api-state">
              <strong>This verified project is unavailable</strong>
              <button type="button" onClick={() => navigateProduct("projects")}>
                Back to projects
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
