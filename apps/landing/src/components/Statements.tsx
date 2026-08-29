import { STATEMENTS } from "../data/content";
import { Reveal } from "./Reveal";
import { Visual } from "./Visual";

/**
 * The repeating feature rhythm: one large soft card per idea, copy held in the
 * left ~54% and the visual occupying the right 42%. Below 880px the visual
 * drops underneath the copy instead of competing with it.
 */
export function Statements() {
  return (
    <section className="section" id="how">
      <div className="shell statements">
        {STATEMENTS.map((item) => (
          <Reveal key={item.id}>
            <article className="statement">
              <div className="statement-copy">
                <h2>{item.title}</h2>
                <p>{item.body}</p>
              </div>
              <div className="statement-pop" aria-hidden="true">
                <Visual kind={item.visual} />
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
