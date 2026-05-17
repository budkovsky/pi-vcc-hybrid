import type { NormalizedBlock } from "../types";
import { clip, clipSentence, firstLine, nonEmptyLines } from "./content";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractPath } from "./tool-args";
import { extractFiles } from "../extract/files";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { extractSymbolChanges } from "../extract/symbol-changes";
import { extractTypeCatalog, formatTypeCatalog } from "../extract/type-catalog";
import { buildBriefSections, sectionsToTranscript, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

// TypeScript compiler error pattern
const TSC_ERROR_RE = /error TS\d+:.+/;

// Test failure indicators
const TEST_FAIL_RE = /(?:FAIL|✗|✘|×)\s|(\d+)\s+(?:failed|failure|failing)/i;

// Empty grep/search result indicators
const EMPTY_RESULT_RE = /^(?:No matches? found\.?|No files? matched\.?|0 results?|No results?\.?)$/i;

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

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const seen = new Set<string>();
  const tail = blocks.slice(-25);

  const push = (item: string) => {
    if (!seen.has(item)) {
      seen.add(item);
      items.push(item);
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
    if (b.kind === "bash" && TSC_ERROR_RE.test(b.output)) {
      const tsErrors = b.output.match(new RegExp(TSC_ERROR_RE.source, "g"))?.slice(0, 3);
      if (tsErrors) {
        for (const e of tsErrors) push(`[tsc] ${clip(e, 150)}`);
      }
      continue;
    }

    // 3. Test failures in bash output
    if (b.kind === "bash" && TEST_FAIL_RE.test(b.output)) {
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
        const tsErrors = b.text.match(new RegExp(TSC_ERROR_RE.source, "g"))?.slice(0, 3);
        if (tsErrors) {
          for (const e of tsErrors) push(`[tsc] ${clip(e, 150)}`);
          continue;
        }
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

  return items.slice(0, 8).map(priorityTag);
};

const formatFileActivity = (blocks: NormalizedBlock[]): string[] => {
  const act = extractFiles(blocks);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);

  const maxSymbolsPerFile = 4;

  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };

  // Format with symbol annotations where available
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

/**
 * Extract current working status from the tail of the conversation.
 * Returns up to 3 lines: current focus, last action, next steps.
 */
const extractCurrentStatus = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  // 1. Current focus: last substantive user message
  for (let i = tail.length - 1; i >= 0; i--) {
    const b = tail[i];
    if (b.kind === "user" && b.text.trim().length > 10) {
      items.push(`Working on: ${clip(b.text.trim(), 120)}`);
      break;
    }
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

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );
  const typeCatalog = formatTypeCatalog(extractTypeCatalog(blocks));
  const symbolChanges = extractSymbolChanges(blocks);

  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    typeCatalog,
    symbolChanges,
    currentStatus: extractCurrentStatus(blocks),
    briefTranscript: stringifyBrief(briefSections),
    transcriptEntries: sectionsToTranscript(briefSections),
  };
};
