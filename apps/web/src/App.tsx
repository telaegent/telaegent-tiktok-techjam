import { useEffect, useState } from "react";
import telaegentLogo from "../../../ui/logo/telaegent-logo-transparent-dark.png";
import telaegentLogoBright from "../../../ui/logo/telaegent-logo-transparent-bright.png";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";
import claudeLogo from "../../../ui/logo/claude-symbol.webp";
import codexLogo from "../../../ui/logo/codex-color.svg";
import ProductApp from "./ProductApp";
import SandboxPreview from "./SandboxPreview";
import ThemeSwitch from "./ThemeSwitch";
import { api, type TelaegentSession } from "./api";
import {
  APP_PATH,
  ONBOARDING_PATH,
  canonicalProductUrl,
  surfaceFromUrl,
  type AppSurface,
} from "./app-routing";
import { isUiPreviewEnabled } from "./preview-api";

type Theme = "light" | "dark";

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
            <path
              className="agent-signal-path"
              d="M18 50H390M374 34L390 50L374 66"
            />
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

function ThemeAwareMark({ theme }: { theme: Theme }) {
  return (
    <svg
      className="hero-theme-mark"
      viewBox="0 0 700 680"
      aria-hidden="true"
      focusable="false"
    >
      <image
        href={theme === "dark" ? telaegentLogoBright : telaegentLogo}
        width="2000"
        height="680"
      />
    </svg>
  );
}

function HowItWorks() {
  return (
    <section className="trust-section" id="trust">
      <header className="section-heading">
        <h2>Your agent works in private. You choose what leaves.</h2>
        <p>
          Each teammate gets a private workspace. Only reviewed messages join
          the shared project record.
        </p>
      </header>

      <div className="trust-map">
        <article className="trust-room trust-room-sender">
          <header>
            <span>Private to you</span>
            <strong>You + your agent</strong>
          </header>
          <h3>Prepare with local context.</h3>
          <p>
            Your agent can inspect the repository you connected and turn a
            rough request into a useful message.
          </p>
          <div className="trust-room-detail">
            <span>Stays on your side</span>
            <code>draft + local repo</code>
          </div>
        </article>

        <div className="trust-gate trust-gate-outbound">
          <span>Human decision</span>
          <strong>You choose Send</strong>
          <div className="trust-gate-actions" aria-hidden="true">
            <i>Edit</i>
            <i>No</i>
            <i className="selected">Send</i>
          </div>
        </div>

        <article className="trust-shared-room">
          <header>
            <span>Shared project</span>
            <strong>Approved conversation</strong>
          </header>
          <blockquote>
            “Can you confirm how session refresh works on your branch?”
          </blockquote>
          <p>Only reviewed messages become durable project memory.</p>
        </article>

        <article className="trust-room trust-room-recipient">
          <header>
            <span>Private to them</span>
            <strong>Teammate + their agent</strong>
          </header>
          <h3>Investigate without opening the workspace.</h3>
          <p>
            Their agent works against their local repository, then prepares a
            response for review.
          </p>
          <div className="trust-room-detail">
            <span>Stays on their side</span>
            <code>analysis + local repo</code>
          </div>
        </article>

        <div className="trust-gate trust-gate-inbound">
          <span>Same rule on their side</span>
          <strong>Your teammate chooses Send</strong>
        </div>
      </div>

      <div className="trust-rule">
        <strong>Repository access stays local.</strong>
        <p>
          A connection lets agents ask questions. It never opens another
          person&apos;s workspace.
        </p>
      </div>
    </section>
  );
}

export default function App() {
  const uiPreview = isUiPreviewEnabled();
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [surface, setSurface] = useState<AppSurface>(() =>
    surfaceFromUrl(window.location.pathname, window.location.search),
  );
  const [session, setSession] = useState<TelaegentSession | null>(null);
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    applyDocumentTheme(theme);
    window.localStorage.setItem("telaegent-theme", theme);
  }, [theme]);

  useEffect(() => {
    const canonicalUrl = canonicalProductUrl(
      window.location.pathname,
      window.location.search,
    );
    if (canonicalUrl) {
      window.history.replaceState(null, "", canonicalUrl);
    }
    const syncSurface = () => {
      setSurface(
        surfaceFromUrl(window.location.pathname, window.location.search),
      );
    };
    window.addEventListener("popstate", syncSurface);
    return () => window.removeEventListener("popstate", syncSurface);
  }, []);

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

  function navigateSurface(nextSurface: AppSurface) {
    const nextUrl = nextSurface === "product" ? APP_PATH : "/";
    if (
      `${window.location.pathname}${window.location.search}${window.location.hash}` !==
      nextUrl
    ) {
      window.history.pushState(null, "", nextUrl);
    }
    setSurface(nextSurface);
  }

  if (surface === "product") {
    if (sessionError) {
      return (
        <main className="onboarding-shell">
          <section className="onboarding-card">
            <span className="app-eyebrow">Telaegent account</span>
            <h1>Sign-in is temporarily unavailable.</h1>
            <p>
              Check the cloud service and try again. No local GitHub or agent
              credentials were changed.
            </p>
            <button
              className="app-primary-action"
              type="button"
              onClick={() => navigateSurface("landing")}
            >
              Back
            </button>
          </section>
        </main>
      );
    }
    if (session === null) {
      return (
        <main className="onboarding-shell">
          <section className="onboarding-card">
            <p>Loading your Telaegent account…</p>
          </section>
        </main>
      );
    }
    if (session.enabled && !session.authenticated) {
      return (
        <main className="onboarding-shell">
          <section className="onboarding-card">
            <span className="app-eyebrow">Telaegent account</span>
            <h1>Sign in with GitHub.</h1>
            <p>
              This identifies your Telaegent account only. Repository access is
              verified separately by your local connector.
            </p>
            <a
              className="app-primary-action"
              href={`/api/auth/github/start?returnTo=${encodeURIComponent(ONBOARDING_PATH)}`}
            >
              Continue with GitHub
            </a>
          </section>
        </main>
      );
    }
    return (
      <ProductApp
        theme={theme}
        onToggleTheme={toggleTheme}
        onExit={() => navigateSurface("landing")}
        user={session.enabled && session.authenticated ? session.user : null}
        preview={uiPreview}
        onLogout={async () => {
          if (session.enabled) {
            await api.logout();
            setSession({ enabled: true, authenticated: false });
          } else {
            navigateSurface("landing");
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
          <a href="#sandbox">Sandbox</a>
          <a href="#trust">How it works</a>
        </nav>

        <div className="site-actions">
          <ThemeSwitch theme={theme} onToggle={toggleTheme} />
          <button
            className="header-cta"
            type="button"
            onClick={() => navigateSurface("product")}
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
            <ThemeAwareMark theme={theme} />
          </h2>
          <div className="hero-actions">
            <button
              className="button-primary"
              type="button"
              onClick={() => navigateSurface("product")}
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
          <SandboxPreview onTryOut={() => navigateSurface("product")} />
        </section>

        <HowItWorks />
      </main>
    </div>
  );
}
