/**
 * Path layout + sessionId sanitization for the semantic layer.
 *
 * SECURITY: sessionId flows into filesystem paths, qmd collection names, and
 * CLI/HTTP args. Everything that touches a sessionId goes through
 * `sanitizeSessionId` here — no `/`, no `..`, length-capped, charset-restricted.
 *
 * Layout (shared-index design, see docs/qmd-contract.md):
 *   ~/.pi/vector/<sanitizedSessionId>/NNNN.md   — chunk files (per session)
 *   qmd index "pi-semantic" (shared)            — collection per session
 */
import { homedir } from "os";
import { join } from "path";

/** Maximum length of a sanitized session id. */
export const SESSION_ID_MAX_LEN = 64;

/**
 * Default name of the single shared qmd index. One daemon serves one index
 * (`--index` is process-level), so all sessions share this index and are
 * isolated by per-session *collections* (see `collectionName`).
 */
export const SHARED_INDEX_NAME = "pi-semantic";

/**
 * Sanitize a raw pi sessionId into a safe name usable in paths, qmd collection
 * names, and CLI/HTTP args.
 *
 * Rules:
 *  - trim; empty/whitespace-only → "default"
 *  - runs of chars outside [A-Za-z0-9_-] collapse to a single "_"
 *    (dots are not in the safe set → ".." can never survive)
 *  - truncated to SESSION_ID_MAX_LEN, trailing underscores trimmed
 */
export function sanitizeSessionId(raw: unknown): string {
  if (typeof raw !== "string") return "default";
  let id = raw.trim();
  if (!id) return "default";
  id = id.replace(/[^A-Za-z0-9_-]+/g, "_");
  if (id.length > SESSION_ID_MAX_LEN) {
    id = id.slice(0, SESSION_ID_MAX_LEN).replace(/_+$/, "");
  }
  return id || "default";
}

/** Default chunk-dir root: ~/.pi/vector */
export function defaultVectorRoot(): string {
  return join(homedir(), ".pi", "vector");
}

/**
 * Per-session chunk directory: <root>/<sanitizedSessionId>.
 * `root` is injectable for tests; defaults to ~/.pi/vector.
 */
export function chunkDir(sessionId: string, root: string = defaultVectorRoot()): string {
  return join(root, sanitizeSessionId(sessionId));
}

/**
 * qmd collection name for a session (per-session isolation inside the shared
 * index). Identical to the sanitized session id.
 */
export function collectionName(sessionId: string): string {
  return sanitizeSessionId(sessionId);
}
