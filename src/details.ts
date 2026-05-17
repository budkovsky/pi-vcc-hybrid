export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  /** Entry IDs [firstSummarizedId, lastSummarizedId] that this compaction summarized */
  messageRange?: [string, string];
  /** Summarized-to-summary token ratio (rounded) */
  compressionRatio?: number;
}
