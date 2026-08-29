import type { Visual as VisualKind } from "../data/content";
import { Check, Clock, Cross } from "./Icons";

/**
 * The six product visuals, shared by the alternating feature rows and the bento
 * tiles. Each one is built from the same card/tag/path primitives the product
 * shell uses, so the landing page promises a product that looks like itself.
 */
export function Visual({ kind }: { kind: VisualKind }) {
  switch (kind) {
    case "intent":
      return (
        <div className="viz">
          <article className="card">
            <div className="card-head">
              <span className="tag" data-tone="neutral">
                Intent
              </span>
              <span className="card-title">alice · feature/oauth-provider</span>
            </div>
            <div className="path-list">
              <div className="path">
                <b>task</b>
                <code>Add OAuth provider login</code>
              </div>
              <div className="path">
                <b>base</b>
                <code>af31d4e</code>
              </div>
              <div className="path">
                <b>files</b>
                <code>src/auth/**, src/routes/login.ts</code>
              </div>
              <div className="path">
                <b>iface</b>
                <code>Session</code>
              </div>
            </div>
          </article>
          <p className="cite-note">
            Published to the project, not to a person&apos;s inbox.
          </p>
        </div>
      );

    case "conflict":
      return (
        <div className="viz">
          <div className="score-row">
            <span>shared interface — Session</span>
            <b>+4</b>
          </div>
          <div className="score-row">
            <span>shared module — src/auth</span>
            <b>+1</b>
          </div>
          <div className="score-row">
            <span>same changed file</span>
            <b>0</b>
          </div>
          <div className="score-total">
            <span>Blocking</span>
            <b>5</b>
          </div>
        </div>
      );

    case "status":
      return (
        <div className="viz">
          <article className="card">
            <div className="card-head">
              <span className="tag" data-tone="allow">
                Status
              </span>
              <span className="card-title">from Bob&apos;s agent</span>
            </div>
            <div className="path-list">
              <div className="path">
                <b>purpose</b>
                <code>Shared Session contract</code>
              </div>
              <div className="path">
                <b>progress</b>
                <code>60% · not stale</code>
              </div>
              <div className="path">
                <b>ttl</b>
                <code>expires in 10m</code>
              </div>
            </div>
          </article>
          <article className="card" data-tone="deny">
            <div className="path-list">
              <div className="path" data-state="deny">
                <Cross />
                <code>session transcript</code>
              </div>
              <div className="path" data-state="deny">
                <Cross />
                <code>private reasoning</code>
              </div>
            </div>
          </article>
        </div>
      );

    case "approve":
      return (
        <div className="viz">
          <article className="card" data-tone="review">
            <div className="card-head">
              <span className="tag" data-tone="review">
                Awaiting both
              </span>
            </div>
            <div className="approvals approvals-stack">
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
        </div>
      );

    case "context":
      return (
        <div className="viz">
          <article className="card">
            <div className="card-head">
              <span className="tag" data-tone="allow">
                ContextPack
              </span>
              <span className="card-title">4 files · validated</span>
            </div>
            <div className="path-list">
              <div className="cite">
                Sessions are stored in Redis with a 24h TTL.
                <code>session.ts:14-28</code>
              </div>
              <div className="cite">
                The repository interface is unchanged.
                <code>session-repository.ts:3-11</code>
              </div>
            </div>
          </article>
        </div>
      );

    case "adapt":
      return (
        <div className="viz">
          <article className="card" data-tone="review">
            <div className="card-head">
              <span className="tag" data-tone="review">
                Dependency changed
              </span>
              <span className="card-title">Session gained tokenVersion</span>
            </div>
          </article>
          <div className="diff">
            <div className="diff-line" data-kind="old">
              <span>−</span>read session by id, trust the cookie
            </div>
            <div className="diff-line" data-kind="new">
              <span>+</span>read session by id, compare tokenVersion
            </div>
          </div>
        </div>
      );
  }
}
