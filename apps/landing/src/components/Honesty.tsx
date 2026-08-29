import { HONEST_LIMITS, IS_LIST, IS_NOT_LIST } from "../data/content";
import { Check, Cross } from "./Icons";
import { Reveal } from "./Reveal";

export function Honesty() {
  return (
    <section className="section" id="honesty">
      <div className="shell center">
        <Reveal>
          <p className="eyebrow">Scope, stated plainly</p>
          <h2 className="h-section">
            What this is — and what we are not claiming
          </h2>
          <p className="lede">
            A trust product that oversells itself is not a trust product. These
            are the boundaries of the prototype as built.
          </p>
        </Reveal>

        <div className="duo">
          <Reveal>
            <div className="pane" style={{ textAlign: "left" }}>
              <h3 style={{ color: "var(--cyan)" }}>
                <Check /> Telaegent is
              </h3>
              <ul>
                {IS_LIST.map((item) => (
                  <li key={item}>
                    <Check className="check" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="pane" style={{ textAlign: "left" }}>
              <h3 style={{ color: "var(--muted)" }}>
                <Cross /> Telaegent is not
              </h3>
              <ul>
                {IS_NOT_LIST.map((item) => (
                  <li key={item}>
                    <Cross className="check" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>

        <div className="limits">
          {HONEST_LIMITS.map((limit, index) => (
            <Reveal key={limit.title} delay={index * 70}>
              <div className="limit" style={{ textAlign: "left" }}>
                <h4>{limit.title}</h4>
                <p>{limit.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
