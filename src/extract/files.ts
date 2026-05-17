import type { NormalizedBlock } from "../types";
import { extractPath } from "../core/tool-args";
import { clip } from "../core/content";

const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "View",
]);

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const FILE_CREATE_TOOLS = new Set([
  "Write", "write", "write_file",
]);

// ── Language-specific declaration regexes ──
//
// Order matters: more specific patterns first, generic fallbacks last.

// TypeScript / JavaScript
const EXPORT_DECL_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|type|interface|const|let|enum)\s+(\w+)/;

const TYPE_DECL_RE =
  /^\s*(?:export\s+)?(?:type|interface)\s+(\w+)/;

// Rust — pub fn, pub struct, pub enum, pub trait, pub type, pub const, pub union
const RUST_DECL_RE =
  /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:fn|struct|enum|trait|type|const|union)\s+(\w+)/;

// Rust — impl Trait for Type / impl Type
const RUST_IMPL_RE =
  /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?impl\s+(?:<[^>]+>\s+)?(\w+)(?:\s+for\s+(\w+))?/;

// Java / Kotlin / C# — class, interface, enum, record
const JAVA_TYPE_RE =
  /^\s*(?:(?:public|private|protected)\s+)?(?:abstract\s+|static\s+|final\s+|sealed\s+)?(?:class|interface|enum|@interface|record)\s+(\w+)/;

// Java / Kotlin / C# — public/protected method (returnType methodName())
const JAVA_METHOD_RE =
  /^\s*(?:public|protected)\s+(?:static\s+|abstract\s+|final\s+)?(?:\S+(?:\s*\[\])?\s+)(\w+)\s*\(/;

// C / C++ — struct, class, enum, union, typedef
const C_TYPE_RE =
  /^\s*(?:typedef\s+)?(?:struct|class|enum|union)\s+(\w+)/;

// C / C++ — function (returnType name() at line start)
const C_FUNC_RE =
  /^\s*(?:(?:static|extern|inline|virtual)\s+)?(?:\w+(?:\s*[*&]+\s*)?)+(\w+)\s*\(/;

// Python
const PY_DECL_RE =
  /^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)/;

// Go — exported functions only (uppercase first char)
const GO_DECL_RE =
  /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/;

/**
 * Parse a single line of source code to extract a declaration name.
 * Tries language-specific regexes in priority order.
 */
const parseDeclName = (line: string): string | null => {
  // TypeScript / JavaScript
  let m = line.match(EXPORT_DECL_RE);
  if (m) return m[1];
  m = line.match(TYPE_DECL_RE);
  if (m) return m[1];

  // Rust
  m = line.match(RUST_DECL_RE);
  if (m) return m[1];
  m = line.match(RUST_IMPL_RE);
  if (m) return m[1];

  // Java / Kotlin / C# (types before methods to avoid 'class' being caught as a method)
  m = line.match(JAVA_TYPE_RE);
  if (m) return m[1];
  m = line.match(JAVA_METHOD_RE);
  if (m) return m[1];

  // C / C++
  m = line.match(C_TYPE_RE);
  if (m) return m[1];
  m = line.match(C_FUNC_RE);
  if (m) return m[1];

  // Python
  m = line.match(PY_DECL_RE);
  if (m) return m[1] || m[2];

  // Go — only include exported (uppercase first char)
  m = line.match(GO_DECL_RE);
  if (m && m[1][0] === m[1][0].toUpperCase()) return m[1];

  return null;
};

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
  symbols: Map<string, string[]>; // filePath -> [symbol names]
}

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};

const trimMapKeys = (map: Map<string, string[]>, prefix: string): Map<string, string[]> => {
  if (!prefix) return map;
  const out = new Map<string, string[]>();
  for (const [k, v] of map) {
    out.set(k.startsWith(prefix) ? k.slice(prefix.length) : k, v);
  }
  return out;
};

// Extract exported symbol names from tool results that follow a Read/Edit/Write call
const extractSymbolsFromResult = (blocks: NormalizedBlock[], callIndex: number): string[] => {
  let resultText: string | null = null;
  for (let j = callIndex + 1; j < Math.min(blocks.length, callIndex + 3); j++) {
    const r = blocks[j];
    if (r.kind === "tool_result") {
      if (r.text && !r.isError) resultText = r.text;
      break;
    }
  }
  if (!resultText) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  const lines = resultText.split("\n").slice(0, 200);
  for (const line of lines) {
    const name = parseDeclName(line);
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
};

// Extract symbols from Edit newText/Write content args
const extractSymbolsFromArgs = (args: Record<string, unknown>): string[] => {
  const newText = (args.newText ?? args.new_text ?? args.content ?? "") as string;
  if (!newText || typeof newText !== "string") return [];

  const names: string[] = [];
  const seen = new Set<string>();
  const lines = newText.split("\n").slice(0, 100);
  for (const line of lines) {
    const name = parseDeclName(line);
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
};

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
): FileActivity => {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
    symbols: new Map(),
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;

    const isRead = FILE_READ_TOOLS.has(b.name);
    const isWrite = FILE_WRITE_TOOLS.has(b.name);
    const isCreate = FILE_CREATE_TOOLS.has(b.name);

    if (isRead) act.read.add(p);
    if (isWrite) act.modified.add(p);
    if (isCreate) act.created.add(p);

    // Extract symbols for modified and read files
    if (isRead || isWrite) {
      if (!act.symbols.has(p)) act.symbols.set(p, []);

      // From Edit/Write args
      if (isWrite) {
        const fromArgs = extractSymbolsFromArgs(b.args);
        const existing = act.symbols.get(p)!;
        for (const name of fromArgs) {
          if (!existing.includes(name)) existing.push(name);
        }
      }

      // From Read/Edit tool results
      const fromResult = extractSymbolsFromResult(blocks, i);
      const existing = act.symbols.get(p)!;
      for (const name of fromResult) {
        if (!existing.includes(name)) existing.push(name);
      }
    }
  }

  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
    act.symbols = trimMapKeys(act.symbols, prefix);
  }

  return act;
};
