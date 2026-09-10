/**
 * QmdBackend — the qmd facade for the semantic layer.
 *
 * Two paths (see docs/qmd-contract.md):
 *   indexing (background, CLI):  ensureIndex / embed / remove
 *   recall   (turn path, HTTP):  search  — via the resident daemon
 *
 * The extension owns the daemon lifecycle: ensureDaemon() reuses a healthy
 * daemon (health probe), otherwise spawns `qmd mcp --http --daemon`, polls
 * /health, and fires a throwaway warmup query so the one-time model load
 * (~30–67s cold) happens off the turn path. stopDaemon() for shutdown.
 *
 * All failures reject with QmdError (structured) — never an unhandled
 * rejection; callers (indexer / recall) decide how to degrade.
 */
import { SHARED_INDEX_NAME, collectionName } from "./paths";
import type { GpuMode, SemanticMode } from "./config";
import {
  DEFAULT_TIMEOUT_MS,
  EMBED_TIMEOUT_MS,
  type ExecFn,
  type ExecResult,
  QmdError,
  collectionAddArgs,
  collectionRemoveArgs,
  daemonSpawnArgs,
  daemonStopArgs,
  embedArgs,
  execQmd,
  qmdEnv,
} from "./qmd-cli";
import {
  WARMUP_QUERY,
  type FetchLike,
  type QmdRawHit,
  checkHealth,
  queryDaemon,
} from "./qmd-daemon";

export interface QmdBackendOptions {
  /** Shared qmd index name (default: SHARED_INDEX_NAME). */
  indexName?: string;
  /** Daemon HTTP port (default: 8390). */
  daemonPort?: number;
  /** GPU policy (default: "cpu" → QMD_FORCE_CPU=1). */
  gpu?: GpuMode;
  /** qmd binary (default: "qmd" on PATH). */
  qmdBin?: string;
  /** Injectable exec (tests use a fake; default: real spawn). */
  exec?: ExecFn;
  /** Injectable fetch (tests use a fake; default: global fetch). */
  fetch?: FetchLike;
  /** Per-command timeout (default: 30s). */
  timeoutMs?: number;
  /** Embed timeout (default: 10min). */
  embedTimeoutMs?: number;
  /** How long to wait for a spawned daemon to become healthy (default: 30s). */
  healthTimeoutMs?: number;
  /** Health poll interval (default: 250ms). */
  healthPollMs?: number;
  /** Daemon warmup failure sink (default: console.error). */
  log?: (line: string) => void;
}

export interface SearchOptions {
  limit?: number;
  mode?: SemanticMode;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class QmdBackend {
  readonly indexName: string;
  readonly daemonPort: number;
  private readonly gpu: GpuMode;
  private readonly qmdBin: string;
  private readonly exec: ExecFn;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly embedTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly healthPollMs: number;
  private readonly log: (line: string) => void;
  private daemonPromise: Promise<void> | null = null;

  constructor(opts: QmdBackendOptions = {}) {
    this.indexName = opts.indexName ?? SHARED_INDEX_NAME;
    this.daemonPort = opts.daemonPort ?? 8390;
    this.gpu = opts.gpu ?? "cpu";
    this.qmdBin = opts.qmdBin ?? "qmd";
    this.exec = opts.exec ?? execQmd;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.embedTimeoutMs = opts.embedTimeoutMs ?? EMBED_TIMEOUT_MS;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 30_000;
    this.healthPollMs = opts.healthPollMs ?? 250;
    this.log = opts.log ?? ((line) => console.error(`[pi-vcc-semantic] ${line}`));
  }

  // --- CLI: background indexing ------------------------------------------

  /**
   * Add the session's collection (pointing at its chunk dir). Idempotent:
   * exit 1 = collection already exists → ok.
   */
  async ensureIndex(sessionId: string, dir: string): Promise<void> {
    const r = await this.run(
      collectionAddArgs(this.indexName, dir, collectionName(sessionId)),
      this.timeoutMs,
    );
    if (r.exitCode === 1) return; // already exists
    if (r.exitCode !== 0) {
      throw new QmdError("cli-failed", `collection add failed: ${r.stderr || r.stdout}`);
    }
  }

  /** Embed only this session's collection (≈0.2s/chunk on CPU). */
  async embed(sessionId: string): Promise<void> {
    const r = await this.run(embedArgs(this.indexName, collectionName(sessionId)), this.embedTimeoutMs);
    if (r.exitCode !== 0) {
      throw new QmdError("cli-failed", `embed failed: ${r.stderr || r.stdout}`);
    }
  }

  /** Remove the session's collection. Idempotent: exit 1 = missing → ok. */
  async remove(sessionId: string): Promise<void> {
    const r = await this.run(
      collectionRemoveArgs(this.indexName, collectionName(sessionId)),
      this.timeoutMs,
    );
    if (r.exitCode === 1) return; // already gone
    if (r.exitCode !== 0) {
      throw new QmdError("cli-failed", `collection remove failed: ${r.stderr || r.stdout}`);
    }
  }

  // --- daemon lifecycle ----------------------------------------------------

  /**
   * Ensure the shared daemon is up: healthy → reuse (no warmup — it was
   * warmed at spawn); down → spawn + poll /health + fire the throwaway
   * warmup query (never awaited — the model load spans the first queries).
   * Concurrent calls share one start (in-flight guard).
   */
  async ensureDaemon(): Promise<void> {
    // Guard is set synchronously (before the health await) so concurrent
    // callers share one start.
    if (this.daemonPromise) return this.daemonPromise;
    const p = this.ensureDaemonInner().finally(() => {
      this.daemonPromise = null;
    });
    this.daemonPromise = p;
    return p;
  }

  private async ensureDaemonInner(): Promise<void> {
    if (await checkHealth(this.fetchFn, this.daemonPort)) return;
    await this.startDaemon();
  }

  /** Stop the shared daemon. Idempotent: exit 1 = not running → ok. */
  async stopDaemon(): Promise<void> {
    const r = await this.run(daemonStopArgs(this.indexName), this.timeoutMs);
    if (r.exitCode === 1) return;
    if (r.exitCode !== 0) {
      throw new QmdError("cli-failed", `daemon stop failed: ${r.stderr || r.stdout}`);
    }
  }

  private async startDaemon(): Promise<void> {
    const r = await this.run(daemonSpawnArgs(this.indexName, this.daemonPort), this.timeoutMs);
    if (r.exitCode !== 0) {
      throw new QmdError("daemon-unreachable", `daemon spawn failed: ${r.stderr || r.stdout}`);
    }
    await this.waitForHealth();
    this.fireWarmup();
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (await checkHealth(this.fetchFn, this.daemonPort)) return;
      await sleep(this.healthPollMs);
    }
    throw new QmdError("daemon-unreachable", `daemon not healthy after ${this.healthTimeoutMs}ms`);
  }

  /** Throwaway vec query so the one-time model load happens off the turn path. */
  private fireWarmup(): void {
    void queryDaemon(
      this.fetchFn,
      this.daemonPort,
      { query: WARMUP_QUERY, limit: 1, mode: "vsearch", collections: [] },
      this.timeoutMs,
    ).catch((e) => this.log(`daemon warmup failed (ignored): ${(e as Error).message}`));
  }

  // --- recall ---------------------------------------------------------------

  /**
   * Vector search over the session's collection. Returns raw daemon hits
   * (Phase 4's recall.ts shapes them into Hits with provenance).
   * Ensures the daemon first (health probe per call — cheap, and recovers
   * if the daemon died).
   */
  async search(
    sessionId: string,
    query: string,
    opts: SearchOptions = {},
  ): Promise<QmdRawHit[]> {
    await this.ensureDaemon();
    return queryDaemon(
      this.fetchFn,
      this.daemonPort,
      {
        query,
        limit: opts.limit ?? 5,
        mode: opts.mode ?? "vsearch",
        collections: [collectionName(sessionId)],
      },
      this.timeoutMs,
    );
  }

  // --- helpers ----------------------------------------------------------------

  private run(args: string[], timeoutMs: number): Promise<ExecResult> {
    return this.exec([this.qmdBin, ...args], { env: qmdEnv(this.gpu), timeoutMs });
  }
}
