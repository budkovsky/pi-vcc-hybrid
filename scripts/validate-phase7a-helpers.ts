/**
 * Phase 7a helpers — filler generation, daemon readiness, evidence capture.
 * Used by scripts/validate-phase7a.ts (runbook: scripts/manual-validation.md).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The planted fact — lives ONLY in the trimmed span after compaction. */
export const PLANTED_FACT =
  "The backup passphrase for the staging database replica (host amber-otter) is rotated by the night-shift ops team every Tuesday at 03:15 UTC.";

/** Paraphrase with near-zero keyword overlap with the fact (value proof). */
export const PARAPHRASE_QUERY =
  "which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time";

/** Distinctive tokens that prove the chunk containing the fact was returned. */
export const FACT_TOKENS = ["amber-otter", "03:15", "Tuesday"];

const NOTE_TOPICS = [
  ["billing", "retries failed webhooks with exponential backoff (base 2s, cap 5m, 8 attempts)"],
  ["search", "caches query facets for 60s in a local LRU (256 entries, per-tenant keys)"],
  ["auth", "rotates session signing keys every 12h and validates clock skew under 90s"],
  ["ingest", "batches sensor rows into 5k-line files before uploading to object storage"],
  ["reports", "renders PDF invoices with a 2-page limit and falls back to CSV on overflow"],
  ["gateway", "sheds load by dropping /metrics scrapers first when p99 exceeds 800ms"],
  ["mobile", "syncs offline edits with last-write-wins and a 30-day conflict window"],
  ["etl", "dedupes events by (source_id, occurred_at) keeping the highest revision"],
  ["scheduler", "uses a 24-bucket cron with jitter up to 30s to avoid thundering herds"],
  ["audit", "hash-chains log entries with SHA-256 and writes a daily root to the vault"],
  ["cdn", "purges by tag on publish and keeps stale-while-revalidate for 120s"],
  ["webhooks", "signs payloads with HMAC-SHA256 and requires a 300s timestamp window"],
  ["search-api", "highlights matched terms with <mark> and caps snippets at 160 chars"],
  ["billing-api", "prorates plan changes on the hour and refunds unused days as credit"],
  ["notifications", "coalesces email digests per user per 15m and suppresses on mute"],
  ["storage", "tiers objects hot/warm/cold at 30/90 days with per-bucket overrides"],
  ["telemetry", "samples traces at 10% but keeps 100% for requests over 1s latency"],
  ["rate-limit", "applies token buckets per API key (100 rps burst 200) and returns Retry-After"],
  ["feature-flags", "evaluates flags server-side with per-cohort overrides and a 5s TTL"],
  ["backups", "takes incremental snapshots every 6h and verifies restore monthly"],
] as const;

/**
 * Deterministic filler: N plausible project notes (~19 tokens each).
 * `factAt` (0-based) splices the planted fact in as one of the notes.
 */
export function makeFiller(notes: number, factAt: number): string {
  const lines: string[] = [];
  for (let i = 0; i < notes; i++) {
    if (i === factAt) {
      lines.push(`Note ${String(i + 1).padStart(4, "0")}: ${PLANTED_FACT}`);
      continue;
    }
    const [topic, detail] = NOTE_TOPICS[i % NOTE_TOPICS.length];
    lines.push(
      `Note ${String(i + 1).padStart(4, "0")}: The ${topic} service ${detail} (owner: team-${String.fromCharCode(97 + (i % 6))}, since 2024).`,
    );
  }
  return lines.join("\n");
}

export const PROMPT1 =
  "Project context dump (do not analyze, just acknowledge):\n\n" +
  makeFiller(260, 90) +
  "\n\nReply with exactly: OK";

export const PROMPT2 =
  "More project context (do not analyze, just acknowledge):\n\n" +
  makeFiller(160, -1) +
  "\n\nReply with exactly: OK";

/**
 * Filler turn AFTER the semantic_recall hit: its compaction trims the hit turn
 * (task-boundary cut keeps only this turn), pushing the fact out of the live
 * context so item 6 must genuinely recall it.
 */
export const PROMPT3 =
  "More project context (do not analyze, just acknowledge):\n\n" +
  makeFiller(160, -1) +
  "\n\nReply with exactly: OK";

/** Poll the qmd daemon until a query for our collection returns hits (model load spans first queries). */
export async function waitForDaemonHits(
  port: number,
  collection: string,
  query: string,
  timeoutMs: number,
  log: (s: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hits = await daemonQuery(port, collection, query);
      if (hits.length > 0) return true;
      log("daemon: 0 hits yet (indexing or model load), retrying in 5s");
    } catch (e: any) {
      log(`daemon: not ready (${e?.message ?? e}), retrying in 5s`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Minimal JSON-RPC `query` against the daemon (same contract as src/semantic/qmd-daemon.ts). */
export async function daemonQuery(port: number, collection: string, query: string): Promise<any[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "query",
      arguments: {
        searches: [{ type: "vec", query, limit: 5 }],
        collections: [collection],
        rerank: false,
      },
    },
  };
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const dataLine = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : text;
  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(parsed.error.message ?? "rpc error");
  const results = parsed.result?.structuredContent?.results;
  if (!Array.isArray(results)) throw new Error("bad response shape");
  return results;
}

export function vectorDirContents(dir: string): { files: string[]; log: string } {
  if (!existsSync(dir)) return { files: [], log: "(dir missing)" };
  const files = readdirSync(dir).sort();
  const log = files.includes("indexer.log")
    ? readFileSync(join(dir, "indexer.log"), "utf8").trim()
    : "(no indexer.log — clean)";
  return { files, log };
}

export function readSessionJsonl(path: string): any[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function findCompactionEntries(entries: any[]): any[] {
  return entries.filter((e) => e.type === "compaction");
}

const KNOWN_SECTIONS = [
  "Session Goal",
  "User Preferences",
  "Files And Changes",
  "Commits",
  "Type Catalog",
  "Outstanding Context",
  "Earlier Turns",
  "Symbol Changes",
];

export function sectionHeadersPresent(summary: string): string[] {
  return KNOWN_SECTIONS.filter((s) => summary.includes(s));
}

/** Extract tool calls + results for a tool name from pi session messages. */
export function extractToolCalls(messages: any[], toolName: string): Array<{ args: any; result: string }> {
  const out: Array<{ args: any; result: string }> = [];
  const resultsByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolName === toolName) {
      const text = Array.isArray(m.content)
        ? m.content.map((p: any) => p.text ?? "").join("")
        : String(m.content ?? "");
      resultsByCallId.set(m.toolCallId, text);
    }
  }
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.name === toolName) {
        out.push({ args: part.arguments ?? {}, result: resultsByCallId.get(part.id) ?? "" });
      }
    }
  }
  return out;
}
