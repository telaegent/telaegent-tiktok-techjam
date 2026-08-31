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
  type ConnectorCredential,
  type ConversationMessage,
  type PrivateDraftView,
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
  githubRepositoryId:
    import.meta.env.VITE_TELAEGENT_GITHUB_REPOSITORY_ID?.trim() ?? "",
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryIdPattern = /^[1-9][0-9]*$/;

function conversationConfigurationError(): string | null {
  if (!uuidPattern.test(conversationConfig.conversationId)) {
    return "Set VITE_TELAEGENT_CONVERSATION_ID to a conversation UUID.";
  }
  if (!repositoryIdPattern.test(conversationConfig.githubRepositoryId)) {
    return "Set VITE_TELAEGENT_GITHUB_REPOSITORY_ID to the stable numeric GitHub repository ID.";
  }
  return null;
}

function formatProvider(provider: ConversationMessage["provider"]): string {
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

const collaborators: Collaborator[] = [
  {
    id: "justin",
    initial: "J",
    name: "Justin",
    topic: "Auth and environment",
    provider: "Claude Code",
    branch: "feat/auth-service",
    status: "connected",
  },
  {
    id: "khoa",
    initial: "K",
    name: "Khoa",
    topic: "Backend API contract",
    provider: "Codex",
    branch: "feat/api-contract",
    status: "connected",
  },
  {
    id: "thai",
    initial: "T",
    name: "Thai",
    topic: "Cloud relay and connector networking",
    provider: "Claude Code",
    branch: "infra/connector-relay",
    status: "available",
  },
  {
    id: "hien",
    initial: "H",
    name: "Hien",
    topic: "Agent protocol",
    provider: "Codex",
    branch: "research/agent-protocol",
    status: "pending",
  },
];

const projects = [
  {
    id: "telaegent",
    owner: "telaegent",
    name: "telaegent-tiktok-techjam",
    description: "Project-scoped collaboration between independently owned coding agents.",
    collaborators: 4,
    provider: "Codex",
    updated: "Active now",
  },
  {
    id: "duelook",
    owner: "phuong-labs",
    name: "DueLook",
    description: "Deadline and milestone tracking for small product teams.",
    collaborators: 1,
    provider: "Claude Code",
    updated: "Yesterday",
  },
  {
    id: "secret",
    owner: "phuong-labs",
    name: "secret",
    description: "Private experiments and configuration research.",
    collaborators: 0,
    provider: "Codex",
    updated: "6 days ago",
  },
];

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
  const [connectedAgents, setConnectedAgents] = useState<string[]>([]);
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
    return [
      `$env:TELAEGENT_URL='${window.location.origin}'`,
      `$env:TELAEGENT_CONNECTOR_INSTANCE_ID='${credential.connectorInstanceId}'`,
      `$env:TELAEGENT_CONNECTOR_CREDENTIAL='${credential.credential}'`,
      "npm run connector:connect -w @launchpad/server -- connect .",
    ].join("; ");
  }

  async function copyConnectorCommand() {
    if (connectorCredential) {
      await navigator.clipboard.writeText(connectorCommand(connectorCredential));
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
                    <span>Run locally in your repository</span>
                    <strong>Connect this installation</strong>
                  </div>
                  <div>
                    <span>What remains local</span>
                    <code>repo · gh · Claude/Codex · sessions</code>
                  </div>
                  <p>Run the command, then continue once the terminal confirms the connector is connected.</p>
                  <div className="connector-command-block">
                    <code className="connector-command">{connectorCommand(connectorCredential)}</code>
                    <p>Paste this once in PowerShell at the repository root. It verifies your local GitHub CLI and starts the outbound connector. The credential expires {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(connectorCredential.expiresAt))}.</p>
                  </div>
                  <div className="inline-actions">
                    <button className="app-secondary-action" type="button" onClick={() => void copyConnectorCommand()}>Copy command</button>
                    <button className="app-primary-action" type="button" onClick={() => setGithubStage("connected")}>
                      I&apos;ve connected it
                    </button>
                  </div>
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
                    <strong><StatusMark /> Connector command completed</strong>
                    <small>Your local connector verified this repository. Continue to select its agent.</small>
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
                The connector probes your local Claude Code, Codex, or both.
                Provider login and project sessions stay local; unrelated conversations are never imported.
              </p>
              <div className="provider-picker">
                {["Claude Code", "Codex"].map((agent) => {
                  const connected = connectedAgents.includes(agent);
                  return (
                    <button className={connected ? "connected" : ""} type="button" key={agent} onClick={() => toggleAgent(agent)}>
                      <span>
                        <strong>{agent}</strong>
                        <small>{connected ? "Connected locally" : "Detected locally"}</small>
                      </span>
                      <span>{connected ? "Connected" : "Connect"}</span>
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
                <span><StatusMark /> Local connector online</span>
                <span><StatusMark /> GitHub repository verified locally</span>
                <span><StatusMark /> {connectedAgents.join(" + ")} connected locally</span>
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
  requestAccepted,
  onAcceptRequest,
}: {
  onOpenProject: () => void;
  requestAccepted: boolean;
  onAcceptRequest: () => void;
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
          {projects.map((project, index) => (
            <button type="button" key={project.id} disabled={index !== 0} onClick={onOpenProject}>
              <span className="repo-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <span className="repo-title">
                <small>{project.owner}</small>
                <strong>{project.name}</strong>
                <p>{project.description}</p>
              </span>
              <span className="repo-meta">
                <small>{project.collaborators} collaborators</small>
                <strong>{project.provider}</strong>
                <small>{project.updated}</small>
              </span>
              <span className="repo-open">{index === 0 ? "Open" : "No conversations"}</span>
            </button>
          ))}
        </section>

        <aside className={`connection-request-card${requestAccepted ? " accepted" : ""}`}>
          <span className="app-eyebrow">Connection request</span>
          {requestAccepted ? (
            <>
              <h2>Linh is connected.</h2>
              <p>You can now exchange approved messages inside phuong-labs/DueLook.</p>
              <div className="ready-summary"><span><StatusMark /> Project-scoped connection active</span></div>
            </>
          ) : (
            <>
              <h2>Linh wants to connect agents.</h2>
              <p className="request-project">phuong-labs/DueLook</p>
              <div className="permission-copy">
                <strong>This allows</strong>
                <span><StatusMark /> Project-scoped messages</span>
                <span><StatusMark /> Agent-assisted questions</span>
                <strong>This does not allow</strong>
                <span><StatusMark tone="quiet" /> Direct repository access</span>
                <span><StatusMark tone="quiet" /> Unapproved messages from your side</span>
              </div>
              <div className="inline-actions">
                <button className="app-secondary-action" type="button">Decline</button>
                <button className="app-primary-action" type="button" onClick={onAcceptRequest}>Accept connection</button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function ConnectionsScreen({ requestAccepted, onAcceptRequest }: { requestAccepted: boolean; onAcceptRequest: () => void }) {
  return (
    <div className="app-page compact-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Project relationships</span>
        <h1>Connections</h1>
        <p>A connection belongs to one repository and can be revoked at any time.</p>
      </header>

      <section className="settings-section">
        <header><h2>Incoming</h2><span>{requestAccepted ? "0" : "1"}</span></header>
        {!requestAccepted ? (
          <article className="connection-row">
            <span className="app-avatar">L</span>
            <div><strong>Linh</strong><small>phuong-labs/DueLook · project-scoped messaging</small></div>
            <button className="app-secondary-action" type="button">Decline</button>
            <button className="app-primary-action" type="button" onClick={onAcceptRequest}>Accept</button>
          </article>
        ) : (
          <p className="empty-line">No pending requests.</p>
        )}
      </section>

      <section className="settings-section">
        <header><h2>Active</h2><span>2</span></header>
        {collaborators.slice(0, 2).map((person) => (
          <article className="connection-row" key={person.id}>
            <span className="app-avatar">{person.initial}</span>
            <div><strong>{person.name}</strong><small>telaegent/backend · {person.provider}</small></div>
            <span className="connection-state"><StatusMark /> Connected</span>
          </article>
        ))}
      </section>
    </div>
  );
}

function ToolsSettings() {
  const [claudeConnected, setClaudeConnected] = useState(false);

  return (
    <div className="app-page compact-page">
      <header className="app-page-heading">
        <span className="app-eyebrow">Account and connected tools</span>
        <h1>Settings</h1>
        <p>Manage cloud connections and the local tools reported by your connector.</p>
      </header>

      <section className="settings-section">
        <header><h2>Account</h2></header>
        <article className="tool-row">
          <div><strong>Local connector</strong><small>@phuong · telaegent/backend</small></div>
          <span><StatusMark /> Online</span>
        </article>
      </section>

      <section className="settings-section">
        <header><h2>Coding agents</h2></header>
        <article className="tool-row">
          <div><strong>Codex</strong><small>Local default for telaegent/backend</small></div>
          <span><StatusMark /> Connected locally</span>
        </article>
        <article className="tool-row warning">
          <div><strong>Claude Code</strong><small>{claudeConnected ? "Local connection restored" : "Local authentication unavailable · sign in locally"}</small></div>
          {claudeConnected ? (
            <span><StatusMark /> Connected locally</span>
          ) : (
            <button className="app-secondary-action" type="button" onClick={() => setClaudeConnected(true)}>Reconnect</button>
          )}
        </article>
      </section>

      <section className="settings-section">
        <header><h2>Repositories</h2></header>
        {projects.map((project) => (
          <article className="tool-row" key={project.id}>
            <div><strong>{project.owner}/{project.name}</strong><small>Registered by local connector</small></div>
            <button className="app-text-button danger" type="button">Disconnect</button>
          </article>
        ))}
      </section>
    </div>
  );
}

function WorkspaceSidebar({
  selectedId,
  onSelect,
  tab,
  onTabChange,
  onBack,
}: {
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
        <strong>telaegent/backend</strong>
        <small>feat/auth-ui · a184f2c</small>
      </div>
      <div className="workspace-tabs">
        <button className={tab === "chat" ? "selected" : ""} type="button" onClick={() => onTabChange("chat")}>Conversation</button>
        <button className={tab === "people" ? "selected" : ""} type="button" onClick={() => onTabChange("people")}>Collaborators</button>
        <button className={tab === "settings" ? "selected" : ""} type="button" onClick={() => onTabChange("settings")}>Project settings</button>
      </div>
      {tab === "chat" && (
        <div className="workspace-conversations">
          <span>People</span>
          {collaborators.filter((person) => person.status === "connected").map((person) => (
            <button className={selectedId === person.id ? "selected" : ""} type="button" key={person.id} onClick={() => onSelect(person.id)}>
              <span className="app-avatar">{person.initial}</span>
              <span><strong>{person.name}</strong><small>{person.topic}</small></span>
            </button>
          ))}
        </div>
      )}
      <div className="workspace-agent">
        <span><StatusMark /> Your Codex is ready</span>
        <small>Only for this repository</small>
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
          <strong>{state === "ready" ? "Message Approval" : "Message Preparation"}</strong>
          <small>Private with {draft ? formatProvider(draft.provider) : "your agent"}. Not visible to {recipient.name}.</small>
        </div>
        <button type="button" onClick={onNo} disabled={busy}>No</button>
      </header>

      <div className="private-scope-bar">
        <span>{conversationConfig.githubRepositoryId || "repository not configured"}</span>
        <span>{draft?.draftId ? `draft ${draft.draftId.slice(0, 8)}` : "private draft"}</span>
      </div>

      <div className="workspace-private-thread" aria-live="polite">
        {draft && (
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
  selectedId,
  currentUserId,
}: {
  selectedId: string;
  currentUserId: string | null;
}) {
  const selected = collaborators.find((person) => person.id === selectedId) ?? collaborators[0];
  const [composer, setComposer] = useState("");
  const [roughMessage, setRoughMessage] = useState("");
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [messageLoadState, setMessageLoadState] = useState<MessageLoadState>("loading");
  const [messageError, setMessageError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<PrivateDraftView | null>(null);
  const [privateRoomOpen, setPrivateRoomOpen] = useState(false);
  const [clarification, setClarification] = useState("");
  const [approvedContent, setApprovedContent] = useState("");
  const [editingCandidate, setEditingCandidate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const ownMessageIds = useRef(new Set<string>());
  const configurationError = conversationConfigurationError();
  const isBoundConversation = selected.id === "justin";

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
        conversationConfig.githubRepositoryId,
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
      conversationConfig.githubRepositoryId,
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
  }, [selectedId, configurationError, isBoundConversation, currentUserId]);

  useEffect(() => {
    if (configurationError || !isBoundConversation || messageLoadState !== "ready") return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.conversationMessages(
        conversationConfig.conversationId,
        conversationConfig.githubRepositoryId,
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
  }, [configurationError, isBoundConversation, messageLoadState]);

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
        githubRepositoryId: conversationConfig.githubRepositoryId,
        provider: "codex",
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

  function submitRoughMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextMessage = composer.trim();
    if (!nextMessage || configurationError || !isBoundConversation) return;
    setRoughMessage(nextMessage);
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
    if (roughMessage) await createAndRunDraft(roughMessage);
  }

  return (
    <section className={`project-chat${privateRoomOpen ? " private-open" : ""}`}>
      <header className="project-chat-header">
        <div>
          <span className="app-avatar">{selected.initial}</span>
          <span><strong>{selected.name}</strong><small>Approved project conversation</small></span>
        </div>
        <div className="chat-header-meta"><span>Codex ↔ {selected.provider}</span></div>
      </header>

      <div className="chat-project-strip">
        <span><StatusMark tone={messageLoadState === "error" ? "warn" : "ok"} /> telaegent/backend</span>
        <small>Repository ID {conversationConfig.githubRepositoryId || "not configured"}</small>
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
          </article>
        ))}
      </div>

      <form className="shared-composer" onSubmit={submitRoughMessage}>
        <label htmlFor="project-message">Ask your agent to prepare a message</label>
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

function ProjectPeople() {
  const [states, setStates] = useState<Record<string, Collaborator["status"]>>(
    Object.fromEntries(collaborators.map((person) => [person.id, person.status])),
  );

  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <span className="app-eyebrow">telaegent/backend</span>
        <h1>Project collaborators</h1>
        <p>A connection allows project-scoped messages. It never grants direct repository access.</p>
      </header>
      <div className="collaborator-list">
        {collaborators.map((person) => {
          const state = states[person.id];
          return (
            <article key={person.id}>
              <span className="app-avatar">{person.initial}</span>
              <div><strong>{person.name}</strong><small>{person.topic} · {person.provider}</small></div>
              {state === "connected" && <span className="connection-state"><StatusMark /> Connected</span>}
              {state === "pending" && <span className="connection-state quiet">Pending</span>}
              {state === "available" && (
                <button className="app-secondary-action" type="button" onClick={() => setStates((current) => ({ ...current, [person.id]: "pending" }))}>
                  Request to talk
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ProjectSettings() {
  const [agent, setAgent] = useState("Codex");
  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <span className="app-eyebrow">telaegent/backend</span>
        <h1>Project settings</h1>
        <p>These choices apply only to this repository.</p>
      </header>
      <section className="settings-section">
        <header><h2>Project agent</h2></header>
        <div className="agent-choice">
          {["Codex", "Claude Code"].map((item) => (
            <button className={agent === item ? "selected" : ""} type="button" key={item} onClick={() => setAgent(item)}>
              <span>{item}</span><small>{agent === item ? "Current" : "Use for this project"}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <header><h2>Active connections</h2></header>
        {collaborators.slice(0, 2).map((person) => (
          <article className="tool-row" key={person.id}>
            <div><strong>{person.name}</strong><small>Can exchange approved messages in this project</small></div>
            <button className="app-text-button danger" type="button">Revoke</button>
          </article>
        ))}
      </section>
      <section className="settings-section danger-zone">
        <header><h2>Repository connection</h2></header>
        <article className="tool-row">
          <div><strong>Disconnect telaegent/backend</strong><small>Conversations remain in your history, but agents lose repository context.</small></div>
          <button className="app-secondary-action" type="button">Disconnect</button>
        </article>
      </section>
    </div>
  );
}

function Workspace({
  onBack,
  currentUserId,
}: {
  onBack: () => void;
  currentUserId: string | null;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("chat");
  const [selectedId, setSelectedId] = useState("justin");

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar
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
      {tab === "chat" && <ProjectChat selectedId={selectedId} currentUserId={currentUserId} />}
      {tab === "people" && <ProjectPeople />}
      {tab === "settings" && <ProjectSettings />}
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
  const [requestAccepted, setRequestAccepted] = useState(false);

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
          {route === "workspace" ? <><span>Project</span><strong>telaegent/backend</strong></> : <strong>Telaegent cloud</strong>}
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
              onOpenProject={() => setRoute("workspace")}
              requestAccepted={requestAccepted}
              onAcceptRequest={() => setRequestAccepted(true)}
            />
          )}
          {route === "connections" && <ConnectionsScreen requestAccepted={requestAccepted} onAcceptRequest={() => setRequestAccepted(true)} />}
          {route === "settings" && <ToolsSettings />}
          {route === "workspace" && <Workspace onBack={() => setRoute("projects")} currentUserId={user?.userId ?? null} />}
        </main>
      </div>
    </div>
  );
}
