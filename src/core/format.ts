import type { SectionData } from "../sections";

const section = (title: string, items?: string[]): string => {
  if (!items || items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;

const wrapLine = (line: string, maxChars: number): string[] => {
  if (line.length <= maxChars) return [line];

  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  const wrapped: string[] = [];
  let remaining = line;
  let prefix = "";

  while (prefix.length + remaining.length > maxChars) {
    const available = Math.max(20, maxChars - prefix.length);
    let splitAt = remaining.lastIndexOf(" ", available);
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;

    wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuationIndent;
  }

  if (remaining) wrapped.push(prefix + remaining);
  return wrapped;
};

export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text.split("\n").flatMap((line) => wrapLine(line, maxChars)).join("\n");

export const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Find first section header to avoid cutting mid-section
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

export const RECALL_NOTE =
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

/** Compaction metadata to show in the summary footer. */
export interface SummaryMetadata {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Number of messages summarized */
  sourceMessageCount: number;
  /** Token count before compaction */
  tokensBefore: number;
  /** Number of messages kept in tail */
  keptCount: number;
  /** Estimated token count of kept tail */
  keptTokensEst: number;
  /** Entry IDs [firstSummarizedId, lastSummarizedId] for compaction-scoped recall */
  messageRange?: [string, string];
}

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

/** Build the metadata footer line. */
export const formatMetadataFooter = (meta: SummaryMetadata): string => {
  const compression = meta.tokensBefore > 0
    ? ` (${Math.round(meta.tokensBefore / Math.max(1, meta.sourceMessageCount))}x)`
    : "";
  return [
    `---`,
    `Compaction at ${meta.timestamp} \u2014 ${meta.sourceMessageCount} msgs \u2192 ${formatTokens(meta.tokensBefore)} tok${compression}` +
      ` | tail: ${meta.keptCount} msgs ~${formatTokens(meta.keptTokensEst)} tok`,
  ].join("\n");
};

/**
 * Format the summary with cache-friendly section ordering.
 *
 * Stable (merged/accumulated) sections come first so the prompt prefix
 * stays cacheable across compactions. Volatile (always-fresh) sections
 * come last.
 */
export const formatSummary = (
  data: SectionData,
  meta?: SummaryMetadata,
): string => {
  // Cache-friendly ordering: stable first, volatile last
  const stableSections = [
    section("Session Goal", data.sessionGoal),
    section("User Preferences", data.userPreferences),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
  ].filter(Boolean);

  const volatileSections = [
    section("Type Catalog", data.typeCatalog),
    section("Outstanding Context", data.outstandingContext),
    section("Current Status", data.currentStatus),
  ].filter(Boolean);

  // All header sections (stable + volatile) form the header block
  const allHeaders = [...stableSections, ...volatileSections];

  const parts: string[] = [];
  if (allHeaders.length > 0) {
    parts.push(allHeaders.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript));
  }

  if (parts.length === 0) return "";

  let result = wrapLongLines(parts.join("\n\n---\n\n"));

  // Append metadata footer if provided
  if (meta) {
    result += "\n\n" + formatMetadataFooter(meta);
  }

  // NOTE: RECALL_NOTE is intentionally NOT appended here.
  // It is appended once by `compile()` at the very end, after merge-with-previous,
  // to avoid the note compounding inside the brief transcript across compactions.
  return result;
};
