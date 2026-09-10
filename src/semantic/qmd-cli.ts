/**
 * qmd CLI wrapper (background indexing path).
 *
 * All commands are argv arrays — never shell strings (sessionId flows into
 * these args; it is sanitized upstream in paths.ts). Exit-code contract from
 * docs/qmd-contract.md (Phase 0):
 *   collection add     exit 0 ok, 1 = collection already exists
 *   collection remove  exit 0 ok, 1 = collection missing
 *   embed              exit 0 ok, anything else is an error
 *   mcp stop           exit 0 ok, 1 = not running
 *
 * `execQmd` is the real spawn; tests inject a fake ExecFn instead.
 */
import { spawn } from "child_process";
import type { GpuMode } from "./config";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  env: Record<string, string>;
  timeoutMs: number;
}

export type ExecFn = (argv: string[], opts: ExecOptions) => Promise<ExecResult>;

export type QmdErrorCode =
  | "cli-failed"
  | "timeout"
  | "daemon-unreachable"
  | "daemon-error"
  | "bad-response";

/** Structured error for every qmd failure — never an unhandled rejection. */
export class QmdError extends Error {
  readonly code: QmdErrorCode;
  constructor(code: QmdErrorCode, message: string) {
    super(message);
    this.name = "QmdError";
    this.code = code;
  }
}

/** Default per-command timeout (collection ops, daemon spawn/stop). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Embed is ≈0.2s/chunk on CPU — allow a very large session (3000 chunks). */
export const EMBED_TIMEOUT_MS = 600_000;

/**
 * qmd env policy: CPU is the contract (GPU contention hazard on the
 * reference box). Only gpu="force" opts into the GPU.
 */
export function qmdEnv(gpu: GpuMode, base: Record<string, string> = {}): Record<string, string> {
  return gpu === "force" ? { ...base } : { QMD_FORCE_CPU: "1", ...base };
}

// --- argv builders (exact Phase-0 contract shapes) -------------------------

export function collectionAddArgs(indexName: string, dir: string, collection: string): string[] {
  return ["--index", indexName, "collection", "add", dir, "--name", collection];
}

export function collectionRemoveArgs(indexName: string, collection: string): string[] {
  return ["--index", indexName, "collection", "remove", collection];
}

export function embedArgs(indexName: string, collection: string): string[] {
  return ["--index", indexName, "embed", "-c", collection];
}

export function daemonSpawnArgs(indexName: string, port: number): string[] {
  return ["--index", indexName, "mcp", "--http", "--daemon", "--port", String(port)];
}

export function daemonStopArgs(indexName: string): string[] {
  return ["mcp", "stop", "--index", indexName];
}

// --- real spawn -------------------------------------------------------------

/**
 * Spawn `argv[0]` with `argv.slice(1)` as arguments. Resolves with the exit
 * code (the caller interprets it); rejects only on spawn failure ("cli-failed")
 * or timeout ("timeout"). stdout/stderr are kept separate (vsearch contract:
 * JSON on stdout, expansion trace on stderr).
 */
export function execQmd(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const [bin, ...args] = argv;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env: { ...process.env, ...opts.env } });
    } catch (e) {
      reject(new QmdError("cli-failed", `spawn ${bin}: ${(e as Error).message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new QmdError("timeout", `qmd ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new QmdError("cli-failed", `spawn ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
