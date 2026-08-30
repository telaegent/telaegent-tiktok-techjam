/**
 * In-memory filesystem port with a call log.
 *
 * Its whole reason to exist is the assertion in hien.md §6: that the read/copy
 * helper is never called for a pre-denied path. `calls.readFile` and
 * `calls.copyFile` are what the `.env` test inspects (finding C7).
 */

import path from "node:path";
import type { FileSystemPort, PortFileStat } from "../ports.js";

type MemoryNode =
  | { kind: "file"; content: string }
  | { kind: "dir" }
  | { kind: "symlink"; target: string };

export interface MemoryFileSystem extends FileSystemPort {
  /** Every port method call, in order, with its first argument. */
  calls: Array<{ method: string; arg: string }>;
  callsTo(method: keyof FileSystemPort): string[];
  addFile(absolutePath: string, content: string): void;
  addDir(absolutePath: string): void;
  addSymlink(absolutePath: string, target: string): void;
  read(absolutePath: string): string | undefined;
  list(): string[];
}

const normalize = (candidate: string): string => path.resolve(candidate);

export function createMemoryFileSystem(
  seed: Record<string, string> = {},
): MemoryFileSystem {
  const nodes = new Map<string, MemoryNode>();
  const calls: Array<{ method: string; arg: string }> = [];
  let tempCounter = 0;

  const ensureDirs = (absolutePath: string): void => {
    let current = path.dirname(normalize(absolutePath));
    const roots: string[] = [];
    while (current !== path.dirname(current)) {
      roots.unshift(current);
      current = path.dirname(current);
    }
    roots.unshift(current);
    for (const dir of roots) {
      if (!nodes.has(dir)) nodes.set(dir, { kind: "dir" });
    }
  };

  const addFile = (absolutePath: string, content: string): void => {
    const target = normalize(absolutePath);
    ensureDirs(target);
    nodes.set(target, { kind: "file", content });
  };

  const addDir = (absolutePath: string): void => {
    const target = normalize(absolutePath);
    ensureDirs(path.join(target, "x"));
    nodes.set(target, { kind: "dir" });
  };

  const addSymlink = (absolutePath: string, linkTarget: string): void => {
    const target = normalize(absolutePath);
    ensureDirs(target);
    nodes.set(target, { kind: "symlink", target: normalize(linkTarget) });
  };

  /** Resolves symlinks segment by segment, like realpath(3). */
  const resolveReal = (absolutePath: string, hops = 0): string => {
    if (hops > 16) throw new Error("ELOOP");
    const target = normalize(absolutePath);
    const parent = path.dirname(target);
    const realParent = parent === target ? parent : resolveReal(parent, hops + 1);
    const candidate = path.join(realParent, path.basename(target));
    const node = nodes.get(candidate);
    if (!node) {
      if (candidate === path.parse(candidate).root) return candidate;
      throw Object.assign(new Error("ENOENT: " + candidate), { code: "ENOENT" });
    }
    if (node.kind === "symlink") return resolveReal(node.target, hops + 1);
    return candidate;
  };

  for (const [key, value] of Object.entries(seed)) addFile(key, value);

  const record = (method: string, arg: string): void => {
    calls.push({ method, arg: normalize(arg) });
  };

  return {
    calls,
    callsTo(method) {
      return calls.filter((entry) => entry.method === method).map((entry) => entry.arg);
    },
    addFile,
    addDir,
    addSymlink,
    read(absolutePath) {
      const node = nodes.get(normalize(absolutePath));
      return node && node.kind === "file" ? node.content : undefined;
    },
    list() {
      return [...nodes.keys()].sort();
    },

    async lstat(absolutePath): Promise<PortFileStat> {
      record("lstat", absolutePath);
      const node = nodes.get(normalize(absolutePath));
      if (!node) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return {
        size: node.kind === "file" ? Buffer.byteLength(node.content, "utf8") : 0,
        isFile: node.kind === "file",
        isDirectory: node.kind === "dir",
        isSymbolicLink: node.kind === "symlink",
      };
    },

    async realpath(absolutePath) {
      record("realpath", absolutePath);
      return resolveReal(absolutePath);
    },

    async readDir(absolutePath) {
      record("readDir", absolutePath);
      const prefix = normalize(absolutePath);
      const children = new Set<string>();
      for (const key of nodes.keys()) {
        if (key === prefix) continue;
        if (path.dirname(key) === prefix) children.add(path.basename(key));
      }
      return [...children];
    },

    async readFile(absolutePath) {
      record("readFile", absolutePath);
      const node = nodes.get(resolveReal(absolutePath));
      if (!node || node.kind !== "file") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return Buffer.from(node.content, "utf8");
    },

    async copyFile(from, to) {
      record("copyFile", from);
      const node = nodes.get(resolveReal(from));
      if (!node || node.kind !== "file") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      addFile(to, node.content);
    },

    async mkdir(absolutePath) {
      record("mkdir", absolutePath);
      addDir(absolutePath);
    },

    async mkdtemp(prefix) {
      record("mkdtemp", prefix);
      tempCounter += 1;
      // Normalised, like every other method here. mkdtemp used to return the
      // raw concatenation while `list()` returns path.resolve()d keys, so on
      // Windows the returned root ("\\tmp\\...", no drive) never matched the
      // stored keys ("C:\\tmp\\...") and callers filtering by prefix saw nothing.
      const created = normalize(prefix + "abc" + String(tempCounter).padStart(3, "0"));
      addDir(created);
      return created;
    },

    async writeFile(absolutePath, data) {
      record("writeFile", absolutePath);
      addFile(absolutePath, data);
    },

    async removeTree(absolutePath) {
      record("removeTree", absolutePath);
      if (!path.isAbsolute(absolutePath)) throw new Error("removeTree needs an absolute path");
      const prefix = normalize(absolutePath);
      for (const key of [...nodes.keys()]) {
        if (key === prefix || key.startsWith(prefix + path.sep)) nodes.delete(key);
      }
    },

    async exists(absolutePath) {
      record("exists", absolutePath);
      return nodes.has(normalize(absolutePath));
    },
  };
}
