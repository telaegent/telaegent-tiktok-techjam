import { SHARING_TIERS } from "../data/content";
import { Reveal } from "./Reveal";

export function SharingTiers() {
  return (
    <section className="section" id="trust">
      <div className="shell center">
        <Reveal>
          <p className="eyebrow">The disclosure boundary</p>
          <h2 className="h-section">Three tiers decide what leaves an agent</h2>
          <p className="lede">
            Every request an agent makes falls into exactly one of these. The
            tier is resolved by deterministic code before anything is read, and
            the middle tier always stops for a human.
          </p>
        </Reveal>

        <div className="grid-3">
          {SHARING_TIERS.map((tier, index) => (
            <Reveal key={tier.tone} delay={index * 80}>
              <article className="pane" data-tone={tier.tone} style={{ textAlign: "left" }}>
                <span className="tag" data-tone={tier.tone}>
                  {tier.label}
                </span>
                <h3>{tier.title}</h3>
                <p className="pane-caption">{tier.caption}</p>
                <ul>
                  {tier.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
