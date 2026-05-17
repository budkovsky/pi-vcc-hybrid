import type { TranscriptEntry } from "./core/brief";
import type { SymbolRef } from "./extract/symbol-changes";

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
  briefTranscript: string;
  /** Structured transcript entries (verbose object format) */
  transcriptEntries: TranscriptEntry[];
}
