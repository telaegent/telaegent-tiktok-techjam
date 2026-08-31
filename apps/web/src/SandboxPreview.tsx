import { useEffect, useRef, useState, type FormEvent } from "react";
import telaegentMark from "../../../ui/logo/telaegent-logo-symbol-transparent.png";
import {
  findSandboxConversation,
  peopleById,
  sandboxRepositories,
  type SandboxPersonId,
  type SandboxSide,
} from "./sandbox-data";

type DemoPhase = "thinking" | "private" | "sent" | "declined" | "dismissed";
type SwitchStage = "idle" | "out" | "in";

type SandboxTransfer = {
  repositoryId: string;
  conversationId: string;
  senderId: SandboxPersonId;
  recipientId: SandboxPersonId;
  content: string;
  evaluation: SandboxSide;
};

function avatarUrl(id: SandboxPersonId) {
  return `https://github.com/identicons/${encodeURIComponent(id)}.png`;
}

function SandboxAvatar({ id, className = "" }: { id: SandboxPersonId; className?: string }) {
  const person = peopleById[id];

  return (
    <img
      className={`person-avatar${className ? ` ${className}` : ""}`}
      src={avatarUrl(id)}
      alt={`${person.name}'s avatar`}
      width="48"
      height="48"
      decoding="async"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

function SandboxPerson({
  id,
  selected,
  onSelect,
}: {
  id: SandboxPersonId;
  selected: boolean;
  onSelect: () => void;
}) {
  const person = peopleById[id];

  return (
    <button
      className={`person-row${selected ? " selected" : ""}`}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
    >
      <SandboxAvatar id={id} />
      <span>
        <strong>{person.name}</strong>
        <small>{person.provider}</small>
      </span>
    </button>
  );
}

export default function SandboxPreview({ onTryOut }: { onTryOut: () => void }) {
  const firstRepository = sandboxRepositories[0];
  const [activeRepositoryId, setActiveRepositoryId] = useState(firstRepository.id);
  const [viewerId, setViewerId] = useState<SandboxPersonId>(firstRepository.defaultViewer);
  const [peerId, setPeerId] = useState<SandboxPersonId>(
    firstRepository.members.find((id) => id !== firstRepository.defaultViewer) ?? firstRepository.defaultViewer,
  );
  const [phase, setPhase] = useState<DemoPhase>("thinking");
  const [run, setRun] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [composer, setComposer] = useState("");
  const [tryOutMounted, setTryOutMounted] = useState(false);
  const [tryOutOpen, setTryOutOpen] = useState(false);
  const [switchStage, setSwitchStage] = useState<SwitchStage>("idle");
  const [transfer, setTransfer] = useState<SandboxTransfer | null>(null);
  const tryOutMountFrame = useRef<number | null>(null);
  const tryOutOpenFrame = useRef<number | null>(null);
  const switchTimer = useRef<number | null>(null);
  const switchFrameOne = useRef<number | null>(null);
  const switchFrameTwo = useRef<number | null>(null);

  const repository =
    sandboxRepositories.find((item) => item.id === activeRepositoryId) ?? firstRepository;
  const viewer = peopleById[viewerId];
  const peer = peopleById[peerId];
  const peers = repository.members.filter((id) => id !== viewerId);
  const activeConversation = findSandboxConversation(repository, viewerId, peerId)
    ?? repository.conversations[0];
  const activeSide = activeConversation.sides[viewerId];
  const isReceivingTransfer =
    transfer?.repositoryId === repository.id
    && transfer.conversationId === activeConversation.id
    && transfer.senderId === peerId
    && transfer.recipientId === viewerId;
  const privateSide = isReceivingTransfer ? transfer.evaluation : activeSide;
  const selectedAnswer = selectedOption === null ? null : privateSide.options[selectedOption];

  useEffect(() => {
    setPhase("thinking");
    setSelectedOption(null);
    const timer = window.setTimeout(() => setPhase("private"), 1300);
    return () => window.clearTimeout(timer);
  }, [activeRepositoryId, peerId, run, viewerId]);

  useEffect(() => () => {
    if (tryOutMountFrame.current !== null) window.cancelAnimationFrame(tryOutMountFrame.current);
    if (tryOutOpenFrame.current !== null) window.cancelAnimationFrame(tryOutOpenFrame.current);
    if (switchTimer.current !== null) window.clearTimeout(switchTimer.current);
    if (switchFrameOne.current !== null) window.cancelAnimationFrame(switchFrameOne.current);
    if (switchFrameTwo.current !== null) window.cancelAnimationFrame(switchFrameTwo.current);
  }, []);

  function selectPerson(id: SandboxPersonId) {
    if (switchStage !== "idle") return;
    if (id === peerId) {
      setRun((current) => current + 1);
      return;
    }
    setPeerId(id);
  }

  function switchPerspective() {
    if (phase !== "sent" || switchStage !== "idle") return;

    setSwitchStage("out");
    switchTimer.current = window.setTimeout(() => {
      switchTimer.current = null;
      setViewerId(peerId);
      setPeerId(viewerId);
      setRun((current) => current + 1);
      setSwitchStage("in");
      switchFrameOne.current = window.requestAnimationFrame(() => {
        switchFrameOne.current = null;
        switchFrameTwo.current = window.requestAnimationFrame(() => {
          switchFrameTwo.current = null;
          setSwitchStage("idle");
        });
      });
    }, 200);
  }

  function switchRepository() {
    if (switchStage !== "idle") return;
    const currentIndex = sandboxRepositories.findIndex((item) => item.id === repository.id);
    const nextRepository = sandboxRepositories[(currentIndex + 1) % sandboxRepositories.length];
    const nextViewer = nextRepository.defaultViewer;
    const nextPeer = nextRepository.members.find((id) => id !== nextViewer) ?? nextViewer;

    setActiveRepositoryId(nextRepository.id);
    setViewerId(nextViewer);
    setPeerId(nextPeer);
    setRun((current) => current + 1);
  }

  function sendPreparedMessage() {
    const content = isReceivingTransfer && selectedAnswer
      ? selectedAnswer.answer
      : activeSide.intent;

    setTransfer({
      repositoryId: repository.id,
      conversationId: activeConversation.id,
      senderId: viewerId,
      recipientId: peerId,
      content,
      evaluation: activeSide,
    });
    setPhase("sent");
  }

  function interceptSandboxSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tryOutMountFrame.current !== null) window.cancelAnimationFrame(tryOutMountFrame.current);
    if (tryOutOpenFrame.current !== null) window.cancelAnimationFrame(tryOutOpenFrame.current);
    setTryOutMounted(true);
    tryOutMountFrame.current = window.requestAnimationFrame(() => {
      tryOutMountFrame.current = null;
      tryOutOpenFrame.current = window.requestAnimationFrame(() => {
        tryOutOpenFrame.current = null;
        setTryOutOpen(true);
      });
    });
  }

  function closeTryOut() {
    if (tryOutMountFrame.current !== null) window.cancelAnimationFrame(tryOutMountFrame.current);
    if (tryOutOpenFrame.current !== null) window.cancelAnimationFrame(tryOutOpenFrame.current);
    tryOutMountFrame.current = null;
    tryOutOpenFrame.current = null;
    setTryOutOpen(false);
  }

  return (
    <div className="sandbox-stage">
      <div
        className={`product-window${phase === "private" ? " private-open" : ""}${switchStage === "out" ? " perspective-switching-out" : ""}${switchStage === "in" ? " perspective-switching-in" : ""}`}
        aria-label="Interactive Telaegent repository conversation demo"
      >
      <aside className="product-sidebar">
        <div className="product-brand">
          <img src={telaegentMark} alt="" />
          <span>Telaegent</span>
        </div>

        <div className="repository-summary">
          <span>Repository</span>
          <strong>{repository.name}</strong>
          <div className="repository-summary-actions">
            <small>{repository.members.length} people</small>
            <button className="sandbox-utility-button" type="button" onClick={switchRepository}>Switch repo</button>
          </div>
        </div>

        <div className="conversation-list">
          <p>People in this repository</p>
          {peers.map((id) => (
            <SandboxPerson
              key={id}
              id={id}
              selected={id === peerId}
              onSelect={() => selectPerson(id)}
            />
          ))}
        </div>

        <div
          className="provider-status"
          aria-label={`Current viewpoint: ${viewer.name}, ${viewer.provider} connected`}
        >
          <SandboxAvatar id={viewerId} className="viewpoint-avatar" />
          <span>
            <strong>{viewer.name}</strong>
            <small>Connected agent: {viewer.provider}</small>
          </span>
        </div>
      </aside>

      <section className="shared-conversation">
        <div className="mobile-scope-bar">
          <span>
            <small>Repository</small>
            <strong>{repository.shortName}</strong>
          </span>
          <button className="sandbox-utility-button" type="button" onClick={switchRepository}>Switch repo</button>
        </div>

        <div className="mobile-conversation-tabs" aria-label="People in this repository">
          {peers.map((id) => (
            <button
              key={id}
              className={id === peerId ? "selected" : ""}
              type="button"
              onClick={() => selectPerson(id)}
              aria-pressed={id === peerId}
            >
              {peopleById[id].name}
            </button>
          ))}
        </div>

        <header className="conversation-header">
          <div>
            <SandboxAvatar id={peerId} />
            <span>
              <strong>{peer.name}</strong>
              <small>{viewer.name}'s view · {activeConversation.topic}</small>
            </span>
          </div>
          <div className="conversation-meta">
            <span className="branch-name">{viewer.branch}</span>
            <button
              className="sandbox-utility-button"
              type="button"
              onClick={() => setRun((current) => current + 1)}
            >
              Replay
            </button>
          </div>
        </header>

        <div
          className="conversation-thread has-history"
          key={`${repository.id}-${viewerId}-${peerId}-${run}`}
        >
          <p className="conversation-date">Repository-scoped conversation</p>

          <div className="scope-note sandbox-entry sandbox-entry-context sandbox-entry-step-0">
            <span>Project scope</span>
            <strong>{repository.name}</strong>
            <small>{viewer.name}'s viewpoint</small>
          </div>

          <article className="message message-incoming message-history sandbox-entry sandbox-entry-step-1">
            <span className="message-author">{peer.name} · {peer.provider}</span>
            <p>{activeConversation.sharedContext}</p>
            <small>Approved by {peer.name} · {peer.branch}</small>
          </article>

          <article
            className={`message ${isReceivingTransfer ? "message-incoming message-received" : "message-outgoing message-pending"} sandbox-entry sandbox-entry-step-2`}
          >
            <span className="message-author">
              {isReceivingTransfer
                ? `${peer.name} · approved request`
                : `${viewer.name} · rough request`}
            </span>
            <p>{isReceivingTransfer ? transfer.content : activeSide.intent}</p>
            <small>
              {isReceivingTransfer
                ? `Received by ${viewer.name}`
                : phase === "sent"
                  ? `Sent to ${peer.name}`
                  : phase === "declined"
                    ? "Declined. Nothing was shared."
                    : "Not shared"}
            </small>
          </article>

          <div className="demo-phase-region sandbox-entry sandbox-entry-status sandbox-entry-step-3" aria-live="polite">
            <div
              className={`demo-phase-item${phase === "thinking" ? " active" : ""}`}
              aria-hidden={phase !== "thinking"}
              inert={phase !== "thinking"}
            >
              <div className="agent-thinking" role="status">
                <span>
                  {isReceivingTransfer
                    ? `${viewer.name}'s ${viewer.provider} is evaluating the request`
                    : `${viewer.name}'s ${viewer.provider} is preparing the request`}
                </span>
                <span className="typing-dots" aria-label="Working"><i /><i /><i /></span>
              </div>
            </div>

            <div
              className={`demo-phase-item${phase === "private" ? " active" : ""}`}
              aria-hidden={phase !== "private"}
              inert={phase !== "private"}
            >
              <p className="agent-state agent-state-ready">
                {isReceivingTransfer
                  ? `Private evaluation ready for ${viewer.name}`
                  : `Private question ready for ${viewer.name}`}
              </p>
            </div>

            <div
              className={`demo-phase-item${phase === "sent" || phase === "declined" ? " active" : ""}`}
              aria-hidden={phase !== "sent" && phase !== "declined"}
              inert={phase !== "sent" && phase !== "declined"}
            >
              <p className="direct-decision-result">
                {phase === "sent"
                  ? isReceivingTransfer
                    ? `Response sent to ${peer.name}.`
                    : `Sent to ${peer.name}.`
                  : "Declined. Nothing was shared."}
              </p>
            </div>
          </div>
        </div>

        <form className="message-composer" onSubmit={interceptSandboxSend}>
          <input
            aria-label="Sandbox message"
            type="text"
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            placeholder={`Ask ${peer.name} about ${repository.shortName}`}
          />
          <button type="submit">Ask agent</button>
        </form>
      </section>

      {tryOutMounted && (
        <div
          className={`sandbox-prompt-backdrop${tryOutOpen ? " open" : ""}`}
          role="presentation"
          onMouseDown={closeTryOut}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "opacity" && !tryOutOpen) {
              setTryOutMounted(false);
            }
          }}
        >
          <section
            className="sandbox-prompt"
            role="dialog"
            aria-modal="true"
            aria-hidden={!tryOutOpen}
            aria-labelledby="sandbox-prompt-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="sandbox-prompt-kicker">Sandbox preview</span>
            <h3 id="sandbox-prompt-title">Try it out</h3>
            <p>Open Telaegent to prepare a real repository-scoped message with your agent.</p>
            <div>
              <button type="button" onClick={closeTryOut}>Keep exploring</button>
              <button className="primary" type="button" onClick={onTryOut}>Open Telaegent</button>
            </div>
          </section>
        </div>
      )}

      <aside
        className="private-room"
        aria-hidden={phase !== "private"}
        aria-label={
          isReceivingTransfer
            ? `Private evaluation of ${peer.name}'s request by ${viewer.name}'s ${viewer.provider}`
            : `Private conversation between ${viewer.name} and ${viewer.provider}`
        }
      >
        <header className="private-room-header">
          <div>
            <strong>Message Preparation</strong>
            <small>
              {isReceivingTransfer
                ? `${viewer.name}'s ${viewer.provider} is evaluating ${peer.name}'s request privately.`
                : `Private with ${viewer.name}'s ${viewer.provider}. Not visible to ${peer.name}.`}
            </small>
          </div>
          <button
            className="sandbox-utility-button"
            type="button"
            onClick={() => setPhase("dismissed")}
            aria-label="Close private room"
          >
            Close
          </button>
        </header>

        <div className="private-context">
          <span>{repository.shortName}</span>
          <span>{viewer.branch}</span>
          <span>{isReceivingTransfer ? `from ${peer.name}` : `to ${peer.name}`}</span>
        </div>

        <div className="private-thread">
          <article className="private-message private-message-user private-entry private-entry-user">
            <span>{isReceivingTransfer ? `${peer.name} · received` : viewer.name}</span>
            <p>{isReceivingTransfer ? transfer?.content : activeSide.intent}</p>
          </article>

          <article className="private-message private-message-agent private-entry private-entry-agent">
            <div className="private-agent-heading">
              <span>{viewer.provider}</span>
              <small>{isReceivingTransfer ? "Evaluating request" : "Needs direction"}</small>
            </div>
            <p>
              {isReceivingTransfer
                ? `${peer.name} sent this request. What should I verify before preparing your response?`
                : privateSide.agentQuestion}
            </p>
            <p className="private-note">{privateSide.note}</p>
          </article>

          <div
            className="private-suggestions private-entry-actions"
            aria-label={isReceivingTransfer ? "Evaluation paths" : "Questions for the private agent"}
          >
            {privateSide.options.map((option, index) => (
              <button
                className={selectedOption === index ? "selected" : ""}
                type="button"
                key={option.label}
                onClick={() => setSelectedOption(index)}
              >
                <kbd>{index + 1}</kbd>
                <span>{option.label}</span>
                {selectedOption === index && <small aria-hidden="true">↵</small>}
              </button>
            ))}
          </div>

          {selectedAnswer && (
            <div className="private-answer-exchange" key={`${activeConversation.id}-${viewerId}-${selectedOption}`}>
              <article className="private-message private-message-user private-answer-entry">
                <span>{viewer.name}</span>
                <p>{selectedAnswer.label}</p>
              </article>
              <article className="private-message private-message-agent private-answer-entry private-answer-agent">
                <span>{viewer.provider}</span>
                <p>{selectedAnswer.answer}</p>
                <p className="private-note">Ready for {viewer.name} to review. Nothing has been sent yet.</p>
              </article>
            </div>
          )}
        </div>

        <div className="private-composer private-entry-actions">
          {selectedAnswer ? (
            <>
              <span>Review before sharing</span>
              <div className="private-composer-actions">
                <button type="button" onClick={() => setPhase("declined")}>Decline</button>
                <button className="send" type="button" onClick={sendPreparedMessage}>Send</button>
              </div>
            </>
          ) : (
            <span>Choose one question to continue</span>
          )}
        </div>
      </aside>
      </div>

      <button
        className="perspective-switch-edge"
        type="button"
        onClick={switchPerspective}
        disabled={phase !== "sent" || switchStage !== "idle"}
        aria-label={
          phase === "sent"
            ? `Switch to ${peer.name}'s perspective`
            : `Send the prepared request before switching to ${peer.name}'s perspective`
        }
        title={phase === "sent" ? `Switch to ${peer.name}` : "Send the prepared request to unlock"}
      >
        <span className="perspective-switch-glyph" aria-hidden="true">
          &gt;
        </span>
        <span className="perspective-switch-label">Move to {peer.name}&apos;s viewpoint</span>
      </button>
    </div>
  );
}
