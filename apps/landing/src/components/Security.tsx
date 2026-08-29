import { Cross } from "./Icons";
import { Reveal } from "./Reveal";

const REFUSED = [
  { path: ".env", code: "FORBIDDEN_PATH" },
  { path: "../../etc/passwd", code: "PATH_TRAVERSAL" },
  { path: ".git/config", code: "FORBIDDEN_PATH" },
  { path: "/abs/secret.pem", code: "ABSOLUTE_PATH" },
  { path: "node_modules/../../..", code: "OUTSIDE_WORKSPACE" },
];

/**
 * The one section that breaks the page's own pattern. Same statement-card
 * shape, tinted red — it is the single idea most worth remembering.
 */
export function Security() {
  return (
    <section className="section" id="security">
      <div className="shell">
        <Reveal>
          <article className="statement" data-tone="deny">
            <div className="statement-copy">
              <h2>
                <code className="mono" style={{ fontSize: "0.78em" }}>
                  .env
                </code>{" "}
                is refused before it is opened
              </h2>
              <p>
                Path rules run while a request is still a string. Traversal,
                absolute paths, credential-shaped names, git internals, external
                symlinks, and anything outside the canonical workspace are
                rejected before a single byte is read — so there is no content
                to leak into a log, a card, or an audit record.
              </p>
            </div>
            <div className="statement-pop" aria-hidden="true">
              <div className="deny-log">
                <div className="deny-log-head">
                  <span>policy check</span>
                  <span>pre-read</span>
                </div>
                <div className="deny-log-body">
                  {REFUSED.map((entry) => (
                    <div className="path" data-state="deny" key={entry.path}>
                      <Cross />
                      <code>{entry.path}</code>
                      <b style={{ marginLeft: "auto" }}>{entry.code}</b>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </article>
        </Reveal>
      </div>
    </section>
  );
}
