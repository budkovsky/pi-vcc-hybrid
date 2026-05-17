export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  /** Global message indices [start, end] that this compaction summarized (inclusive) */
  messageRange?: [number, number];
  /** Summarized-to-summary token ratio (rounded) */
  compressionRatio?: number;
}
