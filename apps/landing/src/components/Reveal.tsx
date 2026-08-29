import { useEffect, useRef, type ReactNode } from "react";

/**
 * Fades a block in the first time it comes near the viewport.
 *
 * One shared, rAF-throttled scroll/resize pass drives every instance. That is
 * cheaper than one IntersectionObserver per block and — more importantly —
 * deterministic: content is never left invisible because an observer callback
 * did not arrive. A pending element is also shown on the next check even if no
 * scroll ever happens, so a short page still paints in full.
 */

type Pending = { node: HTMLElement; delay: number };

const pending = new Set<Pending>();
let scheduled = false;
let listening = false;

const TRIGGER_RATIO = 0.92;

function show(entry: Pending) {
  pending.delete(entry);
  if (entry.delay > 0) {
    window.setTimeout(() => entry.node.setAttribute("data-shown", "true"), entry.delay);
  } else {
    entry.node.setAttribute("data-shown", "true");
  }
}

function check() {
  scheduled = false;
  const limit = window.innerHeight * TRIGGER_RATIO;
  for (const entry of [...pending]) {
    if (entry.node.getBoundingClientRect().top < limit) show(entry);
  }
  if (pending.size === 0 && listening) {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    listening = false;
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(check);
}

function register(entry: Pending) {
  pending.add(entry);
  if (!listening) {
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    listening = true;
  }
  schedule();
}

export function Reveal({
  children,
  as: Tag = "div",
  className = "",
  delay = 0,
  id,
}: {
  children: ReactNode;
  as?: "div" | "section" | "li";
  className?: string;
  delay?: number;
  id?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (node.dataset.shown === "true") return;

    const entry: Pending = { node, delay };
    register(entry);
    return () => {
      pending.delete(entry);
    };
  }, [delay]);

  return (
    <Tag
      id={id}
      ref={ref as never}
      className={className ? `reveal ${className}` : "reveal"}
    >
      {children}
    </Tag>
  );
}
