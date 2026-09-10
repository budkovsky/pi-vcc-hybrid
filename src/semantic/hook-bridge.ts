/**
 * Bridge between the VCC compaction hook and the semantic indexer (Phase 6a).
 *
 * `indexTrimmedSpan()` is the ONLY call the inherited before-compact hook
 * makes into the semantic layer. It is total: no opts or disabled config →
 * no-op; any unexpected error is logged, never rethrown — compaction must
 * never break because of the vector index.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { SemanticConfig } from "./config";
import { indexSpan, type IndexerBackend } from "./indexer";

export interface SemanticHookOptions {
  config: SemanticConfig;
  backend: IndexerBackend;
  /** Chunk-dir root (default: ~/.pi/vector). Injectable for tests. */
  vectorRoot?: string;
  /** Failure sink (default: console.error). */
  log?: (line: string) => void;
}

/**
 * Fire-and-forget indexing of the trimmed span (the messages the VCC
 * summary replaces). Returns immediately; all work happens in the
 * indexer's background pipeline.
 */
export function indexTrimmedSpan(
  opts: SemanticHookOptions | undefined,
  sessionId: string,
  messages: Message[],
): void {
  if (!opts || !opts.config.enabled) return;
  try {
    indexSpan({
      sessionId,
      messages,
      backend: opts.backend,
      chunkTokens: opts.config.chunkTokens,
      vectorRoot: opts.vectorRoot,
      log: opts.log,
    });
  } catch (e) {
    // indexSpan is sync-return and non-throwing by contract; this guard
    // covers unexpected errors (e.g. a broken messages array).
    const msg = e instanceof Error ? e.message : String(e);
    (opts.log ?? ((line: string) => console.error(`[pi-vcc-semantic] ${line}`)))(
      `indexSpan setup failed: ${msg}`,
    );
  }
}
