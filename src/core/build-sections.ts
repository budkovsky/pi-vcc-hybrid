import type { NormalizedBlock, ToolResultIndex } from "../types";
import { clip, clipSentence, firstLine, nonEmptyLines } from "./content";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractPath } from "./tool-args";
import { extractFileAndSymbolData } from "../extract/shared-symbols";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, identifyTurns, sectionsToTranscript, stringifyBrief } from "./brief";

/**
 * Build a one-time look-ahead index: for each tool_call block, find the
 * nearest tool_result block that follows it (within +3 positions).
 *
 * Without this, files.ts / symbol-changes.ts / type-catalog.ts each scan
 * forward independently — tripling the look-ahead cost and the regex parsing
 * of tool results. The index collapses that to a single O(n) pre-scan.
 */
export const buildToolResultIndex = (blocks: NormalizedBlock[]): ToolResultIndex => {
  const map = new Map<number, Extract<NormalizedBlock, { kind: "tool_result" }>>();
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_call") continue;
    for (let j = i + 1; j < Math.min(blocks.length, i + 4); j++) {
      if (blocks[j].kind === "tool_result") {
        map.set(i, blocks[j] as Extract<NormalizedBlock, { kind: "tool_result" }>);
        break;
      }
    }
  }
  return {
    get: (callIndex: number) => map.get(callIndex) ?? null,
  };
};

interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  /** Pre-built tool-call → tool-result look-ahead index. Built once, shared across extractors. */
  toolResultIndex?: ToolResultIndex;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

// TypeScript compiler error pattern
const TSC_ERROR_RE = /error TS\d+:.+/;

// Test failure indicators
const TEST_FAIL_RE = /(?:FAIL|✗|✘|×)\s|(\d+)\s+(?:failed|failure|failing)/i;

// Empty grep/search result indicators
const EMPTY_RESULT_RE = /^(?:No matches? found\.?|No files? matched\.?|0 results?|No results?\.?)$/i;

// Maximum characters of bash output to scan for error patterns.
// Compiler/test errors almost always appear near the start of output;
// scanning the full output (potentially megabytes) is unnecessary.
const BASH_OUTPUT_SCAN_LIMIT = 8_000;

// Priority tags for outstanding context items
const PRIORITY_ERROR = "[ERROR]";
const PRIORITY_WARN = "[WARN]";
const PRIORITY_INFO = "[INFO]";

/** Prepend a priority tag based on the error type and exit code. */
const priorityTag = (item: string): string => {
  if (/^\[tsc\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  if (/^\[bash:exit [1-9]\d*\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  if (/^\[tests\]/.test(item)) return `${PRIORITY_WARN} ${item}`;
  if (/^\[no matches\]/.test(item)) return `${PRIORITY_INFO} ${item}`;
  if (/^\[user\]/.test(item)) return `${PRIORITY_WARN} ${item}`;
  // Generic tool errors
  if (/^\[\w+\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  return `${PRIORITY_WARN} ${item}`;
};

// Write-tool names used for resolution detection
const FILE_EDIT_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "MultiEdit",
]);

/** Extract file path from a [tsc] error line like "src/auth.ts(5,18): error TS2304: ..." */
const extractTscFile = (item: string): string | null => {
  const m = item.match(/^\[tsc\]\s+(\S+)\(\d+,\d+\)/);
  return m ? m[1] : null;
};

/** Check if a tsc error's file was edited at a position after the error. */
const isTscResolved = (file: string, tailIdx: number, editPositions: Map<number, Set<string>>): boolean => {
  for (const [pos, files] of editPositions) {
    if (pos > tailIdx && files.has(file)) return true;
  }
  return false;
};

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const itemTailIndices: number[] = [];
  const seen = new Set<string>();
  const tail = blocks.slice(-25);

  const push = (item: string, tailIndex?: number) => {
    if (!seen.has(item)) {
      seen.add(item);
      items.push(item);
      itemTailIndices.push(tailIndex ?? -1);
    }
  };

  for (let bi = 0; bi < tail.length; bi++) {
    const b = tail[bi];

    // 1. Bash non-zero exit codes (the exitCode field is already captured but was unused)
    if (b.kind === "bash" && b.exitCode !== undefined && b.exitCode !== 0) {
      const cmd = b.command.split("\n").map(l => l.trim()).filter(Boolean)[0] ?? b.command;
      const cmdDisplay = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
      const outLine = firstLine(b.output, 120);
      const errTag = `exit ${b.exitCode}`;
      push(`[bash:${errTag}] ${cmdDisplay}${outLine && outLine !== cmdDisplay ? ` → ${outLine}` : ""}`);
      continue;
    }

    // 2. TypeScript compiler errors in bash output
    // Scan only the first BASH_OUTPUT_SCAN_LIMIT chars — errors appear at start of output
    // Now includes file path (e.g., src/auth.ts(5,18): error TS2304:) for resolution detection
    if (b.kind === "bash" && b.output) {
      const outputHead = b.output.slice(0, BASH_OUTPUT_SCAN_LIMIT);
      if (TSC_ERROR_RE.test(outputHead)) {
        const tsLines = outputHead.split("\n")
          .filter(l => TSC_ERROR_RE.test(l.trim()))
          .slice(0, 3);
        for (const line of tsLines) {
          push(`[tsc] ${clip(line.trim(), 150)}`, bi);
        }
        continue;
      }
    }

    // 3. Test failures in bash output
    if (b.kind === "bash" && b.output && TEST_FAIL_RE.test(b.output.slice(0, BASH_OUTPUT_SCAN_LIMIT))) {
      push(`[tests] ${firstLine(b.output, 150)}`);
      continue;
    }

    // 4. Empty grep/search results (searched for something that wasn't found = signal)
    if (b.kind === "tool_result" && (b.name === "grep" || b.name === "Grep" || b.name === "Glob" || b.name === "glob")) {
      const trimmed = b.text.trim();
      if (EMPTY_RESULT_RE.test(trimmed) || trimmed === "") {
        const prevIdx = tail.slice(0, bi).findLastIndex(
          (p) => p.kind === "tool_call" && (p.name === "grep" || p.name === "Grep" || p.name === "Glob" || p.name === "glob")
        );
        let pattern = "";
        if (prevIdx >= 0) {
          const pc = tail[prevIdx];
          if (pc.kind === "tool_call") {
            pattern = (pc.args.pattern ?? pc.args.query ?? pc.args.glob ?? "") as string;
            if (pattern) pattern = ` "${clip(pattern, 60)}"`;
          }
        }
        push(`[no matches] ${b.name}${pattern}`);
        continue;
      }
    }

    // 5. Tool errors — classify tsc/test failures before generic catch
    if (b.kind === "tool_result" && b.isError) {
      // Check for tsc errors in tool result text first
      if (TSC_ERROR_RE.test(b.text)) {
        const tsLines = b.text.split("\n")
          .filter(l => TSC_ERROR_RE.test(l.trim()))
          .slice(0, 3);
        for (const line of tsLines) {
          push(`[tsc] ${clip(line.trim(), 150)}`, bi);
        }
        continue;
      }
      // Check for test failures
      if (TEST_FAIL_RE.test(b.text)) {
        push(`[tests] ${firstLine(b.text, 150)}`);
        continue;
      }
      // Generic error fallback
      push(`[${b.name}] ${firstLine(b.text, 150)}`);
      continue;
    }

    // 6. BLOCKER_RE text matching (user/assistant mentions of problems)
    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        push(clipped);
        break;
      }
    }
  }

  // Resolution detection: pre-compute edit positions in the tail so we can
  // check whether tsc errors were subsequently fixed by an edit to the same file.
  const editPositions = new Map<number, Set<string>>();
  for (let i = 0; i < tail.length; i++) {
    const b = tail[i];
    if (b.kind === "tool_call" && FILE_EDIT_TOOLS.has(b.name)) {
      const path = extractPath(b.args);
      if (path) {
        if (!editPositions.has(i)) editPositions.set(i, new Set());
        editPositions.get(i)!.add(path);
      }
    }
  }

  // Apply priority tags, marking resolved tsc errors as [RESOLVED]
  return items.slice(0, 8).map((item, idx) => {
    const tailIdx = itemTailIndices[idx] ?? -1;
    const file = extractTscFile(item);
    const resolved = tailIdx >= 0 && file !== null && isTscResolved(file, tailIdx, editPositions);
    if (!resolved) return priorityTag(item);
    const tagged = priorityTag(item);
    return tagged.replace(/^\[(ERROR|WARN)\]/, "[RESOLVED]");
  });
};

const formatFileActivityFromUnified = (data: import("../extract/shared-symbols").UnifiedExtractResult): string[] => {
  const act = data.fileActivity;
  const maxSymbolsPerFile = 4;

  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };

  const formatCategory = (label: string, set: Set<string>): string | null => {
    if (set.size === 0) return null;
    const arr = [...set];
    const annotated: string[] = [];

    for (const p of arr.slice(0, 10)) {
      const syms = act.symbols.get(p);
      if (syms && syms.length > 0) {
        const sigs = syms.slice(0, maxSymbolsPerFile).join(", ");
        const suffix = syms.length > maxSymbolsPerFile ? `, +${syms.length - maxSymbolsPerFile} more` : "";
        annotated.push(`${p} (${sigs}${suffix})`);
      } else {
        annotated.push(p);
      }
    }

    if (arr.length > 10) {
      return `${label}: ${annotated.join(", ")} (+${arr.length - 10} more)`;
    }
    return `${label}: ${annotated.join(", ")}`;
  };

  const lines: string[] = [];
  const modLine = formatCategory("Modified", act.modified);
  if (modLine) lines.push(modLine);
  const createLine = formatCategory("Created", act.created);
  if (createLine) lines.push(createLine);
  const readLine = formatCategory("Read", act.read);
  if (readLine) lines.push(readLine);
  return lines;
};

const formatTypeCatalogFromUnified = (data: import("../extract/shared-symbols").UnifiedExtractResult): string[] => {
  const catalog = data.typeCatalog;
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

// User messages that are purely confirmatory — skip these for "Working on"
const CONFIRMATORY_USER_RE =
  /^(ok|okay|yes|yeah|yep|sure|great|thanks|thx|nice|looks? good|works?|perfect|done|thanks!*|got it|i see|lgtm|awesome)\b/i;

/**
 * Extract current working status from the tail of the conversation.
 * Returns up to 3 lines: current focus, last action, next steps.
 */
const extractCurrentStatus = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  // 1. Current focus: last substantive (non-confirmatory) user message
  for (let i = tail.length - 1; i >= 0; i--) {
    const b = tail[i];
    if (b.kind !== "user") continue;
    const text = b.text.trim();
    if (text.length < 10 || CONFIRMATORY_USER_RE.test(text)) continue;
    items.push(`Working on: ${clip(text, 120)}`);
    break;
  }

  // 2. Last action: last tool call that modified/read a file
  for (let i = tail.length - 1; i >= 0; i--) {
    const b = tail[i];
    if (b.kind === "tool_call") {
      const path = extractPath(b.args);
      if (path) {
        const cmd = b.name.length > 80 ? `${b.name.slice(0, 77)}...` : b.name;
        items.push(`Last action: ${cmd} "${clip(path, 80)}"`);
        break;
      }
    }
  }

  // 3. Next steps: last agent text that mentions what to do next
  for (let i = tail.length - 1; i >= 0; i--) {
    const b = tail[i];
    if (b.kind === "assistant" && b.text.trim().length > 20) {
      const nextMatch = b.text.match(/(?:next|remaining|todo|still need|what.*left|following)/i);
      if (nextMatch) {
        items.push(`Next: ${clip(b.text.trim(), 120)}`);
        break;
      }
    }
  }

  return items.slice(0, 3);
};

/**
 * Extract structured reference anchors from already-built section data.
 * These let the model self-serve common lookups without calling vcc_recall.
 */
const extractAnchors = (data: SectionData): string[] => {
  const lines: string[] = [];

  // Commit hashes
  const commitHashes: string[] = [];
  for (const line of data.commits) {
    const hashMatch = line.match(/^-\s*([a-f0-9]{7,40}):/);
    if (hashMatch) commitHashes.push(hashMatch[1]);
  }
  if (commitHashes.length > 0) {
    lines.push(`commits: ${commitHashes.join(", ")}`);
  }

  // Error IDs from outstanding context
  const errorIds: string[] = [];
  for (const line of data.outstandingContext) {
    const tscMatch = line.match(/TS(\d{4,5})/);
    if (tscMatch) errorIds.push(`TS${tscMatch[1]}`);
  }
  if (errorIds.length > 0) {
    lines.push(`errors: ${[...new Set(errorIds)].join(", ")}`);
  }

  // Key file paths from Files And Changes
  const filePaths: string[] = [];
  for (const line of data.filesAndChanges) {
    const categoryMatch = line.match(/^-\s*(?:Modified|Created|Read):\s*(.*)/);
    if (!categoryMatch) continue;
    const pathPart = categoryMatch[1]
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/\s*\(\+\d+ more\)\s*$/, "");
    for (const p of pathPart.split(",")) {
      const trimmed = p.trim();
      if (trimmed) filePaths.push(trimmed);
    }
  }
  if (filePaths.length > 0) {
    const display = filePaths.length <= 15
      ? filePaths.join(", ")
      : `${filePaths.slice(0, 12).join(", ")} (+${filePaths.length - 12} more)`;
    lines.push(`files: ${display}`);
  }

  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  // Build tool-call → tool-result look-ahead index once, share across extractors.
  const tri = input.toolResultIndex ?? buildToolResultIndex(blocks);

  // Single-pass file and symbol extraction — replaces the triple-redundant
  // scan that extractFiles / extractSymbolChanges / extractTypeCatalog each
  // performed independently, each re-scanning the same tool results with
  // overlapping regex patterns.
  const fileAndSymbols = extractFileAndSymbolData(blocks, tri);

  const briefSections = buildBriefSections(blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );

  const turnSummaries = identifyTurns(blocks).map(t => t.summary);
  const outstandingContext = extractOutstandingContext(blocks);

  const result: SectionData = {
    sessionGoal,
    outstandingContext,
    filesAndChanges: formatFileActivityFromUnified(fileAndSymbols),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    typeCatalog: formatTypeCatalogFromUnified(fileAndSymbols),
    symbolChanges: fileAndSymbols.symbolChanges,
    currentStatus: extractCurrentStatus(blocks),
    turnSummaries,
    anchors: [],  // populated after initial section data is built
    briefTranscript: stringifyBrief(briefSections),
    transcriptEntries: sectionsToTranscript(briefSections),
  };

  // Anchors depend on other sections, so extract after building them
  result.anchors = extractAnchors(result);

  return result;
};
