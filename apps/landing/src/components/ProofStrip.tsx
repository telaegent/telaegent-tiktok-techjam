import { PROOF_STATS } from "../data/content";
import { Reveal } from "./Reveal";

/**
 * Cheap credibility, earned honestly: every number here is a real value from
 * the canonical flow rather than a marketing figure.
 */
export function ProofStrip() {
  return (
    <section className="section">
      <div className="shell">
        <div className="proof">
          {PROOF_STATS.map((stat, index) => (
            <Reveal key={stat.label} delay={index * 70}>
              <div className="proof-item">
                <b>{stat.value}</b>
                <span className="proof-label">{stat.label}</span>
                <p>{stat.caption}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
