/**
 * CONTEXT PATH POLICY — the deterministic gate in front of every file the
 * middleware will ever open.
 *
 * The ORDER of the steps below is the security property, not an implementation
 * detail: deny-by-name must happen before any path resolution, and resolution
 * must happen before any open. `.env` is refused at step 8, which is why the
 * filesystem port can be asserted never to have been called for it.
 *
 * Supported rule grammar — deliberately not a glob language (plan.md §3.3):
 *   exact file          src/auth/session.ts
 *   recursive prefix    src/auth/**
 *
 * Nothing in this file touches node:fs. Steps 1–8 are pure; steps 9–10 take
 * the filesystem port.
 */

import path from "node:path";
import { CONTEXT_LIMITS, type DenialCode } from "./contract.js";
import type { FileSystemPort } from "./ports.js";

/* ========================================================================== *
 * Result types
 * ========================================================================== */

export interface PolicyDenial {
  ok: false;
  code: DenialCode;
  /** Safe for the UI and the audit log. Never contains file content. */
  safeReason: string;
  /** The offending input, echoed back only when it is safe to display. */
  input: string;
}

export interface PolicyAllowed<T> {
  ok: true;
  value: T;
}

export type PolicyResult<T> = PolicyAllowed<T> | PolicyDenial;

const deny = (code: DenialCode, safeReason: string, input: string): PolicyDenial => ({
  ok: false,
  code,
  safeReason,
  input: input.length > 200 ? input.slice(0, 200) + "…" : input,
});

const allow = <T>(value: T): PolicyAllowed<T> => ({ ok: true, value });

/* ========================================================================== *
 * Always-deny vocabulary (step 8)
 * ========================================================================== */

/** Directory or file segments that are refused wherever they appear. */
const DENIED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".gcloud",
  ".codex",
  ".claude",
  "codex-home",
  "claude-home",
  ".telaegent-context",
]);

/** Substrings that make any segment a secret by convention. */
const SECRET_SUBSTRINGS = [
  "credential",
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "api-key",
];

/** Exact basenames that are always private key or credential material. */
const DENIED_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".htpasswd",
]);

/** Extensions that are always key or certificate material. */
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

/** Characters that would turn a rule into a glob language we do not implement. */
const UNSUPPORTED_GLOB_CHARS = ["?", "[", "]", "{", "}", "!", "+", "(", ")", "@"];

/* ========================================================================== *
 * Steps 1–8 — pure normalization and denial
 * ========================================================================== */

/**
 * Normalizes an untrusted relative path. Returns the canonical POSIX form or a
 * denial. Never touches the filesystem.
 */
export function normalizeCandidatePath(input: string): PolicyResult<string> {
  // 1. empty / NUL
  if (typeof input !== "string" || input.trim().length === 0) {
    return deny("FORBID_EMPTY_PATH", "The path is empty.", String(input));
  }
  if (input.includes("\0")) {
    return deny("FORBID_NUL_BYTE", "The path contains a NUL byte.", "<binary>");
  }

  // 2. separator normalization — both forms, before any comparison
  let working = input.replace(/\\/g, "/").trim();

  // 3. drive letters, UNC shares, POSIX absolute
  if (/^[a-zA-Z]:/.test(working)) {
    return deny("FORBID_DRIVE_OR_UNC", "Drive-qualified paths are not allowed.", input);
  }
  if (working.startsWith("//")) {
    return deny("FORBID_DRIVE_OR_UNC", "UNC paths are not allowed.", input);
  }
  if (working.startsWith("/")) {
    return deny("FORBID_ABSOLUTE_PATH", "Absolute paths are not allowed.", input);
  }

  // 4. benign leading "./" (repeated)
  while (working.startsWith("./")) {
    working = working.slice(2);
  }
  if (working.length === 0 || working === ".") {
    return deny("FORBID_EMPTY_PATH", "The path resolves to nothing.", input);
  }

  // 5. segment normalization — drop empty and "." segments, keep order
  const rawSegments = working.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") continue;
    segments.push(segment);
  }
  if (segments.length === 0) {
    return deny("FORBID_EMPTY_PATH", "The path resolves to nothing.", input);
  }

  // 6. traversal — after normalization, before resolution
  if (segments.includes("..")) {
    return deny("FORBID_TRAVERSAL", "Parent-directory traversal is not allowed.", input);
  }
  // Percent- and unicode-encoded traversal never becomes a path segment here,
  // but a literal "%2e%2e" segment is still refused as a suspicious name.
  if (segments.some((segment) => /%2e%2e|%252e/i.test(segment))) {
    return deny("FORBID_TRAVERSAL", "Encoded traversal is not allowed.", input);
  }

  return allow(segments.join("/"));
}

/**
 * Step 7 for concrete paths: a *file* path may not contain glob syntax at all.
 */
function rejectGlobSyntax(normalized: string, original: string): PolicyDenial | null {
  if (normalized.includes("*")) {
    return deny(
      "FORBID_UNSUPPORTED_GLOB",
      "Wildcards are only supported as a trailing `/**` on a rule.",
      original,
    );
  }
  for (const character of UNSUPPORTED_GLOB_CHARS) {
    if (normalized.includes(character)) {
      return deny(
        "FORBID_UNSUPPORTED_GLOB",
        "Only exact files and `directory/**` prefixes are supported.",
        original,
      );
    }
  }
  return null;
}

/**
 * Step 8. Applied to every segment, not only the basename, so
 * `config/secrets/db.ts` and `src/.ssh/notes.md` are both refused.
 */
export function checkAlwaysDenied(normalized: string): PolicyDenial | null {
  const segments = normalized.split("/");
  for (const segment of segments) {
    const lower = segment.toLowerCase();

    if (lower === ".env" || lower.startsWith(".env.")) {
      return deny("FORBID_ENV_FILES", "Environment files are never shareable.", normalized);
    }
    if (DENIED_SEGMENTS.has(lower)) {
      const code: DenialCode =
        lower === ".git"
          ? "FORBID_GIT_INTERNALS"
          : lower === ".codex" || lower === ".claude" || lower.endsWith("-home")
            ? "FORBID_PROVIDER_HOME"
            : "FORBID_SECRET_NAME";
      return deny(code, "`" + segment + "` is never shareable.", normalized);
    }
    if (DENIED_BASENAMES.has(lower)) {
      return deny(
        "FORBID_PRIVATE_KEY_FILE",
        "Private key or credential files are never shareable.",
        normalized,
      );
    }
    if (DENIED_EXTENSIONS.has(path.posix.extname(lower))) {
      return deny(
        "FORBID_PRIVATE_KEY_FILE",
        "Key and certificate files are never shareable.",
        normalized,
      );
    }
    for (const needle of SECRET_SUBSTRINGS) {
      if (lower.includes(needle)) {
        return deny(
          "FORBID_SECRET_NAME",
          "`" + segment + "` looks like credential material.",
          normalized,
        );
      }
    }
  }
  return null;
}

/** Full pure pipeline for a concrete file path: steps 1–8. */
export function normalizeSourcePath(input: string): PolicyResult<string> {
  const normalized = normalizeCandidatePath(input);
  if (!normalized.ok) return normalized;

  const glob = rejectGlobSyntax(normalized.value, input);
  if (glob) return glob;

  const denied = checkAlwaysDenied(normalized.value);
  if (denied) return denied;

  return allow(normalized.value);
}

/* ========================================================================== *
 * Rules
 * ========================================================================== */

export interface NormalizedRule {
  /** Canonical text, e.g. `src/auth/**` or `docs/architecture/auth.md`. */
  raw: string;
  kind: "exact" | "prefix";
  /** For a prefix rule, the directory without the trailing `/**`. */
  value: string;
}

/** Normalizes one approved path rule. Same steps, plus the `/**` affordance. */
export function normalizeRule(input: string): PolicyResult<NormalizedRule> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return deny("FORBID_EMPTY_PATH", "The rule is empty.", String(input));
  }

  const trimmed = input.replace(/\\/g, "/").trim();
  const isPrefix = trimmed.endsWith("/**");
  const body = isPrefix ? trimmed.slice(0, -3) : trimmed;

  if (isPrefix && body.length === 0) {
    return deny(
      "FORBID_UNSUPPORTED_GLOB",
      "A bare `**` rule would approve the whole workspace.",
      input,
    );
  }

  const normalized = normalizeCandidatePath(body);
  if (!normalized.ok) return normalized;

  const glob = rejectGlobSyntax(normalized.value, input);
  if (glob) return glob;

  const denied = checkAlwaysDenied(normalized.value);
  if (denied) return denied;

  return allow({
    raw: isPrefix ? normalized.value + "/**" : normalized.value,
    kind: isPrefix ? "prefix" : "exact",
    value: normalized.value,
  });
}

/**
 * Normalizes a rule set for CONTEXT APPROVAL and enforces the approval count
 * limit. Ownership rules from an agreement are not context approvals and are
 * not capped at five — use `normalizeRuleList` for those.
 */
export function normalizeRuleSet(inputs: readonly string[]): PolicyResult<NormalizedRule[]> {
  if (inputs.length === 0) {
    return deny("FORBID_UNAPPROVED_PATH", "No path rules were approved.", "");
  }
  if (inputs.length > CONTEXT_LIMITS.maxApprovedRules) {
    return deny(
      "LIMIT_TOO_MANY_RULES",
      "At most " + CONTEXT_LIMITS.maxApprovedRules + " path rules may be approved.",
      String(inputs.length),
    );
  }
  return normalizeRuleList(inputs);
}

/**
 * Same grammar and same denials, no approval-count limit. Used for ownership
 * scopes, which describe who may edit what and are not a disclosure budget.
 */
export function normalizeRuleList(inputs: readonly string[]): PolicyResult<NormalizedRule[]> {
  const rules: NormalizedRule[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const rule = normalizeRule(input);
    if (!rule.ok) return rule;
    if (seen.has(rule.value.raw)) continue;
    seen.add(rule.value.raw);
    rules.push(rule.value);
  }
  return allow(rules);
}

/** Exact membership against the approved rule set. No fuzzy matching. */
export function matchesRules(
  normalizedPath: string,
  rules: readonly NormalizedRule[],
): boolean {
  for (const rule of rules) {
    if (rule.kind === "exact") {
      if (rule.value === normalizedPath) return true;
    } else if (normalizedPath.startsWith(rule.value + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Steps 1–8 plus approval membership. Still no filesystem access — this is the
 * check that refuses `.env` *before* anything is opened.
 */
export function authorizeSourcePath(
  input: string,
  rules: readonly NormalizedRule[],
): PolicyResult<string> {
  const normalized = normalizeSourcePath(input);
  if (!normalized.ok) return normalized;
  if (!matchesRules(normalized.value, rules)) {
    return deny(
      "FORBID_UNAPPROVED_PATH",
      "The path is outside every approved rule.",
      normalized.value,
    );
  }
  return allow(normalized.value);
}

/* ========================================================================== *
 * Steps 9–10 — resolution against the real workspace
 * ========================================================================== */

export interface ResolvedSourceFile {
  /** Workspace-relative POSIX path. */
  relativePath: string;
  /** Absolute path, proven to be inside the canonical workspace root. */
  absolutePath: string;
  bytes: number;
}

/**
 * Joins to the canonical workspace root and refuses escapes. Symlinks are
 * refused outright: an escaping link is FORBID_SYMLINK_ESCAPE, a link that
 * stays inside is still not a regular file and is not copied.
 */
export async function resolveInsideWorkspace(
  relativePath: string,
  canonicalRoot: string,
  fs: FileSystemPort,
): Promise<PolicyResult<ResolvedSourceFile>> {
  const absolutePath = path.resolve(canonicalRoot, relativePath);

  // Belt and braces: even after step 6, prove the join stayed inside.
  if (!isInside(canonicalRoot, absolutePath)) {
    return deny("FORBID_OUTSIDE_WORKSPACE", "The path leaves the workspace.", relativePath);
  }

  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch {
    return deny("FORBID_UNAPPROVED_PATH", "The path does not exist.", relativePath);
  }

  if (stats.isSymbolicLink) {
    let target: string;
    try {
      target = await fs.realpath(absolutePath);
    } catch {
      return deny("FORBID_SYMLINK_ESCAPE", "The link target cannot be resolved.", relativePath);
    }
    if (!isInside(canonicalRoot, target)) {
      return deny(
        "FORBID_SYMLINK_ESCAPE",
        "The link resolves outside the workspace.",
        relativePath,
      );
    }
    return deny(
      "FORBID_NOT_REGULAR_FILE",
      "Symbolic links are not copied into context.",
      relativePath,
    );
  }

  if (!stats.isFile) {
    return deny("FORBID_NOT_REGULAR_FILE", "Only regular files can be shared.", relativePath);
  }

  // A symlinked *directory* mid-path would not be caught by lstat on the file.
  let realParent: string;
  try {
    realParent = await fs.realpath(path.dirname(absolutePath));
  } catch {
    return deny("FORBID_OUTSIDE_WORKSPACE", "The parent cannot be resolved.", relativePath);
  }
  if (!isInside(canonicalRoot, realParent) && realParent !== canonicalRoot) {
    return deny(
      "FORBID_SYMLINK_ESCAPE",
      "A directory on the path resolves outside the workspace.",
      relativePath,
    );
  }

  if (stats.size > CONTEXT_LIMITS.maxBytesPerFile) {
    return deny(
      "LIMIT_FILE_TOO_LARGE",
      "The file exceeds " + CONTEXT_LIMITS.maxBytesPerFile + " bytes.",
      relativePath,
    );
  }

  return allow({ relativePath, absolutePath, bytes: stats.size });
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/* ========================================================================== *
 * Enumeration of the approved set
 * ========================================================================== */

export interface EnumeratedSources {
  files: ResolvedSourceFile[];
  totalBytes: number;
  /** Paths that were skipped, with the rule that skipped them. */
  skipped: Array<{ path: string; code: DenialCode }>;
}

/**
 * Walks the approved rules and returns the concrete files that survive every
 * check. Denied names are never opened, never stat-ed by readFile, and never
 * copied — they are eliminated at step 8 while still strings.
 */
export async function enumerateApprovedSources(
  rules: readonly NormalizedRule[],
  canonicalRoot: string,
  fs: FileSystemPort,
): Promise<PolicyResult<EnumeratedSources>> {
  const files: ResolvedSourceFile[] = [];
  const skipped: EnumeratedSources["skipped"] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const consider = async (relativePath: string): Promise<PolicyDenial | null> => {
    if (seen.has(relativePath)) return null;
    seen.add(relativePath);

    const authorized = authorizeSourcePath(relativePath, rules);
    if (!authorized.ok) {
      skipped.push({ path: relativePath, code: authorized.code });
      return null;
    }
    const resolved = await resolveInsideWorkspace(authorized.value, canonicalRoot, fs);
    if (!resolved.ok) {
      if (
        resolved.code === "FORBID_SYMLINK_ESCAPE" ||
        resolved.code === "FORBID_OUTSIDE_WORKSPACE"
      ) {
        return resolved; // hard failure: something is actively wrong
      }
      skipped.push({ path: relativePath, code: resolved.code });
      return null;
    }
    if (files.length >= CONTEXT_LIMITS.maxSourceFiles) {
      return deny(
        "LIMIT_TOO_MANY_FILES",
        "At most " + CONTEXT_LIMITS.maxSourceFiles + " source files may be shared.",
        relativePath,
      );
    }
    if (totalBytes + resolved.value.bytes > CONTEXT_LIMITS.maxTotalSourceBytes) {
      return deny(
        "LIMIT_TOTAL_TOO_LARGE",
        "The approved sources exceed " +
          CONTEXT_LIMITS.maxTotalSourceBytes +
          " bytes in total.",
        relativePath,
      );
    }
    totalBytes += resolved.value.bytes;
    files.push(resolved.value);
    return null;
  };

  const walk = async (relativeDir: string, depth: number): Promise<PolicyDenial | null> => {
    if (depth > 12) return null;
    const absoluteDir = path.resolve(canonicalRoot, relativeDir);
    let entries: string[];
    try {
      entries = await fs.readDir(absoluteDir);
    } catch {
      return null;
    }
    for (const entry of entries.sort()) {
      const childRelative = relativeDir ? relativeDir + "/" + entry : entry;
      // Step 8 runs on the name before we ever stat it.
      if (checkAlwaysDenied(childRelative)) continue;

      const absoluteChild = path.resolve(canonicalRoot, childRelative);
      let stats;
      try {
        stats = await fs.lstat(absoluteChild);
      } catch {
        continue;
      }
      if (stats.isDirectory) {
        const failure = await walk(childRelative, depth + 1);
        if (failure) return failure;
      } else {
        const failure = await consider(childRelative);
        if (failure) return failure;
      }
    }
    return null;
  };

  for (const rule of rules) {
    const failure =
      rule.kind === "exact" ? await consider(rule.value) : await walk(rule.value, 0);
    if (failure) return failure;
  }

  if (files.length === 0) {
    return deny(
      "FORBID_UNAPPROVED_PATH",
      "No readable file matched the approved rules.",
      "",
    );
  }

  return allow({ files, totalBytes, skipped });
}
