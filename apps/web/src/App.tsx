import { useEffect, useState } from "react";
import telaegentLogo from "../../../ui/logo/telaegent-logo-transparent-dark.png";
import telaegentLogoBright from "../../../ui/logo/telaegent-logo-transparent-bright.png";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";
import ProductApp from "./ProductApp";
import SandboxPreview from "./SandboxPreview";

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
  const [surface, setSurface] = useState<Surface>(() =>
    new URLSearchParams(window.location.search).get("view") === "platform" ? "product" : "landing",
  );

  useEffect(() => {
    applyDocumentTheme(theme);
    window.localStorage.setItem("telaegent-theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  if (surface === "product") {
    return (
      <ProductApp
        theme={theme}
        onToggleTheme={toggleTheme}
        onExit={() => setSurface("landing")}
      />
    );
  }

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
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button className="sign-in-button" type="button" onClick={() => setSurface("product")}>Sign in</button>
          <button className="header-cta" type="button" onClick={() => setSurface("product")}>Get started</button>
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
            <button className="button-primary" type="button" onClick={() => setSurface("product")}>Get started</button>
            <a className="button-secondary" href="#trust">See how it works</a>
          </div>
        </section>

        <section className="product-demo" id="sandbox" aria-label="Telaegent sandbox">
          <SandboxPreview onTryOut={() => setSurface("product")} />
        </section>

        <HowItWorks />
      </main>
    </div>
  );
}
