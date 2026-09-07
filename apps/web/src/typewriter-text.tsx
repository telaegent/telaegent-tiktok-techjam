import { useEffect, useMemo, useRef, useState } from "react";

const MIN_DURATION_MS = 360;
const MAX_DURATION_MS = 2_400;
const MILLISECONDS_PER_CHARACTER = 18;

export function splitTypewriterText(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      ({ segment }) => segment,
    );
  }
  return Array.from(value);
}

export function typewriterDurationMs(characterCount: number): number {
  if (characterCount <= 0) return 0;
  return Math.min(
    MAX_DURATION_MS,
    Math.max(MIN_DURATION_MS, characterCount * MILLISECONDS_PER_CHARACTER),
  );
}

export function typewriterVisibleCount(
  elapsedMs: number,
  durationMs: number,
  characterCount: number,
): number {
  if (characterCount <= 0) return 0;
  if (durationMs <= 0 || elapsedMs >= durationMs) return characterCount;
  return Math.min(
    characterCount,
    Math.max(0, Math.ceil((elapsedMs / durationMs) * characterCount)),
  );
}

export default function TypewriterText({
  text,
  animate,
}: {
  text: string;
  animate: boolean;
}) {
  const characters = useMemo(() => splitTypewriterText(text), [text]);
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const shouldAnimate = animate && !reduceMotion && characters.length > 0;
  const [visibleCount, setVisibleCount] = useState(() =>
    shouldAnimate ? 0 : characters.length,
  );
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    if (!shouldAnimate) {
      setVisibleCount(characters.length);
      return;
    }

    setVisibleCount(0);
    const duration = typewriterDurationMs(characters.length);
    const startedAt = window.performance.now();
    const reveal = (now: number) => {
      const nextCount = typewriterVisibleCount(
        now - startedAt,
        duration,
        characters.length,
      );
      setVisibleCount(nextCount);
      if (nextCount < characters.length) {
        frame.current = window.requestAnimationFrame(reveal);
      } else {
        frame.current = null;
      }
    };
    frame.current = window.requestAnimationFrame(reveal);

    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [characters, shouldAnimate]);

  if (!shouldAnimate) return <>{text}</>;

  return (
    <span className="typewriter-text">
      <span className="app-sr-only">{text}</span>
      <span
        className={
          visibleCount < characters.length ? "typewriter-reveal is-typing" : "typewriter-reveal"
        }
        aria-hidden="true"
      >
        {characters.slice(0, visibleCount).join("")}
      </span>
    </span>
  );
}
