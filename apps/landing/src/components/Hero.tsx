import { DEMO_URL, HERO } from "../data/content";
import { Arrow } from "./Icons";

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="shell">
        <span className="pill">
          <span className="pill-tag">{HERO.pillTag}</span>
          {HERO.pillText}
        </span>

        <h1>
          {HERO.headlineTop}
          <span>{HERO.headlineAccent}</span>
        </h1>

        <p className="hero-sub">{HERO.subhead}</p>

        <div className="cta-row">
          <a className="btn btn-lg btn-primary" href={DEMO_URL}>
            {HERO.primaryCta}
            <Arrow />
          </a>
          <a className="btn btn-lg btn-ghost" href="#flow">
            {HERO.secondaryCta}
          </a>
        </div>
      </div>
    </section>
  );
}
