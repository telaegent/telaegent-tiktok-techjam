import { useEffect, useState } from "react";
import telaegentLogo from "../../../ui/logo/telaegent-logo-transparent-dark.png";
import telaegentLogoBright from "../../../ui/logo/telaegent-logo-transparent-bright.png";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";
import claudeLogo from "../../../ui/logo/claude-symbol.webp";
import codexLogo from "../../../ui/logo/codex-color.svg";
import ProductApp from "./ProductApp";
import SandboxPreview from "./SandboxPreview";
import { api, type TelaegentSession } from "./api";

type Theme = "light" | "dark";
type Surface = "landing" | "product";

function applyDocumentTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const siteIcon = document.querySelector<HTMLLinkElement>("#site-icon");
  if (siteIcon) siteIcon.href = telaegentMark;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#080808" : "#f5f5f3");
}

function getInitialTheme(): Theme {
  const requestedTheme = new URLSearchParams(window.location.search).get(
    "theme",
  );
  if (requestedTheme === "light" || requestedTheme === "dark") {
    applyDocumentTheme(requestedTheme);
    return requestedTheme;
  }

  const savedTheme = window.localStorage.getItem("telaegent-theme");
  const initialTheme =
    savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
  applyDocumentTheme(initialTheme);
  return initialTheme;
}

const workflow = [
  {
    owner: "You + your agent",
    title: "Prepare privately",
    description:
      "Turn a rough intention into a useful, repository-scoped message.",
  },
  {
    owner: "You",
    title: "Review what crosses",
    description:
      "Edit, decline, or choose Send. Draft work stays on your side.",
  },
  {
    owner: "Shared project",
    title: "Send to your teammate",
    description:
      "Only the approved message enters the durable conversation.",
  },
  {
    owner: "Teammate + agent",
    title: "Investigate their side",
    description:
      "Their agent works privately with their repository and local context.",
  },
  {
    owner: "Your teammate",
    title: "Approve the response",
    description:
      "Their answer crosses back only after the same human decision.",
  },
];

function AgentLinkVisual() {
  return (
    <div className="agent-link-section">
      <div
        className="agent-link-diagram"
        role="img"
        aria-label="Mark's Claude sends a repository-scoped message to Duy's Codex"
      >
        <article className="agent-device-card">
          <div className="agent-laptop" aria-hidden="true">
            <div className="agent-laptop-screen">
              <img
                className="agent-provider-logo agent-provider-logo-claude"
                src={claudeLogo}
                alt=""
              />
              <span>Claude</span>
            </div>
            <div className="agent-monitor-stand" />
          </div>
          <strong>Mark&apos;s Claude Code</strong>
        </article>

        <div className="agent-signal" aria-hidden="true">
          <svg viewBox="0 0 420 100" role="presentation">
            <path className="agent-signal-path" d="M18 50H390M374 34L390 50L374 66" />
            <g className="agent-signal-packet">
              <circle cx="22" cy="50" r="5" />
            </g>
            <g className="agent-signal-packet agent-signal-packet-delayed-one">
              <circle cx="22" cy="50" r="4" />
            </g>
            <g className="agent-signal-packet agent-signal-packet-delayed-two">
              <circle cx="22" cy="50" r="3.5" />
            </g>
          </svg>
        </div>

        <article className="agent-device-card">
          <div className="agent-laptop" aria-hidden="true">
            <div className="agent-laptop-screen">
              <img
                className="agent-provider-logo agent-provider-logo-codex"
                src={codexLogo}
                alt=""
              />
              <span>Codex</span>
            </div>
            <div className="agent-monitor-stand" />
          </div>
          <strong>Duy&apos;s Codex</strong>
        </article>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="trust-section" id="trust">
      <header className="section-heading">
        <h2>One conversation. Two private rooms.</h2>
        <p>Agents investigate on each side. People decide what becomes shared project memory.</p>
      </header>

      <div className="workflow-list">
        {workflow.map((item, index) => (
          <article className="workflow-row" key={item.title}>
            <span className="workflow-index">{String(index + 1).padStart(2, "0")}</span>
            <small>{item.owner}</small>
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
  const [surface, setSurface] = useState<Surface>(() =>
    new URLSearchParams(window.location.search).get("view") === "platform"
      ? "product"
      : "landing",
  );
  const [session, setSession] = useState<TelaegentSession | null>(null);
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    applyDocumentTheme(theme);
    window.localStorage.setItem("telaegent-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (surface !== "product") return;
    let active = true;
    setSessionError(false);
    void api.session().then(
      (nextSession) => {
        if (active) setSession(nextSession);
      },
      () => {
        if (active) setSessionError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [surface]);

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  if (surface === "product") {
    if (sessionError) {
      return (
        <main className="onboarding-shell">
          <section className="onboarding-card">
            <span className="app-eyebrow">Telaegent account</span>
            <h1>Sign-in is temporarily unavailable.</h1>
            <p>Check the cloud service and try again. No local GitHub or agent credentials were changed.</p>
            <button className="app-primary-action" type="button" onClick={() => setSurface("landing")}>Back</button>
          </section>
        </main>
      );
    }
    if (session === null) {
      return <main className="onboarding-shell"><section className="onboarding-card"><p>Loading your Telaegent account…</p></section></main>;
    }
    if (session.enabled && !session.authenticated) {
      return (
        <main className="onboarding-shell">
          <section className="onboarding-card">
            <span className="app-eyebrow">Telaegent account</span>
            <h1>Sign in with GitHub.</h1>
            <p>This identifies your Telaegent account only. Repository access is verified separately by your local connector.</p>
            <a className="app-primary-action" href="/api/auth/github/start?returnTo=%2F%3Fview%3Dplatform">Continue with GitHub</a>
          </section>
        </main>
      );
    }
    return (
      <ProductApp
        theme={theme}
        onToggleTheme={toggleTheme}
        onExit={() => setSurface("landing")}
        user={session.enabled && session.authenticated ? session.user : null}
        onLogout={async () => {
          if (session.enabled) {
            await api.logout();
            setSession({ enabled: true, authenticated: false });
          } else {
            setSurface("landing");
          }
        }}
      />
    );
  }

  return (
    <div className="landing-page">
      <header className="site-header">
        <a className="site-brand" href="#top" aria-label="Telaegent home">
          <img
            src={theme === "dark" ? telaegentLogoBright : telaegentLogo}
            alt="Telaegent"
          />
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
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button
            className="header-cta"
            type="button"
            onClick={() => setSurface("product")}
          >
            Open Telægent
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero-section" id="product">
          <header className="hero-pitch">
            <h1>Change the way agents communicate.</h1>
            <p>Your agent can talk to mine. You decide what crosses.</p>
          </header>
          <h2 className="hero-brand-lockup">
            <span>Meet Telægent</span>
            <img src={telaegentMark} alt="" />
          </h2>
          <div className="hero-actions">
            <button
              className="button-primary"
              type="button"
              onClick={() => setSurface("product")}
            >
              Open Telægent
            </button>
            <a className="button-secondary" href="#sandbox">
              See the handoff
            </a>
          </div>

          <AgentLinkVisual />
        </section>

        <section
          className="product-demo"
          id="sandbox"
          aria-label="Telaegent sandbox"
        >
          <header className="sandbox-introduction">
            <h2>See the handoff.</h2>
            <p>One request, two private agents, and two human decisions.</p>
          </header>
          <SandboxPreview onTryOut={() => setSurface("product")} />
        </section>

        <HowItWorks />
      </main>
    </div>
  );
}
