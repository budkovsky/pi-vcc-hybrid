import type { NormalizedBlock, ToolResultIndex } from "../types";
import { extractPath } from "../core/tool-args";
import { clip } from "../core/content";

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "View",
]);

// Match exported declarations: functions, classes, types, interfaces, constants, enums
const EXPORT_DECL_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|type|interface|const|let|enum)\s+(\w+)/;

// Match non-exported declarations that are still significant (class, function at top level)
const DECL_RE =
  /^\s*(?:async\s+)?(?:function|class)\s+(\w+)/;

// Match type/interface even without export (they're often the API surface)
const TYPE_DECL_RE =
  /^\s*(?:export\s+)?(?:type|interface)\s+(\w+)/;

// Match Python definitions
const PY_DECL_RE =
  /^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)/;

// Match Go declarations
const GO_DECL_RE =
  /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/;

export interface SymbolRef {
  name: string;
  file: string;
  kind: "function" | "type" | "class" | "variable" | "unknown";
  access: "modified" | "read";
}

const parseDeclarationLine = (line: string): { name: string; kind: SymbolRef["kind"] } | null => {
  let m = line.match(EXPORT_DECL_RE);
  if (m) {
    const kind = line.includes("function") ? "function"
      : line.includes("class") ? "class"
      : line.includes("type") ? "type"
      : line.includes("interface") ? "type"
      : line.includes("enum") ? "variable"
      : "variable";
    return { name: m[1], kind };
  }

  m = line.match(TYPE_DECL_RE);
  if (m) return { name: m[1], kind: "type" };

  m = line.match(PY_DECL_RE);
  if (m) return { name: m[1] || m[2], kind: m[2] ? "class" : "function" };

  m = line.match(GO_DECL_RE);
  // Go: only include exported (uppercase first char) functions
  if (m && m[1][0] === m[1][0].toUpperCase()) return { name: m[1], kind: "function" };

  return null;
};

/** Extract symbols from text content of a file (from Read results or Edit newText) */
const extractSymbolsFromContent = (content: string, filePath: string, access: "modified" | "read"): SymbolRef[] => {
  const refs: SymbolRef[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");

  for (const line of lines) {
    const decl = parseDeclarationLine(line);
    if (!decl) continue;
    const key = `${decl.name}@${filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ name: decl.name, file: filePath, kind: decl.kind, access });
  }

  return refs;
};

// Try to get file content from tool_result blocks that follow a Read/Edit/Write call.
// Returns the text content if available.
const findToolResult = (blocks: NormalizedBlock[], callIndex: number, tri?: ToolResultIndex): Extract<NormalizedBlock, { kind: "tool_result" }> | null => {
  if (tri) return tri.get(callIndex);
  for (let i = callIndex + 1; i < Math.min(blocks.length, callIndex + 3); i++) {
    const b = blocks[i];
    if (b.kind === "tool_result") return b as Extract<NormalizedBlock, { kind: "tool_result" }>;
  }
  return null;
};

export const extractSymbolChanges = (blocks: NormalizedBlock[], tri?: ToolResultIndex): SymbolRef[] => {
  const refs: SymbolRef[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call") continue;

    const filePath = extractPath(b.args);
    if (!filePath) continue;

    const isWrite = FILE_WRITE_TOOLS.has(b.name);
    const isRead = FILE_READ_TOOLS.has(b.name);
    if (!isWrite && !isRead) continue;

    const access = isWrite ? "modified" as const : "read" as const;

    // Source 1: Parse Edit/Write args for new/changed declarations
    if (isWrite) {
      const newText = (b.args.newText ?? b.args.new_text ?? b.args.content ?? "") as string;
      if (newText && typeof newText === "string") {
        const syms = extractSymbolsFromContent(newText, filePath, access);
        for (const s of syms) {
          const key = `${s.name}@${s.file}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push(s);
          }
        }
      }
    }

    // Source 2: Parse Read/Edit tool_result for exported declarations
    if (isRead || isWrite) {
      const result = findToolResult(blocks, i, tri);
      if (result && result.text && !result.isError) {
        const capped = result.text.split("\n").slice(0, 300).join("\n");
        const syms = extractSymbolsFromContent(capped, filePath, access);
        for (const s of syms) {
          const key = `${s.name}@${s.file}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push(s);
          }
        }
      }
    }
  }

  return refs;
};

/** Format symbol changes for display, grouped by file */
const formatSymbolChanges = (symbols: SymbolRef[], limit = 15): string[] => {
  if (symbols.length === 0) return [];

  const byFile = new Map<string, SymbolRef[]>();
  for (const s of symbols) {
    if (!byFile.has(s.file)) byFile.set(s.file, []);
    byFile.get(s.file)!.push(s);
  }

  const lines: string[] = [];
  let count = 0;
  for (const [file, syms] of byFile) {
    if (count >= limit) {
      lines.push(`(+${symbols.length - count} more symbols)`);
      break;
    }
    const names = syms.map((s) => {
      const tag = s.kind === "function" ? "()" : s.kind === "type" ? "" : "";
      const accessTag = s.access === "modified" ? "*" : "";
      return `${accessTag}${s.name}${tag}`;
    });
    lines.push(`${file}: ${names.join(", ")}`);
    count++;
  }

  return lines;
};
