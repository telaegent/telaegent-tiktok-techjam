import { Check, Clock, Cross } from "./Icons";

/**
 * A static stand-in for the demo shell: agent rail on the left, the shared
 * coordination conversation on the right. It shows the three moments that make
 * the product legible in ten seconds — a blocking conflict, two separate
 * approvals, and a refused `.env` read.
 */
export function ProductPreview() {
  return (
    <div className="shell">
      <div className="frame">
        <div className="frame-chrome">
          <div className="dots">
            <i />
            <i />
            <i />
          </div>
          <span className="chrome-title">Phoenix — shared coordination</span>
          <span className="chrome-badge">2 owners · 2 agents</span>
        </div>

        <div className="frame-body">
          <aside className="rail">
            <div className="rail-label">Agents</div>

            <article className="agent" data-active="true">
              <div className="agent-head">
                <span className="avatar" data-who="alice">
                  A
                </span>
                <span className="agent-name">Alice&apos;s agent</span>
              </div>
              <div className="agent-meta">
                <span>owner: alice</span>
                <span>feature/oauth-provider</span>
                <span>waiting · approval</span>
              </div>
              <div className="bar">
                <i style={{ width: "40%" }} />
              </div>
            </article>

            <article className="agent">
              <div className="agent-head">
                <span className="avatar" data-who="bob">
                  B
                </span>
                <span className="agent-name">Bob&apos;s agent</span>
              </div>
              <div className="agent-meta">
                <span>owner: bob</span>
                <span>feature/redis-sessions</span>
                <span>running · 60%</span>
              </div>
              <div className="bar">
                <i style={{ width: "60%" }} />
              </div>
            </article>
          </aside>

          <div className="stream">
            <article className="card">
              <div className="card-head">
                <span className="tag" data-tone="neutral">
                  Intent
                </span>
                <span className="card-title">
                  Bob is reworking session storage
                </span>
              </div>
              <p className="card-body">
                Declares <code className="mono">Session</code> ·{" "}
                <code className="mono">src/auth/**</code> · base{" "}
                <code className="mono">af31d4e</code>
              </p>
            </article>

            <article className="card" data-tone="deny">
              <div className="card-head">
                <span className="tag" data-tone="deny">
                  Blocking conflict
                </span>
                <span className="card-title">score 5 · detected in code</span>
              </div>
              <div className="path-list">
                <div className="score-row">
                  <span>shared interface — Session</span>
                  <b>+4</b>
                </div>
                <div className="score-row">
                  <span>shared module — src/auth</span>
                  <b>+1</b>
                </div>
              </div>
            </article>

            <article className="card" data-tone="review">
              <div className="card-head">
                <span className="tag" data-tone="review">
                  Agreement
                </span>
                <span className="card-title">
                  Bob owns the contract, Alice consumes it
                </span>
              </div>
              <div className="approvals">
                <div className="approval" data-state="approved">
                  <Check className="check" />
                  Bob approved
                </div>
                <div className="approval" data-state="pending">
                  <Clock className="check" />
                  Alice pending
                </div>
              </div>
            </article>

            <article className="card" data-tone="deny">
              <div className="card-head">
                <span className="tag" data-tone="deny">
                  Denied
                </span>
                <span className="card-title">
                  Request refused before any read
                </span>
              </div>
              <div className="path-list">
                <div className="path" data-state="allow">
                  <Check />
                  <code>src/auth/session.ts</code>
                </div>
                <div className="path" data-state="deny">
                  <Cross />
                  <code>.env</code>
                  <b>FORBIDDEN_PATH</b>
                </div>
              </div>
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}
