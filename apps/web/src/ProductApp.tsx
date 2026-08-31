import { useEffect, useRef, useState, type FormEvent } from "react";
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
  type ConnectorCredential,
  type ConversationMessage,
  type PrivateDraftView,
  type ProjectSummary,
  type TelaegentWebUser,
} from "./api";
import "./product-app.css";

type Theme = "light" | "dark";
type ProductRoute = "onboarding" | "projects" | "connections" | "settings" | "workspace";
type OnboardingStep = "identity" | "github" | "agent" | "ready";
type GithubStage = "idle" | "issuing" | "connector" | "connected" | "error";
type WorkspaceTab = "chat" | "people" | "settings";
type MessageLoadState = "unconfigured" | "loading" | "ready" | "error";

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

const conversationConfig = {
  conversationId: import.meta.env.VITE_TELAEGENT_CONVERSATION_ID?.trim() ?? "",
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryIdPattern = /^[1-9][0-9]*$/;

function conversationConfigurationError(githubRepositoryId: string): string | null {
  if (
    !uuidPattern.test(conversationConfig.conversationId) ||
    /^0{8}-0{4}-[1-5]0{3}-[89ab]0{3}-0{12}$/i.test(conversationConfig.conversationId)
  ) {
    return "No real conversation is available yet. The backend still needs participant-scoped conversation discovery.";
  }
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

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError("Unexpected conversation error", 500, null, true);
}

function apiErrorGuidance(error: ApiError): string {
  if (error.status === 404) {
    return "The canonical conversation API is not enabled on this server deployment.";
  }
  if (error.status === 401) return "Sign in again before opening this conversation.";
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

const configuredConversationPeer: Collaborator = {
  id: "configured-conversation",
  initial: "P",
  name: "Project collaborator",
  topic: "Approved project conversation",
  provider: "Local agent",
  branch: "Repository scoped",
  status: "connected",
};

function repositoryParts(fullName: string): { owner: string; name: string } {
  const separator = fullName.indexOf("/");
  return separator > 0
    ? { owner: fullName.slice(0, separator), name: fullName.slice(separator + 1) }
    : { owner: "GitHub", name: fullName };
}

function projectAvailability(project: ProjectSummary): string {
  if (project.projectStatus !== "active" || project.membershipStatus !== "active") {
    return "Unavailable";
  }
  if (project.repositoryAccessStatus !== "verified") return "Needs verification";
  if (project.binding.status !== "ready") return "Connector offline";
  return "Open";
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
  const [step, setStep] = useState<OnboardingStep>("identity");
  const [githubStage, setGithubStage] = useState<GithubStage>("idle");
  const [connectorCredential, setConnectorCredential] = useState<ConnectorCredential | null>(null);
  const [connectorError, setConnectorError] = useState<ApiError | null>(null);
  const [checkingConnector, setCheckingConnector] = useState(false);
  const [connectedAgents, setConnectedAgents] = useState<string[]>([]);
  const [connectorSourcePath, setConnectorSourcePath] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const steps: OnboardingStep[] = ["identity", "github", "agent", "ready"];
  const stepIndex = steps.indexOf(step);

  function toggleAgent(agent: string) {
    setConnectedAgents((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    );
  }

  async function createConnectorCredential() {
    const connectorInstanceId = crypto.randomUUID().replaceAll("-", "");
    setGithubStage("issuing");
    setConnectorError(null);
    try {
      const result = await api.issueConnectorCredential(connectorInstanceId);
      setConnectorCredential(result.connector);
      setGithubStage("connector");
    } catch (error) {
      setConnectorError(normalizeApiError(error));
      setGithubStage("error");
    }
  }

  function connectorCommand(credential: ConnectorCredential): string {
    const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const source = connectorSourcePath.trim() || "<Telaegent source folder>";
    const workspace = repositoryPath.trim() || "<repository folder>";
    return [
      `Set-Location -LiteralPath ${quotePowerShell(source)}`,
      `$env:TELAEGENT_URL='${window.location.origin}'`,
      `$env:TELAEGENT_CONNECTOR_INSTANCE_ID='${credential.connectorInstanceId}'`,
      `$env:TELAEGENT_CONNECTOR_CREDENTIAL='${credential.credential}'`,
      `npm.cmd run connector:connect -- connect ${quotePowerShell(workspace)}`,
    ].join("; ");
  }

  async function copyConnectorCommand() {
    if (connectorCredential && connectorSourcePath.trim() && repositoryPath.trim()) {
      await navigator.clipboard.writeText(connectorCommand(connectorCredential));
    }
  }

  async function verifyConnectorSetup() {
    if (!connectorCredential || checkingConnector) return;
    setCheckingConnector(true);
    setConnectorError(null);
    try {
      const { connector } = await api.connectorSetupStatus(
        connectorCredential.connectorInstanceId,
      );
      if (connector.credential?.status !== "active") {
        throw new ApiError(
          "The connector credential is no longer active. Create a new one and retry.",
          409,
          "CONNECTOR_CREDENTIAL_INACTIVE",
        );
      }
      const verifiedBinding = connector.bindings.some(
        (binding) =>
          binding.bindingStatus === "ready" &&
          binding.membershipStatus === "active" &&
          binding.repositoryAccessStatus === "verified",
      );
      if (!verifiedBinding) {
        throw new ApiError(
          "The connector has not finished verifying this repository yet. Keep it running and check again.",
          409,
          "CONNECTOR_NOT_READY",
          true,
        );
      }
      // Remove the one-time bearer from React state as soon as onboarding no
      // longer needs to render or copy it.
      setConnectorCredential(null);
      setGithubStage("connected");
    } catch (error) {
      const normalized = normalizeApiError(error);
      setConnectorError(normalized);
      if (normalized.code === "CONNECTOR_CREDENTIAL_INACTIVE") {
        setConnectorCredential(null);
        setGithubStage("error");
      }
    } finally {
      setCheckingConnector(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <header className="onboarding-topbar">
        <button className="app-wordmark" type="button" onClick={onExit} aria-label="Back to landing">
          <img src={theme === "dark" ? telaegentLogoBright : telaegentLogo} alt="Telaegent" />
        </button>
        <button className="app-text-button" type="button" onClick={onToggleTheme}>
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
          {step === "identity" && (
            <>
              <span className="app-eyebrow">Your Telaegent account</span>
              <h1>Start with your developer identity.</h1>
              <p>
                Sign in to Telaegent first. Repository access and collaborator permissions stay
                separate, so you always know what you are granting.
              </p>
              <button className="app-primary-action" type="button" onClick={() => setStep("github")}>
                Continue setup
              </button>
              <small>{user ? `Signed in as @${user.githubLogin}` : "Local demo account"} · no personal agent history is imported</small>
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
                  <button type="button" onClick={() => void createConnectorCredential()}>Connect</button>
                </div>
              )}

              {githubStage === "issuing" && (
                <div className="setup-row">
                  <div>
                    <strong>Preparing a connector credential</strong>
                    <small>Bound to this Telaegent account and installation only</small>
                  </div>
                  <TypingDots label="Preparing connector credential" />
                </div>
              )}

              {githubStage === "connector" && connectorCredential && (
                <div className="device-flow">
                  <div>
                    <span>Configure local paths</span>
                    <strong>Connect this installation</strong>
                  </div>
                  <div>
                    <span>What remains local</span>
                    <code>repo · gh · Claude/Codex · sessions</code>
                  </div>
                  <p>Run the command, then continue once the terminal confirms the connector is connected.</p>
                  <div className="connector-path-fields">
                    <label>
                      <span>Telaegent source folder</span>
                      <input
                        type="text"
                        value={connectorSourcePath}
                        onChange={(event) => setConnectorSourcePath(event.target.value)}
                        placeholder="D:\\Projects\\telaegent\\telaegent-tiktok-techjam"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <span>Repository to connect</span>
                      <input
                        type="text"
                        value={repositoryPath}
                        onChange={(event) => setRepositoryPath(event.target.value)}
                        placeholder="D:\\Projects\\Testing\\my-repository"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                  </div>
                  <div className="connector-command-block">
                    <code className="connector-command">{connectorCommand(connectorCredential)}</code>
                    <p>The command changes to the Telaegent source folder before launching the connector and passes the separate repository folder as its workspace. Neither path is uploaded. The credential expires {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(connectorCredential.expiresAt))}.</p>
                  </div>
                  <div className="inline-actions">
                    <button
                      className="app-secondary-action"
                      type="button"
                      disabled={!connectorSourcePath.trim() || !repositoryPath.trim()}
                      onClick={() => void copyConnectorCommand()}
                    >
                      Copy command
                    </button>
                    <button
                      className="app-primary-action"
                      type="button"
                      disabled={checkingConnector}
                      onClick={() => void verifyConnectorSetup()}
                    >
                      {checkingConnector ? "Checking…" : "Check connection"}
                    </button>
                  </div>
                  {connectorError && (
                    <div className="api-state error" role="alert">
                      <strong>{connectorError.code ?? "Connector not ready"}</strong>
                      <p>{connectorError.message}</p>
                    </div>
                  )}
                </div>
              )}

              {githubStage === "error" && connectorError && (
                <div className="api-state error" role="alert">
                  <strong>{connectorError.code ?? "Connector setup unavailable"}</strong>
                  <p>{apiErrorGuidance(connectorError)}</p>
                  <button className="app-secondary-action" type="button" onClick={() => void createConnectorCredential()}>Try again</button>
                </div>
              )}

              {githubStage === "connected" && (
                <div className="setup-row connected">
                  <div>
                    <strong><StatusMark /> Repository connector verified</strong>
                    <small>The backend confirmed an active membership, repository proof, and opaque local binding.</small>
                  </div>
                  <button type="button" onClick={() => setStep("agent")}>Continue</button>
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
                    <button className={connected ? "connected" : ""} type="button" key={agent} onClick={() => toggleAgent(agent)}>
                      <span>
                        <strong>{agent}</strong>
                        <small>{connected ? "Selected for this project" : "Choose provider"}</small>
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
                Repositories set the boundary for conversations, agent context, collaborators,
                and approvals.
              </p>
              <div className="ready-summary">
                <span><StatusMark /> Repository connector registered</span>
                <span><StatusMark /> GitHub repository proof active</span>
                <span><StatusMark /> {connectedAgents.join(" + ")} selected for this project</span>
              </div>
              <button className="app-primary-action" type="button" onClick={onComplete}>
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
          className={route === item.route || (item.route === "projects" && route === "workspace") ? "selected" : ""}
          type="button"
          key={item.route}
          onClick={() => onNavigate(item.route)}
        >
          <img src={item.icon} alt="" aria-hidden="true" />
          <strong>{item.label}</strong>
          {item.route === "connections" && <i>1</i>}
        </button>
      ))}
    </nav>
  );
}

function ProjectsScreen({
  onOpenProject,
  projects,
  loading,
  error,
  onRetry,
}: {
  onOpenProject: (project: ProjectSummary) => void;
  projects: ProjectSummary[];
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
}) {
  return (
    <div className="app-page projects-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Connected through GitHub</span>
        <h1>Your projects</h1>
        <p>Choose a repository. Everything inside stays scoped to that project.</p>
      </header>

      <div className="projects-layout">
        <section className="project-list" aria-label="Connected repositories">
          {loading && (
            <div className="api-state"><TypingDots label="Loading projects" /><p>Loading repositories verified by your connector.</p></div>
          )}
          {!loading && error && (
            <div className="api-state error" role="alert">
              <strong>{error.code ?? "Project discovery unavailable"}</strong>
              <p>{apiErrorGuidance(error)}</p>
              {error.retryable && <button type="button" onClick={onRetry}>Retry</button>}
            </div>
          )}
          {!loading && !error && projects.length === 0 && (
            <div className="api-state">
              <strong>No verified repositories yet</strong>
              <p>Run the local connector from a GitHub repository, then refresh this page.</p>
            </div>
          )}
          {projects.map((project, index) => {
            const repository = repositoryParts(project.repositoryFullName);
            const availability = projectAvailability(project);
            const available = availability === "Open";
            return (
            <button type="button" key={project.projectId} disabled={!available} onClick={() => onOpenProject(project)}>
              <span className="repo-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <span className="repo-title">
                <small>{repository.owner}</small>
                <strong>{repository.name}</strong>
                <p>{project.visibility} repository · default branch {project.defaultBranch}</p>
              </span>
              <span className="repo-meta">
                <small>{project.connectedCollaboratorCount} connected collaborator{project.connectedCollaboratorCount === 1 ? "" : "s"}</small>
                <strong>{project.binding.currentBranch ?? project.defaultBranch}</strong>
                <small>{project.binding.lastSeenAt ? "Connector seen recently" : "Awaiting connector presence"}</small>
              </span>
              <span className="repo-open">{availability}</span>
            </button>
          )})}
        </section>

        <aside className="connection-request-card">
          <span className="app-eyebrow">Project trust</span>
          <h2>Connections stay repository-scoped.</h2>
          <p>Only repositories independently proven by your local GitHub CLI appear here.</p>
          <div className="permission-copy">
            <span><StatusMark /> Approved messages are durable</span>
            <span><StatusMark tone="quiet" /> Local paths and credentials stay local</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function LiveConnectionsScreen() {
  return (
    <div className="app-page compact-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Project relationships</span>
        <h1>Connections</h1>
        <p>A connection belongs to one repository and can be revoked at any time.</p>
      </header>
      <section className="settings-section api-state">
        <strong>Connection management is not available yet</strong>
        <p>The backend still needs owner-approved request, accept, decline, list, and revoke routes before this screen can safely change project trust.</p>
      </section>
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
        <header><h2>Local execution</h2></header>
        <p className="empty-line">Provider availability is proven by the local connector. Durable per-provider status is not exposed by the backend yet.</p>
      </section>
      <section className="settings-section">
        <header><h2>Repositories</h2></header>
        {projects.length === 0 && <p className="empty-line">No verified repositories.</p>}
        {projects.map((project) => (
          <article className="tool-row" key={project.projectId}>
            <div><strong>{project.repositoryFullName}</strong><small>Registered by local connector · {project.binding.status}</small></div>
            <span className="connection-state"><StatusMark tone={project.binding.status === "ready" ? "ok" : "warn"} /> {project.binding.status}</span>
          </article>
        ))}
      </section>
    </div>
  );
}

function WorkspaceSidebar({
  project,
  selectedId,
  onSelect,
  tab,
  onTabChange,
  onBack,
}: {
  project: ProjectSummary;
  selectedId: string;
  onSelect: (id: string) => void;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onBack: () => void;
}) {
  return (
    <aside className="workspace-sidebar">
      <button className="workspace-back" type="button" onClick={onBack}>← All projects</button>
      <div className="workspace-repository">
        <span>Repository</span>
        <strong>{project.repositoryFullName}</strong>
        <small>{project.binding.currentBranch ?? project.defaultBranch} · {project.binding.commitSha?.slice(0, 7) ?? "commit unavailable"}</small>
      </div>
      <div className="workspace-tabs">
        <button className={tab === "chat" ? "selected" : ""} type="button" onClick={() => onTabChange("chat")}>Conversation</button>
        <button className={tab === "people" ? "selected" : ""} type="button" onClick={() => onTabChange("people")}>Collaborators</button>
        <button className={tab === "settings" ? "selected" : ""} type="button" onClick={() => onTabChange("settings")}>Project settings</button>
      </div>
      {tab === "chat" && (
        <div className="workspace-conversations">
          <span>Conversation</span>
          {[configuredConversationPeer].map((person) => (
            <button className={selectedId === person.id ? "selected" : ""} type="button" key={person.id} onClick={() => onSelect(person.id)}>
              <span className="app-avatar">{person.initial}</span>
              <span><strong>{person.name}</strong><small>{person.topic}</small></span>
            </button>
          ))}
        </div>
      )}
      <div className="workspace-agent">
        <span><StatusMark tone={project.binding.status === "ready" ? "ok" : "warn"} /> Connector {project.binding.status}</span>
        <small>Scoped only to this repository</small>
      </div>
    </aside>
  );
}

function mapConversationMessage(
  message: ConversationMessage,
  currentUserId: string | null,
  forceOutgoing = false,
): SharedMessage {
  const outgoing = forceOutgoing ||
    (!!currentUserId && message.senderUserId === currentUserId);
  return {
    id: message.messageId,
    side: outgoing ? "outgoing" : "incoming",
    author: outgoing ? "You" : "Project member",
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
  const showPrivateMessage = !!draft?.privateMessage &&
    !(lastTurn?.speaker === "agent" && lastTurn.text === draft.privateMessage);

  return (
    <aside className={`workspace-private-room${open ? " open" : ""}`} aria-hidden={!open}>
      <header>
        <div>
          <strong>{state === "ready" ? (answering ? "Reply Approval" : "Message Approval") : (answering ? "Reply Preparation" : "Message Preparation")}</strong>
          <small>Private with {draft ? formatProvider(draft.provider) : "your agent"}. Not visible to {recipient.name}.</small>
        </div>
        <button type="button" onClick={onNo} disabled={busy}>No</button>
      </header>

      <div className="private-scope-bar">
        <span>{draft?.githubRepositoryId ?? "repository not configured"}</span>
        <span>{draft?.draftId ? `draft ${draft.draftId.slice(0, 8)}` : "private draft"}</span>
      </div>

      <div className="workspace-private-thread" aria-live="polite">
        {answering && (
          <article className="private-bubble answering">
            <span>{recipient.name} · approved message</span>
            <p>{answering.body}</p>
          </article>
        )}

        {draft?.roughMessage && (
          <article className="private-bubble user"><span>You</span><p>{draft.roughMessage}</p></article>
        )}

        {draft?.privateTurns.map((turn, index) => (
          <article className={`private-bubble ${turn.speaker === "owner" ? "user" : "agent"}`} key={`${turn.speaker}-${index}`}>
            <span>{turn.speaker === "owner" ? "You" : formatProvider(draft.provider)}</span>
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
            <span>{state === "created" ? "Starting the private turn" : "Your agent is preparing the message"}</span>
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
            <button type="submit" disabled={busy || !clarification.trim()}>Continue</button>
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
                onChange={(event) => onApprovedContentChange(event.target.value)}
              />
            ) : (
              <blockquote>{approvedContent || draft?.sendCandidate}</blockquote>
            )}
          </article>
        )}

        {state === "blocked" && (
          <div className="private-runtime-error">
            <strong>This message cannot be sent.</strong>
            <p>{draft?.privateMessage || "Telaegent blocked content that cannot cross the project trust boundary."}</p>
            {!!draft?.guardFindings.length && (
              <ul>{draft.guardFindings.map((finding) => <li key={finding.code}>{finding.safeReason}</li>)}</ul>
            )}
          </div>
        )}

        {state === "runtime_failed" && (
          <div className="private-runtime-error">
            <strong>{draft?.failure?.code || "The private agent turn stopped"}</strong>
            <p>{draft?.failure?.message || draft?.privateMessage || "No shared message was created."}</p>
            {draft && <small>{draftFailureGuidance(draft)}</small>}
          </div>
        )}

        {error && (
          <div className="api-state error" role="alert">
            <strong>{error.code || `Request failed (${error.status || "offline"})`}</strong>
            <p>{apiErrorGuidance(error)}</p>
            {!!error.findings.length && (
              <ul>{error.findings.map((finding) => <li key={finding.code}>{finding.safeReason}</li>)}</ul>
            )}
          </div>
        )}
      </div>

      <footer className="private-approval-bar">
        <span>{state === "ready" ? "Only Send crosses the trust boundary." : "This work remains private until a message is approved."}</span>
        <div>
          {state === "ready" && <button type="button" onClick={onEdit} disabled={busy}>Edit</button>}
          <button type="button" onClick={onNo} disabled={busy}>No</button>
          {state === "ready" && (
            <button className="send" type="button" onClick={onSend} disabled={busy || !approvedContent.trim()}>Send</button>
          )}
          {(state === "runtime_failed" || (state === "created" && !!error)) &&
            (state !== "runtime_failed" ? error?.retryable !== false : draft?.failure?.retryable !== false) && (
            <button className="send" type="button" onClick={onRetry} disabled={busy}>Retry</button>
          )}
        </div>
      </footer>
    </aside>
  );
}

function ProjectChat({
  project,
  selectedId,
  currentUserId,
}: {
  project: ProjectSummary;
  selectedId: string;
  currentUserId: string | null;
}) {
  const selected = selectedId === configuredConversationPeer.id
    ? configuredConversationPeer
    : configuredConversationPeer;
  const [composer, setComposer] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [roughMessage, setRoughMessage] = useState("");
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [messageLoadState, setMessageLoadState] = useState<MessageLoadState>("loading");
  const [messageError, setMessageError] = useState<ApiError | null>(null);
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
  const configurationError = conversationConfigurationError(project.githubRepositoryId);
  const isBoundConversation = selected.id === configuredConversationPeer.id;

  async function loadMessages() {
    if (configurationError || !isBoundConversation) {
      setMessages([]);
      setMessageLoadState("unconfigured");
      return;
    }
    setMessageLoadState("loading");
    setMessageError(null);
    try {
      const result = await api.conversationMessages(
        conversationConfig.conversationId,
        project.githubRepositoryId,
      );
      setMessages(result.messages.map((message) =>
        mapConversationMessage(message, currentUserId, ownMessageIds.current.has(message.messageId)),
      ));
      setMessageLoadState("ready");
    } catch (error) {
      setMessageError(normalizeApiError(error));
      setMessageLoadState("error");
    }
  }

  useEffect(() => {
    let active = true;
    setPrivateRoomOpen(false);
    setDraft(null);
    setAnswering(null);
    setActionError(null);
    if (configurationError || !isBoundConversation) {
      setMessages([]);
      setMessageLoadState("unconfigured");
      return () => { active = false; };
    }
    setMessageLoadState("loading");
    setMessageError(null);
    void api.conversationMessages(
      conversationConfig.conversationId,
      project.githubRepositoryId,
    ).then((result) => {
      if (!active) return;
      setMessages(result.messages.map((message) =>
        mapConversationMessage(message, currentUserId, ownMessageIds.current.has(message.messageId)),
      ));
      setMessageLoadState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setMessageError(normalizeApiError(error));
      setMessageLoadState("error");
    });
    return () => { active = false; };
  }, [selectedId, configurationError, isBoundConversation, currentUserId, project.githubRepositoryId]);

  useEffect(() => {
    if (configurationError || !isBoundConversation || messageLoadState !== "ready") return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.conversationMessages(
        conversationConfig.conversationId,
        project.githubRepositoryId,
      ).then((result) => {
        if (!active) return;
        setMessages(result.messages.map((message) =>
          mapConversationMessage(message, currentUserId, ownMessageIds.current.has(message.messageId)),
        ));
      }).catch(() => {
        // Keep the last approved snapshot. An explicit load exposes connection errors.
      });
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [configurationError, isBoundConversation, messageLoadState, project.githubRepositoryId]);

  useEffect(() => {
    if (!privateRoomOpen || draft?.state !== "agent_working") return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.conversationDraft(draft.draftId).then(({ draft: nextDraft }) => {
        if (!active) return;
        setDraft(nextDraft);
        setActionError(null);
        if (nextDraft.state === "ready") {
          setApprovedContent(nextDraft.sendCandidate ?? "");
          setEditingCandidate(false);
        }
      }).catch((error: unknown) => {
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
    setBusy(true);
    setDraft(null);
    setActionError(null);
    try {
      const created = await api.createConversationDraft(conversationConfig.conversationId, {
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
  async function createAndRunReply(message: SharedMessage) {
    setBusy(true);
    setDraft(null);
    setActionError(null);
    setAnswering(message);
    setRoughMessage("");
    setClarification("");
    setApprovedContent("");
    setEditingCandidate(false);
    try {
      const created = await api.createConversationReply(conversationConfig.conversationId, {
        githubRepositoryId: project.githubRepositoryId,
        provider,
        incomingMessageId: message.id,
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
    if (!nextMessage || configurationError || !isBoundConversation) return;
    setRoughMessage(nextMessage);
    setAnswering(null);
    setClarification("");
    setApprovedContent("");
    setEditingCandidate(false);
    void createAndRunDraft(nextMessage);
  }

  async function clarifyDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !clarification.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      const clarified = await api.clarifyConversationDraft(draft.draftId, clarification.trim());
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
      setMessages((current) => [...current, mapConversationMessage(result.message, currentUserId, true)]);
      setMessageLoadState("ready");
      setPrivateRoomOpen(false);
      setDraft(null);
      setAnswering(null);
      setComposer("");
      await loadMessages();
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
      await createAndRunReply(answering);
      return;
    }
    if (roughMessage) await createAndRunDraft(roughMessage);
  }

  return (
    <section className={`project-chat${privateRoomOpen ? " private-open" : ""}`}>
      <header className="project-chat-header">
        <div>
          <span className="app-avatar">{selected.initial}</span>
          <span><strong>{selected.name}</strong><small>Approved project conversation</small></span>
        </div>
        <div className="chat-header-meta"><span>{formatProvider(provider)} ↔ {selected.provider}</span></div>
      </header>

      <div className="chat-project-strip">
        <span><StatusMark tone={messageLoadState === "error" ? "warn" : "ok"} /> {project.repositoryFullName}</span>
        <small>Repository ID {project.githubRepositoryId}</small>
      </div>

      <div className="shared-thread" aria-live="polite">
        {messageLoadState === "loading" && (
          <div className="turn-status"><TypingDots label="Loading approved messages" /><span>Loading approved messages</span></div>
        )}
        {messageLoadState === "unconfigured" && (
          <div className="api-state">
            <strong>{isBoundConversation ? "Connect this workspace to a conversation" : "No conversation is bound to this collaborator"}</strong>
            <p>{isBoundConversation ? configurationError : "The backend does not yet provide conversation discovery, so this screen can only open the configured conversation."}</p>
          </div>
        )}
        {messageLoadState === "error" && messageError && (
          <div className="api-state error" role="alert">
            <strong>{messageError.code || `Conversation unavailable (${messageError.status || "offline"})`}</strong>
            <p>{apiErrorGuidance(messageError)}</p>
            {messageError.retryable && <button type="button" onClick={() => void loadMessages()}>Retry</button>}
          </div>
        )}
        {messageLoadState === "ready" && messages.length === 0 && (
          <div className="empty-conversation">
            <span className="app-avatar">{selected.initial}</span>
            <h2>Start a project conversation with {selected.name}.</h2>
            <p>Your rough message goes to your agent privately before {selected.name} can see it.</p>
          </div>
        )}
        {messages.map((message) => (
          <article className={`shared-message ${message.side}`} key={message.id}>
            <span>{message.author} · {message.provider}</span>
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
        <label htmlFor="project-message">Ask your agent to prepare a message</label>
        <label className="composer-provider-picker">
          <span>Local provider</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value as AgentProvider)} disabled={busy}>
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
            placeholder={`Ask ${selected.name} about this project…`}
            disabled={!!configurationError || !isBoundConversation}
          />
          <button type="submit" disabled={busy || !composer.trim() || !!configurationError || !isBoundConversation}>Prepare privately</button>
        </div>
        <small>Enter prepares a private draft. Only Send shares the approved result with {selected.name}.</small>
      </form>

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
    </section>
  );
}

function ProjectPeople({ project }: { project: ProjectSummary }) {
  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <span className="app-eyebrow">{project.repositoryFullName}</span>
        <h1>Project collaborators</h1>
        <p>A connection allows project-scoped messages. It never grants direct repository access.</p>
      </header>
      <div className="collaborator-list api-state">
        <strong>{project.connectedCollaboratorCount} connected collaborator{project.connectedCollaboratorCount === 1 ? "" : "s"}</strong>
        <p>Participant identities and connection actions are not exposed by the backend yet.</p>
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
        <header><h2>Project agent</h2></header>
        <p className="empty-line">Choose a provider when preparing a message. Persistent project defaults need a backend-owned provider preference contract.</p>
      </section>
      <section className="settings-section">
        <header><h2>Active connections</h2></header>
        <p className="empty-line">Connection identities and revocation controls require the pending backend connection-management contract.</p>
      </section>
      <section className="settings-section danger-zone">
        <header><h2>Repository connection</h2></header>
        <article className="tool-row">
          <div><strong>Disconnect {project.repositoryFullName}</strong><small>Credential revocation exists, but project-scoped disconnect is not exposed to the browser yet.</small></div>
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
  const [selectedId, setSelectedId] = useState(configuredConversationPeer.id);

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar
        project={project}
        selectedId={selectedId}
        onSelect={setSelectedId}
        tab={tab}
        onTabChange={setTab}
        onBack={onBack}
      />
      <div className="workspace-mobile-tabs">
        <button type="button" onClick={onBack}>Projects</button>
        {(["chat", "people", "settings"] as WorkspaceTab[]).map((item) => (
          <button className={tab === item ? "selected" : ""} type="button" key={item} onClick={() => setTab(item)}>{item}</button>
        ))}
      </div>
      {tab === "chat" && <ProjectChat project={project} selectedId={selectedId} currentUserId={currentUserId} />}
      {tab === "people" && <ProjectPeople project={project} />}
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
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onExit: () => void;
  user: TelaegentWebUser | null;
  onLogout: () => void | Promise<void>;
}) {
  const [route, setRoute] = useState<ProductRoute>("onboarding");
  const [discoveredProjects, setDiscoveredProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<ApiError | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);

  async function loadProjects() {
    if (!user || projectsLoading) return;
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const result = await api.projects({ limit: 50 });
      setDiscoveredProjects(result.projects);
      setSelectedProject((current) =>
        current
          ? result.projects.find((project) => project.projectId === current.projectId) ?? null
          : null,
      );
    } catch (error) {
      setProjectsError(normalizeApiError(error));
    } finally {
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

  function openProject(project: ProjectSummary) {
    setSelectedProject(project);
    setRoute("workspace");
  }

  if (route === "onboarding") {
    return (
      <Onboarding
        theme={theme}
        onToggleTheme={onToggleTheme}
        onExit={onExit}
        user={user}
        onComplete={() => setRoute("projects")}
      />
    );
  }

  return (
    <div className="product-app-shell">
      <header className="app-topbar">
        <button className="app-wordmark" type="button" onClick={onExit} aria-label="Back to Telaegent landing">
          <img src={theme === "dark" ? telaegentLogoBright : telaegentLogo} alt="Telaegent" />
        </button>
        <div className="app-topbar-context">
          {route === "workspace" && selectedProject
            ? <><span>Project</span><strong>{selectedProject.repositoryFullName}</strong></>
            : <strong>Telaegent cloud</strong>}
        </div>
        <div className="app-topbar-actions">
          <button className="app-text-button" type="button" onClick={onToggleTheme}>{theme === "dark" ? "Light" : "Dark"}</button>
          <button className="account-button" type="button" onClick={() => void onLogout()} title="Sign out">
            <span>{(user?.githubLogin ?? "Demo").slice(0, 2).toUpperCase()}</span>
            <strong>{user?.githubLogin ?? "Demo"}</strong>
          </button>
        </div>
      </header>
      <div className="app-body">
        <ProductNav route={route} onNavigate={setRoute} />
        <main className="app-content">
          {route === "projects" && (
            <ProjectsScreen
              onOpenProject={openProject}
              projects={discoveredProjects}
              loading={projectsLoading}
              error={projectsError}
              onRetry={() => void loadProjects()}
            />
          )}
          {route === "connections" && <LiveConnectionsScreen />}
          {route === "settings" && <LiveToolsSettings projects={discoveredProjects} />}
          {route === "workspace" && selectedProject && (
            <Workspace project={selectedProject} onBack={() => setRoute("projects")} currentUserId={user?.userId ?? null} />
          )}
          {route === "workspace" && !selectedProject && (
            <div className="app-page api-state">
              <strong>Select a verified project first</strong>
              <button type="button" onClick={() => setRoute("projects")}>Back to projects</button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
