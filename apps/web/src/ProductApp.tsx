import { useEffect, useState, type FormEvent } from "react";
import telaegentLogo from "../../../ui/logo/telaegent-logo-transparent-dark.png";
import telaegentLogoBright from "../../../ui/logo/telaegent-logo-transparent-bright.png";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";
import connectionsIcon from "../../../ui/icon/connections.svg";
import projectsIcon from "../../../ui/icon/project.svg";
import settingsIcon from "../../../ui/icon/setting.svg";
import "./product-app.css";

type Theme = "light" | "dark";
type ProductRoute = "onboarding" | "projects" | "connections" | "settings" | "workspace";
type OnboardingStep = "identity" | "github" | "agent" | "ready";
type GithubStage = "idle" | "connector" | "connected";
type WorkspaceTab = "chat" | "people" | "settings";
type Participant = "phuong" | "justin";
type PrivateMode = "outgoing" | "recipient";
type PrivateStage = "clarify" | "thinking" | "ready";
type DeliveryStage = "idle" | "waiting" | "recipient-ready" | "complete";

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
  id: number;
  side: "outgoing" | "incoming";
  author: string;
  provider: string;
  body: string;
  meta: string;
  code?: string[];
};

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

const initialMessages: SharedMessage[] = [
  {
    id: 1,
    side: "outgoing",
    author: "Phuong",
    provider: "Codex",
    body: "How does your branch refresh sessions, and what should my auth UI call?",
    meta: "Approved by Phuong · feat/auth-ui · a184f2c",
  },
  {
    id: 2,
    side: "incoming",
    author: "Justin",
    provider: "Claude Code",
    body: "The service rotates the refresh token through POST /auth/refresh. Send the refresh cookie and retry the original request once.",
    meta: "Approved by Justin · feat/auth-service · 81ad2e",
    code: ["auth/session.ts", "routes/auth.ts"],
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
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onComplete: () => void;
  onExit: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>("identity");
  const [githubStage, setGithubStage] = useState<GithubStage>("idle");
  const [connectedAgents, setConnectedAgents] = useState<string[]>([]);
  const steps: OnboardingStep[] = ["identity", "github", "agent", "ready"];
  const stepIndex = steps.indexOf(step);

  function toggleAgent(agent: string) {
    setConnectedAgents((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    );
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
                Continue with GitHub
              </button>
              <small>Demo account: Phuong · no personal agent history is imported</small>
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
                  <button type="button" onClick={() => setGithubStage("connector")}>Connect</button>
                </div>
              )}

              {githubStage === "connector" && (
                <div className="device-flow">
                  <div>
                    <span>Run locally in your repository</span>
                    <strong>telaegent connect .</strong>
                  </div>
                  <div>
                    <span>What remains local</span>
                    <code>repo · gh · Claude/Codex · sessions</code>
                  </div>
                  <p>Waiting for the outbound connector…</p>
                  <div className="inline-actions">
                    <button className="app-secondary-action" type="button">Copy command</button>
                    <button className="app-primary-action" type="button" onClick={() => setGithubStage("connected")}>
                      Simulate connector online
                    </button>
                  </div>
                </div>
              )}

              {githubStage === "connected" && (
                <div className="setup-row connected">
                  <div>
                    <strong><StatusMark /> Connector online · @phuong</strong>
                    <small>telaegent/backend · feat/auth · 81ad2e</small>
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

function PrivateAgentRoom({
  open,
  mode,
  stage,
  recipient,
  roughMessage,
  clarification,
  sensitive,
  onClarify,
  onClose,
  onEdit,
  onSend,
}: {
  open: boolean;
  mode: PrivateMode;
  stage: PrivateStage;
  recipient: Collaborator;
  roughMessage: string;
  clarification: string;
  sensitive: boolean;
  onClarify: (answer: string) => void;
  onClose: () => void;
  onEdit: () => void;
  onSend: () => void;
}) {
  const outgoingCandidate = sensitive
    ? "Can you share the environment-variable names required by this project, without any secret values?"
    : roughMessage.trim();

  return (
    <aside className={`workspace-private-room${open ? " open" : ""}`} aria-hidden={!open}>
      <header>
        <div>
          <strong>{mode === "recipient" || stage === "ready" ? "Message Approval" : "Message Preparation"}</strong>
          <small>
            {mode === "outgoing"
              ? `Private with Codex. Not visible to ${recipient.name}.`
              : "Private with Claude Code. Not visible to Phuong."}
          </small>
        </div>
        <button type="button" onClick={onClose}>Close</button>
      </header>

      <div className="private-scope-bar">
        <span>telaegent/backend</span><span>{mode === "outgoing" ? "feat/auth-ui" : recipient.branch}</span>
      </div>

      <div className="workspace-private-thread">
        {mode === "outgoing" ? (
          <>
            <article className="private-bubble user"><span>You</span><p>{roughMessage}</p></article>
            {stage !== "thinking" && (
              <article className="private-bubble agent">
                <div><span>Codex</span>{sensitive && <small>Protected content</small>}</div>
                {stage === "clarify" && (
                  <>
                    <p>
                      {sensitive
                        ? "A .env file is likely to contain credentials. Do you need the values, or only the variable names and safe configuration?"
                        : `Should I include your branch context and ask ${recipient.name}'s agent to inspect ${recipient.branch}?`}
                    </p>
                    {sensitive && <p className="policy-copy">Telaegent will not send raw secret values, even after approval.</p>}
                  </>
                )}
                {stage === "ready" && (
                  <>
                    <p className="ready-label">Ready to send</p>
                    {clarification && <p className="clarification-line">You clarified: {clarification}</p>}
                    <blockquote>{outgoingCandidate}</blockquote>
                  </>
                )}
              </article>
            )}
            {stage === "clarify" && (
              <div className="private-choice-list">
                {(sensitive ? ["Only the variable names", "Safe setup guidance"] : ["Include branch context", "Keep it brief"]).map((choice, index) => (
                  <button className={index === 0 ? "selected" : ""} type="button" key={choice} onClick={() => onClarify(choice)}>
                    <kbd>{index + 1}</kbd>
                    <span>{choice}</span>
                    {index === 0 && <small aria-hidden="true">↵</small>}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="incoming-context">
              <span>Approved request from Phuong</span>
              <p>Can you share the environment-variable names required by this project, without any secret values?</p>
            </div>
            <article className="private-bubble agent recipient-response">
              <div><span>Claude Code</span><small>Safe response</small></div>
              <p>I checked this repository. These variable names are required:</p>
              <code>DATABASE_URL<br />REDIS_URL<br />JWT_SECRET<br />GITHUB_CLIENT_ID<br />GITHUB_CLIENT_SECRET</code>
              <p className="policy-copy">No values or raw .env content are included.</p>
            </article>
          </>
        )}

        {stage === "thinking" && (
          <div className="private-thinking"><span>{mode === "outgoing" ? "Codex is preparing the message" : "Claude is checking the repository"}</span><TypingDots /></div>
        )}
      </div>

      {stage === "ready" && (
        <footer className="private-approval-bar">
          <span>Only Send crosses the trust boundary.</span>
          <div>
            <button type="button" onClick={onEdit}>Edit</button>
            <button type="button" onClick={onClose}>No</button>
            <button className="send" type="button" onClick={onSend}>Send</button>
          </div>
        </footer>
      )}
    </aside>
  );
}

function ProjectChat({ selectedId }: { selectedId: string }) {
  const selected = collaborators.find((person) => person.id === selectedId) ?? collaborators[0];
  const [participant, setParticipant] = useState<Participant>("phuong");
  const [composer, setComposer] = useState("can u send me ur .env");
  const [roughMessage, setRoughMessage] = useState("");
  const [clarification, setClarification] = useState("");
  const [privateMode, setPrivateMode] = useState<PrivateMode>("outgoing");
  const [privateStage, setPrivateStage] = useState<PrivateStage>("clarify");
  const [privateRoomOpen, setPrivateRoomOpen] = useState(false);
  const [deliveryStage, setDeliveryStage] = useState<DeliveryStage>("idle");
  const [messages, setMessages] = useState<SharedMessage[]>(initialMessages);
  const sensitive = /\.env|secret|credential|private key|access token/i.test(roughMessage);
  const visibleMessages = selected.id === "justin" ? messages : [];

  useEffect(() => {
    if (privateStage !== "thinking") return;
    const timer = window.setTimeout(() => setPrivateStage("ready"), 1100);
    return () => window.clearTimeout(timer);
  }, [privateStage]);

  useEffect(() => {
    if (deliveryStage !== "waiting") return;
    const timer = window.setTimeout(() => setDeliveryStage("recipient-ready"), 1800);
    return () => window.clearTimeout(timer);
  }, [deliveryStage]);

  useEffect(() => {
    setPrivateRoomOpen(false);
    setDeliveryStage("idle");
    setParticipant("phuong");
  }, [selectedId]);

  function submitRoughMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextMessage = composer.trim();
    if (!nextMessage) return;
    setRoughMessage(nextMessage);
    setClarification("");
    setPrivateMode("outgoing");
    setPrivateStage("clarify");
    setPrivateRoomOpen(true);
  }

  function clarify(answer: string) {
    setClarification(answer);
    setPrivateStage("thinking");
  }

  function sendOutgoing() {
    const body = sensitive
      ? "Can you share the environment-variable names required by this project, without any secret values?"
      : roughMessage;
    setMessages((current) => [
      ...current,
      {
        id: Date.now(),
        side: "outgoing",
        author: "Phuong",
        provider: "Codex",
        body,
        meta: "Approved by Phuong · feat/auth-ui · a184f2c",
      },
    ]);
    setPrivateRoomOpen(false);
    setComposer("");
    setDeliveryStage("waiting");
  }

  function openRecipientReview() {
    setParticipant("justin");
    setPrivateMode("recipient");
    setPrivateStage("ready");
    setPrivateRoomOpen(true);
  }

  function sendRecipientResponse() {
    setMessages((current) => [
      ...current,
      {
        id: Date.now(),
        side: "incoming",
        author: "Justin",
        provider: "Claude Code",
        body: "I checked the project configuration. These are the required environment-variable names; no values are included.",
        meta: "Approved by Justin · feat/auth-service · 81ad2e",
        code: ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      },
    ]);
    setPrivateRoomOpen(false);
    setDeliveryStage("complete");
  }

  return (
    <section className={`project-chat${privateRoomOpen ? " private-open" : ""}`}>
      <header className="project-chat-header">
        <div>
          <span className="app-avatar">{participant === "phuong" ? selected.initial : "P"}</span>
          <span>
            <strong>{participant === "phuong" ? selected.name : "Phuong"}</strong>
            <small>Shared project conversation</small>
          </span>
        </div>
        <div className="chat-header-meta">
          <span>Codex ↔ {selected.provider}</span>
          <button type="button" onClick={() => setParticipant((current) => (current === "phuong" ? "justin" : "phuong"))}>
            View as {participant === "phuong" ? "Justin" : "Phuong"}
          </button>
        </div>
      </header>

      <div className="chat-project-strip">
        <span><StatusMark /> telaegent/backend</span>
        <small>Phuong: feat/auth-ui · Justin: {selected.branch}</small>
      </div>

      <div className="shared-thread" aria-live="polite">
        <p className="thread-date">Today</p>
        {visibleMessages.length === 0 ? (
          <div className="empty-conversation">
            <span className="app-avatar">{selected.initial}</span>
            <h2>Start a project conversation with {selected.name}.</h2>
            <p>Your rough message goes to your agent privately before {selected.name} can see it.</p>
          </div>
        ) : (
          visibleMessages.map((message) => (
            <article className={`shared-message ${message.side}`} key={message.id}>
              <span>{message.author} · {message.provider}</span>
              <p>{message.body}</p>
              {message.code && (
                <div className="shared-code-list">
                  {message.code.map((item) => <code key={item}>{item}</code>)}
                </div>
              )}
              <small>{message.meta}</small>
            </article>
          ))
        )}

        {deliveryStage === "waiting" && (
          <div className="turn-status"><TypingDots label="Justin's agent is investigating" /><span>Justin&apos;s Claude is investigating privately.</span></div>
        )}
        {deliveryStage === "recipient-ready" && (
          <div className="turn-status decision">
            <div><strong>Response ready on Justin&apos;s side</strong><small>Nothing returns until Justin approves it.</small></div>
            <button type="button" onClick={openRecipientReview}>Preview Justin&apos;s review</button>
          </div>
        )}
        {deliveryStage === "complete" && participant === "justin" && (
          <div className="turn-status decision">
            <div><strong>Response sent</strong><small>Phuong can now see the approved answer.</small></div>
            <button type="button" onClick={() => setParticipant("phuong")}>Return to Phuong&apos;s view</button>
          </div>
        )}
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
          />
          <button type="submit" disabled={!composer.trim()}>Prepare privately</button>
        </div>
        <small>Drafts open with your Codex first. Enter does not send to {selected.name}.</small>
      </form>

      <PrivateAgentRoom
        open={privateRoomOpen}
        mode={privateMode}
        stage={privateStage}
        recipient={selected}
        roughMessage={roughMessage}
        clarification={clarification}
        sensitive={sensitive}
        onClarify={clarify}
        onClose={() => setPrivateRoomOpen(false)}
        onEdit={() => setPrivateStage(privateMode === "outgoing" ? "clarify" : "ready")}
        onSend={privateMode === "outgoing" ? sendOutgoing : sendRecipientResponse}
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

function Workspace({ onBack }: { onBack: () => void }) {
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
      {tab === "chat" && <ProjectChat selectedId={selectedId} />}
      {tab === "people" && <ProjectPeople />}
      {tab === "settings" && <ProjectSettings />}
    </div>
  );
}

export default function ProductApp({
  theme,
  onToggleTheme,
  onExit,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onExit: () => void;
}) {
  const [route, setRoute] = useState<ProductRoute>("onboarding");
  const [requestAccepted, setRequestAccepted] = useState(false);

  if (route === "onboarding") {
    return (
      <Onboarding
        theme={theme}
        onToggleTheme={onToggleTheme}
        onExit={onExit}
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
          <button className="account-button" type="button"><span>DP</span><strong>Phuong</strong></button>
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
          {route === "workspace" && <Workspace onBack={() => setRoute("projects")} />}
        </main>
      </div>
    </div>
  );
}
