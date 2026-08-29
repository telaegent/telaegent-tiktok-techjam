import { BRAND, CLOSING, DEMO_URL, HERO } from "../data/content";
import { Arrow } from "./Icons";
import { Reveal } from "./Reveal";

export function Closing() {
  return (
    <section className="section closing" id="demo">
      <div className="shell">
        <Reveal>
          <p className="eyebrow">The point</p>
          <blockquote style={{ marginTop: "1.4rem" }}>{CLOSING}</blockquote>
          <div className="cta-row">
            <a className="btn btn-lg btn-primary" href={DEMO_URL}>
              {HERO.primaryCta}
              <Arrow />
            </a>
            <a className="btn btn-lg btn-ghost" href="#flow">
              Read the coordination flow
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="shell footer-inner">
        <img src="/telaegent-wordmark.png" alt={BRAND} />
        <span>
          Coordination and trust middleware for separately owned coding agents.
        </span>
        <span>TikTok TechJam prototype</span>
      </div>
    </footer>
  );
}
