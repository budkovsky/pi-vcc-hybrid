/**
 * qmd daemon HTTP client (recall path).
 *
 * The daemon is `qmd mcp --http --daemon` on the shared index (one daemon =
 * one index; sessions are isolated by the `collections` filter). Contract:
 * docs/qmd-contract.md — 2025-era JSON-RPC over Streamable HTTP, SSE
 * responses, `rerank:false` MANDATORY (default rerank ≈30s/query on CPU).
 */
import { QmdError } from "./qmd-cli";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** Throwaway query fired after spawn so the one-time model load happens off the turn path. */
export const WARMUP_QUERY = "warmup";

/** Raw daemon result entry (shape pinned by the Phase-0 probe). */
export interface QmdRawHit {
  docid: string;
  /** "<collection>/<relpath>" (no qmd:// prefix). */
  file: string;
  title: string;
  /** 0..1, normalized (top hit = 1). */
  score: number;
  line: number;
  /** Line-number-prefixed snippet. */
  snippet: string;
}

export interface DaemonQueryParams {
  query: string;
  limit: number;
  /** "vsearch" = vector-only (fast); "query" = hybrid + expansion (slower). */
  mode: "vsearch" | "query";
  collections: string[];
}

export type FetchLike = (url: string, init?: any) => Promise<any>;

/** localhost, not 127.0.0.1 — the daemon listens on IPv6 [::1]. */
export function daemonUrl(port: number, path: string): string {
  return `http://localhost:${port}${path}`;
}

/**
 * Build the JSON-RPC `tools/call` body for the daemon `query` tool.
 * `rerank:false` is mandatory — the LLM reranker is ≈30s/query on this CPU.
 */
export function queryBody(id: number, params: DaemonQueryParams): object {
  const args: Record<string, unknown> =
    params.mode === "vsearch"
      ? { searches: [{ type: "vec", query: params.query }] }
      : { query: params.query };
  args.limit = params.limit;
  if (params.collections.length > 0) args.collections = params.collections;
  args.rerank = false;
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "query", arguments: args } };
}

/** Health probe: true only on 200 {"status":"ok"}; never throws. */
export async function checkHealth(fetchFn: FetchLike, port: number, timeoutMs = 5000): Promise<boolean> {
  try {
    const res: any = await fetchFn(daemonUrl(port, "/health"), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body: any = await res.json().catch(() => null);
    return body?.status === "ok";
  } catch {
    return false;
  }
}

/** Pick the `data:` line out of an SSE body (keepalive comments tolerated). */
function parseSse(text: string): object | null {
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
  const raw = (dataLine ? dataLine.slice("data:".length) : text).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const isRawHit = (r: unknown): r is QmdRawHit =>
  typeof r === "object" && r !== null && typeof (r as any).score === "number";

/**
 * Issue one `query` tool call and return the raw result entries.
 * Errors: daemon-unreachable (network/timeout/HTTP), daemon-error (JSON-RPC
 * error), bad-response (unparseable / missing structuredContent.results).
 */
export async function queryDaemon(
  fetchFn: FetchLike,
  port: number,
  params: DaemonQueryParams,
  timeoutMs = 60_000,
): Promise<QmdRawHit[]> {
  let res: any;
  try {
    res = await fetchFn(daemonUrl(port, "/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify(queryBody(1, params)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new QmdError("daemon-unreachable", `qmd daemon query failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new QmdError("daemon-unreachable", `qmd daemon HTTP ${res.status}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new QmdError("daemon-unreachable", `qmd daemon read failed: ${(e as Error).message}`);
  }
  const msg: any = parseSse(text);
  if (!msg) throw new QmdError("bad-response", "empty or unparseable daemon response");
  if (msg.error) {
    throw new QmdError("daemon-error", msg.error.message ?? JSON.stringify(msg.error));
  }
  const results = msg.result?.structuredContent?.results;
  if (!Array.isArray(results)) {
    throw new QmdError("bad-response", "daemon result missing structuredContent.results");
  }
  return results.filter(isRawHit);
}
