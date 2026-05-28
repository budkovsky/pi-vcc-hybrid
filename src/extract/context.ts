import type { NormalizedBlock } from "../types";
import { clip, clipSentence, firstLine, nonEmptyLines } from "../core/content";
import { extractPath } from "../core/tool-args";
import type { SectionData } from "../sections";

// Shared constants

// Maximum characters of bash output to scan for error patterns.
// Compiler/test errors almost always appear near the start of output;
// scanning the full output (potentially megabytes) is unnecessary.
const BASH_OUTPUT_SCAN_LIMIT = 8_000;

// Write-tool names used for resolution detection
const FILE_EDIT_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "MultiEdit",
]);

// Per-signal regex patterns

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const TSC_ERROR_RE = /error TS\d+:.+/;

const TEST_FAIL_RE = /(?:FAIL|✗|✘|×)\s|(\d+)\s+(?:failed|failure|failing)/i;

const EMPTY_RESULT_RE = /^(?:No matches? found\.?|No files? matched\.?|0 results?|No results?\.?)$/i;

const SEARCH_TOOLS = new Set(["grep", "Grep", "Glob", "glob"]);

// Context item with an optional tail index for resolution detection
interface ContextItem {
  text: string;
  tailIndex: number;
}

// Per-signal extractors.
// Each takes relevant blocks and returns zero or more context items.

const extractBashErrors = (b: NormalizedBlock): ContextItem[] => {
  if (b.kind !== "bash" || b.exitCode === undefined || b.exitCode === 0) return [];

  const cmd = b.command.split("\n").map(l => l.trim()).filter(Boolean)[0] ?? b.command;
  const cmdDisplay = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  const outLine = firstLine(b.output, 120);
  const errTag = `exit ${b.exitCode}`;
  return [{
    text: `[bash:${errTag}] ${cmdDisplay}${outLine && outLine !== cmdDisplay ? ` → ${outLine}` : ""}`,
    tailIndex: -1,
  }];
};

const extractTscErrors = (b: NormalizedBlock, bi: number): ContextItem[] => {
  if (b.kind !== "bash" || !b.output) return [];
  const outputHead = b.output.slice(0, BASH_OUTPUT_SCAN_LIMIT);
  if (!TSC_ERROR_RE.test(outputHead)) return [];

  return outputHead.split("\n")
    .filter(l => TSC_ERROR_RE.test(l.trim()))
    .slice(0, 3)
    .map(line => ({
      text: `[tsc] ${clip(line.trim(), 150)}`,
      tailIndex: bi,
    }));
};

const extractTestFailures = (b: NormalizedBlock): ContextItem[] => {
  if (b.kind !== "bash" || !b.output) return [];
  if (!TEST_FAIL_RE.test(b.output.slice(0, BASH_OUTPUT_SCAN_LIMIT))) return [];

  return [{
    text: `[tests] ${firstLine(b.output, 150)}`,
    tailIndex: -1,
  }];
};

const extractEmptySearchResults = (b: NormalizedBlock, tail: NormalizedBlock[], bi: number): ContextItem[] => {
  if (b.kind !== "tool_result" || !SEARCH_TOOLS.has(b.name)) return [];
  const trimmed = b.text.trim();
  if (!EMPTY_RESULT_RE.test(trimmed) && trimmed !== "") return [];

  const prevIdx = tail.slice(0, bi).findLastIndex(
    (p) => p.kind === "tool_call" && SEARCH_TOOLS.has(p.name),
  );
  let pattern = "";
  if (prevIdx >= 0) {
    const pc = tail[prevIdx];
    if (pc.kind === "tool_call") {
      pattern = (pc.args.pattern ?? pc.args.query ?? pc.args.glob ?? "") as string;
      if (pattern) pattern = ` "${clip(pattern, 60)}"`;
    }
  }
  return [{
    text: `[no matches] ${b.name}${pattern}`,
    tailIndex: -1,
  }];
};

const extractToolErrors = (b: NormalizedBlock, bi: number): ContextItem[] => {
  if (b.kind !== "tool_result" || !b.isError) return [];

  // Check for tsc errors in tool result text first
  if (TSC_ERROR_RE.test(b.text)) {
    return b.text.split("\n")
      .filter(l => TSC_ERROR_RE.test(l.trim()))
      .slice(0, 3)
      .map(line => ({
        text: `[tsc] ${clip(line.trim(), 150)}`,
        tailIndex: bi,
      }));
  }
  // Check for test failures
  if (TEST_FAIL_RE.test(b.text)) {
    return [{
      text: `[tests] ${firstLine(b.text, 150)}`,
      tailIndex: -1,
    }];
  }
  // Generic error fallback
  return [{
    text: `[${b.name}] ${firstLine(b.text, 150)}`,
    tailIndex: -1,
  }];
};

const extractBlockerText = (b: NormalizedBlock): ContextItem[] => {
  if (b.kind !== "assistant" && b.kind !== "user") return [];

  for (const line of nonEmptyLines(b.text)) {
    if (!BLOCKER_RE.test(line)) continue;
    if (line.length < 15) continue;
    if (/^\s*[-*+>]\s/.test(line)) continue;
    if (/^\s*\(/.test(line)) continue;
    if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
    const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
    return [{ text: clipped, tailIndex: -1 }];
  }
  return [];
};

// Priority tagging

const PRIORITY_ERROR = "[ERROR]";
const PRIORITY_WARN = "[WARN]";
const PRIORITY_INFO = "[INFO]";

const priorityTag = (item: string): string => {
  if (/^\[tsc\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  if (/^\[bash:exit [1-9]\d*\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  if (/^\[tests\]/.test(item)) return `${PRIORITY_WARN} ${item}`;
  if (/^\[no matches\]/.test(item)) return `${PRIORITY_INFO} ${item}`;
  if (/^\[user\]/.test(item)) return `${PRIORITY_WARN} ${item}`;
  if (/^\[\w+\]/.test(item)) return `${PRIORITY_ERROR} ${item}`;
  return `${PRIORITY_WARN} ${item}`;
};

// Resolution detection

/** Extract file path from a [tsc] error line like "src/auth.ts(5,18): error TS2304: ..." */
const extractTscFile = (item: string): string | null => {
  const m = item.match(/^\[tsc\]\s+(\S+)\(\d+,\d+\)/);
  return m ? m[1] : null;
};

/** Build a map of tail-index → edited file paths for resolution detection. */
const buildEditPositionMap = (tail: NormalizedBlock[]): Map<number, Set<string>> => {
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
  return editPositions;
};

/** Check if a tsc error's file was edited at a position after the error. */
const isTscResolved = (file: string, tailIdx: number, editPositions: Map<number, Set<string>>): boolean => {
  for (const [pos, files] of editPositions) {
    if (pos > tailIdx && files.has(file)) return true;
  }
  return false;
};

/**
 * Compose all per-signal extractors into the full outstanding context.
 *
 * Each block in the tail is tested by extractors in priority order.
 * The first extractor to match a block produces items for that block
 * and the remaining extractors are skipped (preventing e.g. a bash
 * error from appearing both as [bash:exit] and [tsc]).
 */
export const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: ContextItem[] = [];
  const seen = new Set<string>();
  const tail = blocks.slice(-25);

  for (let bi = 0; bi < tail.length; bi++) {
    const b = tail[bi];

    let extracted: ContextItem[] = [];

    if (b.kind === "bash" && b.exitCode !== undefined && b.exitCode !== 0) {
      extracted = extractBashErrors(b);
    } else if (b.kind === "bash" && b.output) {
      const outputHead = b.output.slice(0, BASH_OUTPUT_SCAN_LIMIT);
      if (TSC_ERROR_RE.test(outputHead)) {
        extracted = extractTscErrors(b, bi);
      } else if (TEST_FAIL_RE.test(outputHead)) {
        extracted = extractTestFailures(b);
      }
    } else if (b.kind === "tool_result" && SEARCH_TOOLS.has(b.name)) {
      const trimmed = b.text.trim();
      if (EMPTY_RESULT_RE.test(trimmed) || trimmed === "") {
        extracted = extractEmptySearchResults(b, tail, bi);
      } else if (b.isError) {
        extracted = extractToolErrors(b, bi);
      }
    } else if (b.kind === "tool_result" && b.isError) {
      extracted = extractToolErrors(b, bi);
    } else if (b.kind === "assistant" || b.kind === "user") {
      extracted = extractBlockerText(b);
    }

    for (const item of extracted) {
      if (!seen.has(item.text)) {
        seen.add(item.text);
        items.push(item);
      }
    }
  }

  // Resolution detection: check whether tsc errors were subsequently fixed
  const editPositions = buildEditPositionMap(tail);

  return items.slice(0, 8).map((item) => {
    const file = extractTscFile(item.text);
    const resolved = item.tailIndex >= 0 && file !== null && isTscResolved(file, item.tailIndex, editPositions);
    if (!resolved) return priorityTag(item.text);
    const tagged = priorityTag(item.text);
    return tagged.replace(/^\[(ERROR|WARN)\]/, "[RESOLVED]");
  });
};

// --- Current Status extraction ---

const CONFIRMATORY_USER_RE =
  /^(ok|okay|yes|yeah|yep|sure|great|thanks|thx|nice|looks? good|works?|perfect|done|thanks!*|got it|i see|lgtm|awesome)\b/i;

/** Extract current working status from the tail of the conversation. */
export const extractCurrentStatus = (blocks: NormalizedBlock[]): string[] => {
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

// --- Anchors extraction ---

/** Extract structured reference anchors from already-built section data. */
export const extractAnchors = (data: SectionData): string[] => {
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
