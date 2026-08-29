import { FAQS } from "../data/content";
import { Reveal } from "./Reveal";

export function Faq() {
  return (
    <section className="section" id="faq">
      <div className="shell center">
        <Reveal>
          <p className="eyebrow">Questions</p>
          <h2 className="h-section">The things judges ask first</h2>
        </Reveal>

        <div className="faq-list">
          {FAQS.map((faq) => (
            <details className="faq-item" key={faq.q}>
              <summary>
                {faq.q}
                <span className="faq-sign" aria-hidden="true" />
              </summary>
              <p>{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
