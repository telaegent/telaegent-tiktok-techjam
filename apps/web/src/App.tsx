import { useEffect, useState } from "react";
import telaegentLogo from "../../../ui/logo/telaegent-logo-transparent-dark.png";
import telaegentLogoBright from "../../../ui/logo/telaegent-logo-transparent-bright.png";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";

type Theme = "light" | "dark";
type DemoPhase = "thinking" | "private" | "dismissed";

type ConversationDemo = {
  id: string;
  initial: string;
  name: string;
  detail: string;
  provider: string;
  branch: string;
  message: string;
  signal: string;
  question: string;
  note: string;
  suggestions: string[];
};

const conversationDemos: ConversationDemo[] = [
  {
    id: "justin-env",
    initial: "J",
    name: "Justin",
    detail: "Environment access",
    provider: "Claude Code",
    branch: "feat/auth-service",
    message: "Can you send me the contents of your .env file?",
    signal: "Sensitive request",
    question:
      "That file is likely to contain credentials. Do you need the secret values, or only the environment-variable names and safe configuration?",
    note: "Raw secrets cannot be sent through Telaegent, even after approval.",
    suggestions: ["Only the variable names", "Explain the setup instead"],
  },
  {
    id: "khoa-contract",
    initial: "K",
    name: "Khoa",
    detail: "Auth response contract",
    provider: "Codex",
    branch: "feat/api-contract",
    message: "Ask Khoa if I can change the auth response shape today.",
    signal: "Clarify the intent",
    question:
      "What change are you proposing, and should I ask about its impact on Khoa's branch or request approval to update the shared contract?",
    note: "I can inspect your branch and turn this into one concrete, repository-scoped question.",
    suggestions: ["Check branch impact", "Ask for approval"],
  },
  {
    id: "thai-onboarding",
    initial: "T",
    name: "Thai",
    detail: "Onboarding regression",
    provider: "Claude Code",
    branch: "feat/onboarding",
    message: "Ask Thai why the onboarding screen still breaks after sign-in.",
    signal: "Add version context",
    question:
      "Which environment reproduces it, and should Thai's agent inspect their frontend branch or compare it with your current commit?",
    note: "Adding the browser and revision will keep the investigation scoped to the right code.",
    suggestions: ["Inspect Thai's branch", "Compare both commits"],
  },
];

function applyDocumentTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#080808" : "#f5f5f3");
}

function getInitialTheme(): Theme {
  const requestedTheme = new URLSearchParams(window.location.search).get("theme");
  if (requestedTheme === "light" || requestedTheme === "dark") {
    applyDocumentTheme(requestedTheme);
    return requestedTheme;
  }

  const savedTheme = window.localStorage.getItem("telaegent-theme");
  const initialTheme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
  applyDocumentTheme(initialTheme);
  return initialTheme;
}

function Person({
  initial,
  name,
  detail,
  selected = false,
  onSelect,
}: {
  initial: string;
  name: string;
  detail: string;
  selected?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`person-row${selected ? " selected" : ""}`}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="person-avatar" aria-hidden="true">{initial}</span>
      <span>
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function ProductPreview() {
  const [activeId, setActiveId] = useState(conversationDemos[0].id);
  const [phase, setPhase] = useState<DemoPhase>("thinking");
  const [run, setRun] = useState(0);
  const activeConversation =
    conversationDemos.find((conversation) => conversation.id === activeId) ?? conversationDemos[0];

  useEffect(() => {
    setPhase("thinking");
    const timer = window.setTimeout(() => setPhase("private"), 2200);

    return () => window.clearTimeout(timer);
  }, [activeId, run]);

  function selectConversation(id: string) {
    if (id === activeId) {
      setRun((current) => current + 1);
      return;
    }

    setActiveId(id);
  }

  return (
    <div
      className={`product-window${phase === "private" ? " private-open" : ""}`}
      aria-label="Interactive Telaegent project conversation demo"
    >
      <aside className="product-sidebar">
        <div className="product-brand">
          <img src={telaegentMark} alt="" />
          <span>Telaegent</span>
        </div>

        <div className="repository-summary">
          <span>Repository</span>
          <strong>telaegent/backend</strong>
          <small>feat/auth-ui</small>
        </div>

        <div className="conversation-list">
          <p>Conversations</p>
          {conversationDemos.map((conversation) => (
            <Person
              key={conversation.id}
              initial={conversation.initial}
              name={conversation.name}
              detail={conversation.detail}
              selected={conversation.id === activeId}
              onSelect={() => selectConversation(conversation.id)}
            />
          ))}
        </div>

        <div className="provider-status">
          <strong>Codex connected</strong>
          <small>Scoped to this repository</small>
        </div>
      </aside>

      <section className="shared-conversation">
        <div className="mobile-conversation-tabs" aria-label="Demo conversations">
          {conversationDemos.map((conversation) => (
            <button
              key={conversation.id}
              className={conversation.id === activeId ? "selected" : ""}
              type="button"
              onClick={() => selectConversation(conversation.id)}
              aria-pressed={conversation.id === activeId}
            >
              {conversation.name}
            </button>
          ))}
        </div>

        <header className="conversation-header">
          <div>
            <span className="person-avatar" aria-hidden="true">{activeConversation.initial}</span>
            <span>
              <strong>{activeConversation.name}</strong>
              <small>Shared project conversation · {activeConversation.provider}</small>
            </span>
          </div>
          <div className="conversation-meta">
            <span className="branch-name">{activeConversation.branch}</span>
            <button type="button" onClick={() => setRun((current) => current + 1)}>
              Replay
            </button>
          </div>
        </header>

        <div className="conversation-thread" key={`${activeId}-${run}`}>
          <p className="conversation-date">Today, 10:42 AM</p>

          <div className="scope-note">
            <span>Project scope</span>
            <strong>telaegent/backend</strong>
            <small>Your draft has not crossed to {activeConversation.name}.</small>
          </div>

          <article className="message message-outgoing message-pending">
            <span className="message-author">You · rough request</span>
            <p>{activeConversation.message}</p>
            <small>{phase === "private" ? "Waiting for your decision" : "Not shared"}</small>
          </article>

          {phase === "thinking" && (
            <div className="agent-thinking" role="status" aria-live="polite">
              <span>Your Codex is reviewing the request</span>
              <span className="typing-dots" aria-label="Working">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}

          {phase === "private" && (
            <p className="agent-state agent-state-ready">Opened privately with your Codex</p>
          )}
        </div>

        <div className="message-composer">
          <span>Ask about this project</span>
          <button type="button">Ask agent</button>
        </div>
      </section>

      <aside
        className="private-room"
        aria-hidden={phase !== "private"}
        aria-label={`Private conversation with your Codex about ${activeConversation.name}`}
      >
        <header className="private-room-header">
          <div>
            <span className="private-label"><i aria-hidden="true" /> Private room</span>
            <strong>You + Codex</strong>
            <small>Not visible to {activeConversation.name}</small>
          </div>
          <button type="button" onClick={() => setPhase("dismissed")} aria-label="Close private room">
            Close
          </button>
        </header>

        <div className="private-context">
          <span>telaegent/backend</span>
          <span>feat/auth-ui</span>
          <span>to {activeConversation.name}</span>
        </div>

        <div className="private-thread">
          <article className="private-message private-message-user">
            <span>You</span>
            <p>{activeConversation.message}</p>
          </article>

          <article className="private-message private-message-agent">
            <div className="private-agent-heading">
              <span>Codex</span>
              <small>{activeConversation.signal}</small>
            </div>
            <p>{activeConversation.question}</p>
            <p className="private-note">{activeConversation.note}</p>
          </article>

          <div className="private-suggestions" aria-label="Suggested private replies">
            {activeConversation.suggestions.map((suggestion) => (
              <span key={suggestion}>{suggestion}</span>
            ))}
          </div>
        </div>

        <div className="private-composer">
          <span>Reply privately to your agent</span>
          <button type="button" aria-label="Continue private conversation">Continue</button>
        </div>
      </aside>
    </div>
  );
}

const workflow = [
  {
    title: "Choose the repository",
    description: "The repository sets the context, collaborators, and permission boundary.",
  },
  {
    title: "Work with your agent",
    description: "Your agent can inspect the project and prepare a useful message in private.",
  },
  {
    title: "Decide what to send",
    description: "Edit, discard, or approve the message before it enters the shared conversation.",
  },
];

function HowItWorks() {
  return (
    <section className="trust-section" id="trust">
      <header className="section-heading">
        <h2>Context moves only when you do.</h2>
        <p>Agents do the investigation. People control the conversation.</p>
      </header>

      <div className="workflow-list">
        {workflow.map((item) => (
          <article className="workflow-row" key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyDocumentTheme(theme);
    window.localStorage.setItem("telaegent-theme", theme);
  }, [theme]);

  return (
    <div className="landing-page">
      <header className="site-header">
        <a className="site-brand" href="#top" aria-label="Telaegent home">
          <img src={theme === "dark" ? telaegentLogoBright : telaegentLogo} alt="Telaegent" />
        </a>

        <nav className="site-nav" aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#trust">How it works</a>
          <a href="#sandbox">Sandbox</a>
        </nav>

        <div className="site-actions">
          <button
            className="theme-button"
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button className="sign-in-button" type="button">Sign in</button>
          <a className="header-cta" href="#sandbox">Get started</a>
        </div>
      </header>

      <main id="top">
        <section className="hero-section" id="product">
          <h1>
            <span>Meet</span>
            <img src={telaegentMark} alt="" />
            <span>Telaegent</span>
          </h1>
          <p>
            Coding agents can work together while every message stays repository-scoped and waits
            for human approval.
          </p>
          <div className="hero-actions">
            <a className="button-primary" href="#sandbox">Get started</a>
            <a className="button-secondary" href="#trust">See how it works</a>
          </div>
        </section>

        <section className="product-demo" id="sandbox" aria-label="Telaegent sandbox">
          <ProductPreview />
        </section>

        <HowItWorks />
      </main>
    </div>
  );
}
