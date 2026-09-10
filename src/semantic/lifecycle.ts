/**
 * Semantic-layer lifecycle (Phase 6a).
 *
 *   session_start    → ensureDaemon, fire-and-forget: the one-time model
 *                      load (~30–67s cold) happens off the turn path,
 *                      before the first compaction/recall needs it.
 *   session_shutdown → cleanup ONLY when reason === "quit". pi fires
 *                      session_shutdown on session replacement too
 *                      (new/resume/fork) and on reload — those must NOT
 *                      destroy the vectors of resumable sessions
 *                      (user decision 2026-09-10):
 *                        keepOnShutdown=false → backend.remove(sessionId)
 *                        + rm -rf the session's chunk dir
 *                        drop the indexer's per-session state
 *                        stopDaemon (the daemon is a detached child; stop
 *                        it so quitting pi doesn't leak the process)
 *
 * All failures are logged, never thrown; enabled=false → no handlers.
 */
import { rmSync } from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SemanticConfig } from "./config";
import { dropSessionState } from "./indexer";
import { chunkDir, defaultVectorRoot } from "./paths";

/** Backend surface the lifecycle needs (QmdBackend satisfies it). */
interface LifecycleBackend {
  ensureDaemon(): Promise<void>;
  remove(sessionId: string): Promise<void>;
  stopDaemon(): Promise<void>;
}

export interface SemanticLifecycleOptions {
  config: SemanticConfig;
  backend: LifecycleBackend;
  /** Chunk-dir root (default: ~/.pi/vector). Injectable for tests. */
  vectorRoot?: string;
  /** Failure sink (default: console.error). */
  log?: (line: string) => void;
}

export function registerSemanticLifecycle(
  pi: ExtensionAPI,
  opts: SemanticLifecycleOptions,
): void {
  if (!opts.config.enabled) return;
  const log = opts.log ?? ((line: string) => console.error(`[pi-vcc-semantic] ${line}`));
  const root = opts.vectorRoot ?? defaultVectorRoot();

  pi.on("session_start", () => {
    opts.backend
      .ensureDaemon()
      .catch((e) => log(`daemon warmup failed (ignored): ${errMsg(e)}`));
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "quit") return;
    const sessionId = safeSessionId(ctx);
    void (async () => {
      if (sessionId) {
        if (!opts.config.keepOnShutdown) {
          try {
            await opts.backend.remove(sessionId);
          } catch (e) {
            log(`collection remove failed (ignored): ${errMsg(e)}`);
          }
          try {
            rmSync(chunkDir(sessionId, root), { recursive: true, force: true });
          } catch (e) {
            log(`vector dir cleanup failed (ignored): ${errMsg(e)}`);
          }
        }
        dropSessionState(sessionId);
      }
      try {
        await opts.backend.stopDaemon();
      } catch (e) {
        log(`daemon stop failed (ignored): ${errMsg(e)}`);
      }
    })();
  });
}

function safeSessionId(ctx: unknown): string | undefined {
  try {
    const id = (ctx as any)?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
