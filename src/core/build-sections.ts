import type { NormalizedBlock, ToolResultIndex } from "../types";
import { clip, firstLine } from "./content";
import { extractPath } from "./tool-args";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFileAndSymbolData } from "../extract/shared-symbols";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { extractOutstandingContext, extractCurrentStatus, extractAnchors } from "../extract/context";
import { buildBriefSections, identifyTurns, sectionsToTranscript, stringifyBrief } from "./brief";

/**
 * Build a one-time look-ahead index: for each tool_call block, find the
 * nearest tool_result block that follows it (within +3 positions).
 */
const buildToolResultIndex = (blocks: NormalizedBlock[]): ToolResultIndex => {
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
      lines.push(` ${sig}`);
      totalSigs++;
    }
  }

  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const tri = input.toolResultIndex ?? buildToolResultIndex(blocks);

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
    anchors: [],
    briefTranscript: stringifyBrief(briefSections),
    transcriptEntries: sectionsToTranscript(briefSections),
  };

  result.anchors = extractAnchors(result);

  return result;
};
