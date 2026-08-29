import path from "node:path";
import { isSafeRelativePath, normalizeProtocolPath } from "./schemas.js";
import type { ConflictAssessment, ConflictSignal } from "./types.js";

export interface ConflictIntentView {
  intentId: string;
  plannedFiles: string[];
  changedFiles: string[];
  interfaces: string[];
  baseCommit: string;
}

export class InvalidConflictInputError extends Error {
  readonly code = "INVALID_REQUEST" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidConflictInputError";
  }
}

type FilePresence = { planned: boolean; changed: boolean };

function normalizedFileMap(intent: ConflictIntentView): Map<string, FilePresence> {
  const result = new Map<string, FilePresence>();
  const add = (rawPath: string, kind: keyof FilePresence): void => {
    if (!isSafeRelativePath(rawPath)) {
      throw new InvalidConflictInputError(
        `Intent ${intent.intentId} contains an invalid relative path`,
      );
    }
    const normalized = normalizeProtocolPath(rawPath);
    const current = result.get(normalized) ?? { planned: false, changed: false };
    current[kind] = true;
    result.set(normalized, current);
  };
  for (const file of intent.plannedFiles) add(file, "planned");
  for (const file of intent.changedFiles) add(file, "changed");
  return result;
}

function exactFileSignal(
  file: string,
  left: FilePresence,
  right: FilePresence,
): ConflictSignal | null {
  if (left.changed && right.changed) {
    return { type: "changed_file", value: file, score: 5 };
  }
  if ((left.planned && right.changed) || (left.changed && right.planned)) {
    return { type: "planned_changed", value: file, score: 4 };
  }
  if (left.planned && right.planned) {
    return { type: "planned_file", value: file, score: 3 };
  }
  return null;
}

function immediateModule(file: string): string | null {
  const directory = path.posix.dirname(file);
  return directory === "." ? null : directory;
}

function normalizeInterface(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

const signalOrder: Record<ConflictSignal["type"], number> = {
  changed_file: 0,
  planned_changed: 1,
  interface: 2,
  planned_file: 3,
  module: 4,
  base_commit: 5,
};

export function assessConflict(
  leftIntent: ConflictIntentView,
  rightIntent: ConflictIntentView,
): ConflictAssessment {
  if (leftIntent.intentId === rightIntent.intentId) {
    throw new InvalidConflictInputError("An intent cannot be compared with itself");
  }

  const leftFiles = normalizedFileMap(leftIntent);
  const rightFiles = normalizedFileMap(rightIntent);
  const signals: ConflictSignal[] = [];

  for (const [file, leftPresence] of leftFiles) {
    const rightPresence = rightFiles.get(file);
    if (!rightPresence) continue;
    const signal = exactFileSignal(file, leftPresence, rightPresence);
    if (signal) signals.push(signal);
  }

  const leftInterfaces = new Set(
    leftIntent.interfaces.map(normalizeInterface).filter((value) => value.length > 0),
  );
  const rightInterfaces = new Set(
    rightIntent.interfaces.map(normalizeInterface).filter((value) => value.length > 0),
  );
  for (const interfaceName of leftInterfaces) {
    if (rightInterfaces.has(interfaceName)) {
      signals.push({ type: "interface", value: interfaceName, score: 4 });
    }
  }

  const sharedModules = new Set<string>();
  for (const leftFile of leftFiles.keys()) {
    const leftModule = immediateModule(leftFile);
    if (!leftModule) continue;
    for (const rightFile of rightFiles.keys()) {
      if (leftFile === rightFile) continue;
      if (leftModule === immediateModule(rightFile)) sharedModules.add(leftModule);
    }
  }
  for (const moduleName of sharedModules) {
    signals.push({ type: "module", value: moduleName, score: 1 });
  }

  if (
    leftIntent.baseCommit.length > 0 &&
    rightIntent.baseCommit.length > 0 &&
    leftIntent.baseCommit.toLocaleLowerCase("en-US") !==
      rightIntent.baseCommit.toLocaleLowerCase("en-US")
  ) {
    signals.push({
      type: "base_commit",
      value: `${leftIntent.baseCommit}..${rightIntent.baseCommit}`,
      score: 1,
    });
  }

  signals.sort(
    (left, right) =>
      signalOrder[left.type] - signalOrder[right.type] ||
      left.value.localeCompare(right.value, "en-US"),
  );
  const score = signals.reduce((total, signal) => total + signal.score, 0);
  return {
    score,
    level: score >= 5 ? "blocking" : score >= 3 ? "suggested" : "none",
    signals,
  };
}
