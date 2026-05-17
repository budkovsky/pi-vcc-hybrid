import type { NormalizedBlock } from "../types";
import { extractPath } from "../core/tool-args";
import { clip } from "../core/content";

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "View",
]);

// Match exported TypeScript/JavaScript declarations with their full signature line
const TS_EXPORT_SIG_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|type|interface|const|let|enum)\s+\w+[^;{]*[;{]?/;

// Match Python class/def with signature
const PY_SIG_RE =
  /^\s*(?:async\s+)?(?:def|class)\s+\w+\s*(?:\([^)]*\))?/;

// Match Go func signature
const GO_SIG_RE =
  /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?\w+\s*(?:\([^)]*\))?\s*(?:\([^)]*\))?/;

// Match Rust pub fn/struct/enum/trait
const RUST_SIG_RE =
  /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+\w+/;

// Max lines to scan from a file for signatures
const MAX_SCAN_LINES = 150;

// Max total signature length
const MAX_SIG_LEN = 120;

export interface ExportSig {
  file: string;
  signatures: string[];
  modified: boolean;
}

const extractSigsFromText = (content: string): string[] => {
  const sigs: string[] = [];
  const lines = content.split("\n").slice(0, MAX_SCAN_LINES);

  for (const line of lines) {
    if (TS_EXPORT_SIG_RE.test(line)) {
      sigs.push(clip(line.trim(), MAX_SIG_LEN));
    } else if (PY_SIG_RE.test(line) && !line.trim().startsWith("def _") && !line.trim().startsWith("class _")) {
      sigs.push(clip(line.trim(), MAX_SIG_LEN));
    } else if (GO_SIG_RE.test(line)) {
      // Skip unexported (lowercase first char)
      const nameMatch = line.match(/func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/);
      if (nameMatch && nameMatch[1] && nameMatch[1][0] === nameMatch[1][0].toUpperCase()) {
        sigs.push(clip(line.trim(), MAX_SIG_LEN));
      }
    } else if (RUST_SIG_RE.test(line)) {
      sigs.push(clip(line.trim(), MAX_SIG_LEN));
    }
  }

  return sigs;
};

const findToolResult = (blocks: NormalizedBlock[], callIndex: number): NormalizedBlock | null => {
  for (let i = callIndex + 1; i < Math.min(blocks.length, callIndex + 3); i++) {
    const b = blocks[i];
    if (b.kind === "tool_result" || b.kind === "bash") return b;
  }
  return null;
};

export const extractTypeCatalog = (blocks: NormalizedBlock[]): ExportSig[] => {
  const fileSigs = new Map<string, { sigs: string[]; modified: boolean }>();
  const fileOrder: string[] = [];

  // Collect signatures from Read/Edit tool results
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call") continue;

    const filePath = extractPath(b.args);
    if (!filePath) continue;

    const isWrite = FILE_WRITE_TOOLS.has(b.name);
    const isRead = FILE_READ_TOOLS.has(b.name);
    if (!isWrite && !isRead) continue;

    // For Edit/Write: also try to extract from the new text itself
    if (isWrite) {
      const newText = (b.args.newText ?? b.args.new_text ?? b.args.content ?? "") as string;
      if (newText && typeof newText === "string") {
        if (!fileSigs.has(filePath)) {
          fileSigs.set(filePath, { sigs: [], modified: true });
          fileOrder.push(filePath);
        } else {
          fileSigs.get(filePath)!.modified = true;
        }
        const sigs = extractSigsFromText(newText);
        const existing = fileSigs.get(filePath)!.sigs;
        for (const s of sigs) {
          if (!existing.includes(s)) existing.push(s);
        }
      }
    }

    // For Read: extract from tool result (the full file content)
    if (isRead) {
      const result = findToolResult(blocks, i);
      if (result && result.text && !result.isError) {
        if (!fileSigs.has(filePath)) {
          fileSigs.set(filePath, { sigs: [], modified: false });
          fileOrder.push(filePath);
        }
        const sigs = extractSigsFromText(result.text);
        const existing = fileSigs.get(filePath)!.sigs;
        for (const s of sigs) {
          if (!existing.includes(s)) existing.push(s);
        }
      }
    }
  }

  // Build ExportSig list, prioritizing modified files, cap total size
  const modified: ExportSig[] = [];
  const read: ExportSig[] = [];

  for (const file of fileOrder) {
    const entry = fileSigs.get(file)!;
    if (entry.sigs.length === 0) continue; // skip files with no signatures
    const esig: ExportSig = {
      file,
      signatures: entry.sigs.slice(0, 8), // cap per file
      modified: entry.modified,
    };
    if (esig.modified) modified.push(esig);
    else read.push(esig);
  }

  // Modified files first, then read files, total cap
  return [...modified, ...read].slice(0, 12);
};

export const formatTypeCatalog = (catalog: ExportSig[]): string[] => {
  if (catalog.length === 0) return [];
  const lines: string[] = [];
  let totalSigs = 0;
  const MAX_TOTAL_SIGS = 30;

  for (const entry of catalog) {
    if (totalSigs >= MAX_TOTAL_SIGS) {
      lines.push("(more signatures omitted)");
      break;
    }
    const tag = entry.modified ? "[modified]" : "[read]";
    lines.push(`${entry.file} ${tag}:`);
    for (const sig of entry.signatures) {
      if (totalSigs >= MAX_TOTAL_SIGS) break;
      lines.push(`  ${sig}`);
      totalSigs++;
    }
  }

  return lines;
};
