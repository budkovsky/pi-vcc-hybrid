import type { TranscriptEntry } from "./core/brief";
import type { SymbolRef } from "./extract/shared-symbols";

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
