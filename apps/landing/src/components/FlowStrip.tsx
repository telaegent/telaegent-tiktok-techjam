import { FLOW_STAGES } from "../data/content";
import { Reveal } from "./Reveal";

export function FlowStrip() {
  return (
    <section className="section" id="flow">
      <div className="shell center">
        <Reveal>
          <p className="eyebrow">The canonical flow</p>
          <h2 className="h-section">Nine stages, none of them optional</h2>
          <p className="lede">
            The demo runs this end to end on one seeded project with two
            separately owned agents. Scope was narrowed by shrinking the
            fixture, never by removing a stage.
          </p>
        </Reveal>

        <ol className="stages">
          {FLOW_STAGES.map((stage, index) => (
            <Reveal key={stage.n} as="li" delay={index * 45}>
              <div className="stage">
                <span className="stage-node">{stage.n}</span>
                <span className="stage-label">{stage.label}</span>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
