import type { TranscriptEntry } from "./core/brief";
import type { SymbolRef } from "./extract/shared-symbols";

// Section ordering: stable sections first (cache-friendly), volatile last.
// This is the single source of truth for section order throughout the codebase.
// format.ts reads this to render; summarize.ts reads it for merge logic.
export const SECTION_DEFS = [
  { key: "sessionGoal", title: "Session Goal", stable: true, merge: "dedup" as const },
  { key: "userPreferences", title: "User Preferences", stable: true, merge: "dedup" as const },
  { key: "filesAndChanges", title: "Files And Changes", stable: true, merge: "file-union" as const },
  { key: "commits", title: "Commits", stable: true, merge: "dedup" as const },
  { key: "anchors", title: "Anchors", stable: true, merge: "fresh" as const },
  { key: "typeCatalog", title: "Type Catalog", stable: false, merge: "fresh" as const },
  { key: "outstandingContext", title: "Outstanding Context", stable: false, merge: "fresh" as const },
  { key: "turnSummaries", title: "Earlier Turns", stable: false, merge: "dedup" as const },
  { key: "currentStatus", title: "Current Status", stable: false, merge: "fresh" as const },
] as const;

export type SectionKey = typeof SECTION_DEFS[number]["key"];
export type SectionTitle = typeof SECTION_DEFS[number]["title"];

export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  /** Exported signatures from modified/read files */
  typeCatalog: string[];
  /** Symbol-level changes (function/type/class names per file) */
  symbolChanges: SymbolRef[];
  /** Current working context: what's being worked on, last action, next steps */
  currentStatus: string[];
  /** Per-turn one-liner summaries for the HCA zone (heaviest compression, oldest turns) */
  turnSummaries: string[];
  /** Structured reference anchors for zero-tool-call recall */
  anchors: string[];
  briefTranscript: string;
  /** Structured transcript entries (verbose object format) */
  transcriptEntries: TranscriptEntry[];
}
