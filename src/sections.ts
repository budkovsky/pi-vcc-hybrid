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
  briefTranscript: string;
  /** Structured transcript entries (verbose object format) */
  transcriptEntries: TranscriptEntry[];
}
