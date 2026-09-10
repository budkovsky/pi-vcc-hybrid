/**
 * semantic_recall tool registration (Phase 4).
 *
 * Registers the `semantic_recall` tool on the pi extension API. Gated by
 * `semantic.enabled` (false → not registered, nothing to call). The tool
 * input has no sessionId — it is resolved per call from the tool context
 * (`ctx.sessionManager.getSessionId()`), which also makes multi-session
 * processes safe (no module-level session state).
 *
 * Degraded, never broken: zero hits → friendly "index catching up" message;
 * backend failure → friendly unavailable message + log line. The turn is
 * never blocked and no error object is returned.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SemanticConfig } from "./config";
import { chunkDir, defaultVectorRoot } from "./paths";
import type { QmdBackend } from "./qmd";
import {
  type ReadChunkFn,
  emptyResult,
  formatHits,
  shapeHitsFromDisk,
  unavailableResult,
} from "./recall";

export interface SemanticRecallDeps {
  config: SemanticConfig;
  backend: Pick<QmdBackend, "search">;
  /** Chunk-dir root (default: ~/.pi/vector). Injectable for tests. */
  vectorRoot?: string;
  /** Chunk-file reader (default: real fs). Injectable for tests. */
  readChunk?: ReadChunkFn;
  /** Failure sink (default: console.error). */
  log?: (line: string) => void;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/** Clamp the requested limit into [1, 100]; invalid → config default. */
function resolveLimit(requested: number | undefined, def: number): number {
  return typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested >= MIN_LIMIT &&
    requested <= MAX_LIMIT
    ? requested
    : def;
}

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export function registerSemanticRecallTool(pi: ExtensionAPI, deps: SemanticRecallDeps): void {
  if (!deps.config.enabled) return;
  const log = deps.log ?? ((line: string) => console.error(`[pi-vcc-semantic] ${line}`));
  const root = deps.vectorRoot ?? defaultVectorRoot();

  pi.registerTool({
    name: "semantic_recall",
    label: "Semantic Recall",
    description:
      "Vector search over compacted session history (paraphrase-tolerant). " +
      "Returns the most relevant compacted chunks with turn/timestamp provenance. " +
      "Use for conceptual lookups; use vcc_recall for exact terms, file paths, and commit hashes.",
    promptSnippet:
      "semantic_recall — vector search over compacted history (paraphrase-tolerant).",
    promptGuidelines: [
      "When live context or vcc_recall (keyword) lacks a detail that was discussed earlier — especially for conceptual/paraphrased lookups — call semantic_recall(query).",
      "Exact terms, file paths, commit hashes → vcc_recall.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language or keyword query to search compacted history for.",
      }),
      limit: Type.Optional(
        Type.Number({ description: `Max hits to return (1–${MAX_LIMIT}; default from config, 5).` }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query = (params.query ?? "").trim();
      if (!query) return textResult("semantic_recall: query is required.");

      const limit = resolveLimit(params.limit, deps.config.limit);
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const raw = await deps.backend.search(sessionId, query, {
          limit,
          mode: deps.config.mode,
        });
        const hits = await shapeHitsFromDisk(
          raw,
          chunkDir(sessionId, root),
          limit,
          deps.readChunk,
        );
        return textResult(hits.length > 0 ? formatHits(hits, query) : emptyResult(query));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log(`semantic_recall failed: ${reason}`);
        return textResult(unavailableResult(query, reason));
      }
    },
  });
}
