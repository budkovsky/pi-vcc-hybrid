/**
 * Phase 7b — tuning matrix (LLM-free, real qmd, CPU).
 *
 * Measures how chunkTokens (1000/1500/2500) and limit (3/5/10) affect recall
 * quality, without an LLM: the real chunker (`chunkSpan`) over a deterministic
 * multi-fact corpus, embedded by real qmd into a throwaway index (one daemon,
 * one model load, three collections — one per chunkTokens), then each planted
 * fact is queried by a paraphrase with near-zero keyword overlap and the
 * rank of the fact's chunk is recorded.
 *
 * hit@L is derived from a single limit=10 query per (config, fact):
 *   hit@1 = rank === 1, hit@L = rank <= L.
 *
 * Hermetic: throwaway index + random port + tmpdir chunk dirs; nothing
 * touches the shared "pi-semantic" index or the user's daemon on 8390.
 *
 * Run: bun scripts/tuning-matrix.ts   (needs qmd + cached embedding model)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

// --- corpus ------------------------------------------------------------------

/**
 * Filler: 30 services × 30 actions = 900 UNIQUE notes (no repeated lines —
 * repeated boilerplate makes every chunk ~97% identical and dilutes the
 * planted fact far more than a real, diverse session would).
 * Deliberately distinct from the planted facts below.
 */
const SERVICES = [
  "billing", "search", "auth", "ingest", "reports", "gateway", "mobile", "etl",
  "scheduler", "audit", "cdn", "webhooks", "storage", "telemetry", "rate-limit",
  "feature-flags", "backups", "ledger", "media", "proxy", "notifications",
  "wallet", "geo", "fraud", "config", "jobs", "siem", "cache", "queue", "registry",
] as const;
const ACTIONS = [
  "retries failed jobs with exponential backoff",
  "caches query results in a local LRU",
  "rotates session tokens on a fixed cadence",
  "batches rows into files before upload",
  "renders exports with a hard page limit",
  "sheds load by dropping low-priority work first",
  "syncs offline edits with a bounded conflict window",
  "dedupes events by a natural key",
  "schedules work with random jitter",
  "hash-chains log entries for tamper evidence",
  "purges stale objects by tag",
  "signs payloads with a shared secret",
  "highlights matched terms in results",
  "prorates charges when a plan changes",
  "coalesces digests per recipient",
  "tiers objects by age into hot and cold",
  "samples traces adaptively under load",
  "applies token buckets per client key",
  "evaluates flags server-side with overrides",
  "takes incremental snapshots on a timer",
  "aggregates counters into 1-minute windows",
  "persists offsets to a write-ahead log",
  "streams media segments with short duration",
  "rebuilds index shards in the background",
  "shards keyspace by tenant hash",
  "rounds metered usage to four decimals",
  "canaries a slice of traffic before rollout",
  "compresses archives before transfer",
  "enforces per-tenant quotas with a sliding window",
  "partitions data by day and region",
] as const;

interface Fact {
  /** The sentence planted in the corpus (as one "Note NNNN:" line). */
  fact: string;
  /** Distinctive tokens that prove the fact's chunk was returned. */
  tokens: string[];
  /** Paraphrase with near-zero keyword overlap with the fact. */
  query: string;
}

const FACTS: Fact[] = [
  {
    fact: "The backup passphrase for the staging database replica (host amber-otter) is rotated by the night-shift ops team every Tuesday at 03:15 UTC.",
    tokens: ["amber-otter", "03:15", "Tuesday"],
    query:
      "which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time",
  },
  {
    fact: "The load balancer evicts idle keep-alive connections after 75 seconds and caps concurrent sockets at 4096 per worker process.",
    tokens: ["keep-alive", "4096"],
    query:
      "how long can an unused connection sit open on the edge proxy before it gets dropped, and what is the per-process socket ceiling",
  },
  {
    fact: "The image pipeline converts HEIC phone uploads to WebP at 82 percent quality and strips GPS metadata.",
    tokens: ["HEIC", "WebP", "GPS"],
    query: "what format do phone photos get converted to on ingest, and which location data is removed",
  },
  {
    fact: "The invoice exporter caps PDF pages at 12 and switches to XLSX output when the line count exceeds 5000.",
    tokens: ["XLSX", "5000"],
    query: "when does billing output switch from the printable format to a spreadsheet, and what is the page ceiling",
  },
  {
    fact: "The cache warmup job preloads the top 200 product pages every 15 minutes between 06:00 and 22:00 UTC.",
    tokens: ["top 200", "06:00"],
    query: "how often is the popular-content cache refreshed during business hours, and what does it cover",
  },
  {
    fact: "The mobile sync engine resolves conflicting edits with vector clocks and keeps a 30-day tombstone window for deletions.",
    tokens: ["vector clocks", "tombstone"],
    query: "what mechanism does the offline client use to order competing edits, and how long are deleted records remembered",
  },
  {
    fact: "The metrics pipeline samples traces at 10 percent but forces full capture for requests slower than 1 second.",
    tokens: ["10 percent", "full capture"],
    query: "when does request tracing stop being sampled, and what is the normal capture rate",
  },
  {
    fact: "The signing service replaces its key material every 12 hours and tolerates 90 seconds of clock drift between machines.",
    tokens: ["key material", "12 hours"],
    query:
      "how frequently are the authentication credentials of the signature service replaced, and how much time skew between machines is allowed",
  },
  {
    fact: "The chat history is encrypted at rest with AES-256-GCM, and the keys live in the HSM under alias chat-root.",
    tokens: ["AES-256-GCM", "chat-root"],
    query: "how are private messages protected on disk, and where do the decryption keys live",
  },
  {
    fact: "The on-call rotation for the payments cluster runs in pairs, with handovers at 08:00 and 20:00 UTC.",
    tokens: ["handovers", "08:00", "20:00"],
    query: "who watches the money-moving stack, in what team size, and when do the shifts change",
  },
  {
    fact: "The rate limiter returns 429 with a Retry-After header and resets the bucket every 60 seconds.",
    tokens: ["Retry-After", "60 seconds"],
    query: "what does the API tell a client when it goes over budget, and how often does the budget refill",
  },
  {
    fact: "The search suggestions are capped at 8 entries and expire after 24 hours unless re-queried.",
    tokens: ["8 entries", "24 hours"],
    query: "how many autocomplete candidates can the user see, and how stale can they get",
  },
  {
    fact: "The video transcoder falls back to software encoding when the GPU pool is saturated.",
    tokens: ["software encoding", "GPU pool"],
    query: "what happens to video rendering when all hardware accelerators are busy",
  },
  {
    fact: "The payment webhook retries use a 5-minute base delay and give up after 7 attempts.",
    tokens: ["5-minute base delay", "7 attempts"],
    query: "how does the billing notifier handle a down receiver, and when does it stop trying",
  },
  {
    fact: "The user avatars are stored in a CDN bucket with a 24-hour signed-URL TTL.",
    tokens: ["avatars", "signed-URL"],
    query: "where do profile pictures live, and for how long is a fetched link valid",
  },
  {
    fact: "The import wizard rejects CSV files larger than 20 MB and splits them into 10k-row batches.",
    tokens: ["20 MB", "10k-row"],
    query: "what size limit does the spreadsheet importer have, and how big are the processing slices",
  },
  {
    fact: "The email digest sends at most 30 items and truncates subject lines at 60 characters.",
    tokens: ["30 items", "60 characters"],
    query: "how long can a headline be in the daily summary, and what is the item cap",
  },
  {
    fact: "The session cookies are http-only, rotated on every privilege change, and expire after 12 hours.",
    tokens: ["http-only", "privilege change"],
    query: "how do browser credentials get refreshed, and how long can a signed-in browser stay valid",
  },
  {
    fact: "The log redaction filter masks anything matching the PAN pattern before lines leave the host.",
    tokens: ["PAN pattern", "redaction"],
    query: "what card-number protection happens before log lines are shipped off the machine",
  },
  {
    fact: "The feature rollout for the new checkout is gated to 5 percent of EU traffic until Friday.",
    tokens: ["5 percent", "EU traffic"],
    query: "how much of the European audience can see the new payment flow right now, and until when",
  },
  {
    fact: "The database replica lags the primary by no more than 30 seconds under normal load.",
    tokens: ["30 seconds", "primary"],
    query: "how far behind can the read-only copy of the main database run",
  },
  {
    fact: "The ticket attachments are virus-scanned and quarantined for 48 hours before delivery.",
    tokens: ["quarantined", "48 hours"],
    query: "what security step do file uploads go through, and how long are they held back",
  },
  {
    fact: "The pricing page caches tax rates per country for 6 hours.",
    tokens: ["tax rates", "6 hours"],
    query: "how fresh are the duty figures shown to buyers",
  },
  {
    fact: "The nightly reconciliation compares ledger totals and alerts when the difference exceeds 0.01 percent.",
    tokens: ["0.01 percent", "reconciliation"],
    query: "what tolerance triggers an alarm in the end-of-day money check",
  },
];

const NOTES_PER_BLOCK = 300;
const BLOCKS = 3; // 900 notes total, 24 facts planted at fixed positions
// 24 evenly-spaced 0-based note indices (every 37.5 notes).
const FACT_POSITIONS = Array.from({ length: 24 }, (_, k) => Math.round((k + 0.5) * 37.5));

/** Deterministic note lines: 900 unique filler notes + the 8 planted facts. */
function makeNoteLines(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < NOTES_PER_BLOCK * BLOCKS; i++) {
    const pos = FACT_POSITIONS.indexOf(i);
    if (pos >= 0) {
      lines.push(`Note ${String(i + 1).padStart(4, "0")}: ${FACTS[pos].fact}`);
    } else {
      const svc = SERVICES[i % SERVICES.length];
      const action = ACTIONS[Math.floor(i / SERVICES.length) % ACTIONS.length];
      lines.push(
        `Note ${String(i + 1).padStart(4, "0")}: The ${svc} service ${action} (owner: team-${String.fromCharCode(97 + (i % 6))}, region: r${(i % 5) + 1}, since 20${20 + (i % 5)}).`,
      );
    }
  }
  return lines;
}

/** Pi-native messages mirroring a real session: user dump → "OK" → repeat. */
function buildMessages(): any[] {
  const notes = makeNoteLines();
  const base = Date.parse("2026-09-11T00:00:00Z");
  const msgs: any[] = [];
  for (let b = 0; b < BLOCKS; b++) {
    const block = notes.slice(b * NOTES_PER_BLOCK, (b + 1) * NOTES_PER_BLOCK).join("\n");
    msgs.push({ role: "user", content: `Project context dump (do not analyze, just acknowledge):\n\n${block}\n\nReply with exactly: OK`, timestamp: base + b * 2 * 60_000 });
    msgs.push({
      role: "assistant",
      content: [{ type: "text", text: `OK (#${b + 1})` }],
      timestamp: base + b * 2 * 60_000 + 60_000,
    });
  }
  return msgs;
}

// --- qmd ---------------------------------------------------------------------

const { chunkSpan } = await import("../src/semantic/chunk");
const { fileContent } = await import("../src/semantic/indexer");
const { QmdBackend } = await import("../src/semantic/qmd");

const CHUNK_TOKENS_LIST = [1000, 1500, 2500];
const LIMITS = [3, 5, 10];

/**
 * Decision (2026-09-10, user-approved): keep defaults chunkTokens=1500, limit=5.
 * - 2500 wins recall on this corpus (hit@5 18/24 vs 15/24) but each returned
 *   hit is 1.67× the context (limit × chunkTokens tokens pasted per call), and
 *   part of its hit@10 edge is corpus coverage (top-10 of 15 chunks = 67%).
 * - 1000 is strictly worse (more chunks to embed, no recall benefit).
 * - 1500/5 is the balanced point and is the config proven end-to-end in the
 *   Phase 7a live run (spontaneous semantic_recall + correct answer).
 * Users who value recall over context cost can raise chunkTokens to 2500.
 */
const DECISION = [
  "**Keep defaults: `chunkTokens: 1500`, `limit: 5`.**",
  "",
  "- 2500 wins recall on this corpus (hit@5 18/24 vs 15/24) but each returned hit is 1.67× the",
  "  context (limit × chunkTokens tokens pasted per call), and part of its hit@10 edge is corpus",
  "  coverage (top-10 of 15 chunks = 67% of the index).",
  "- 1000 is strictly worse: more chunks to embed, no recall benefit.",
  "- 1500/5 is the balanced point and the config proven end-to-end in the Phase 7a live run",
  "  (spontaneous `semantic_recall` + correct answer).",
  "- Users who value recall over context cost can raise `chunkTokens` to 2500.",
].join("\n");
const INDEX = `pi-sem-tune-${Date.now()}`;
const PORT = 8400 + Math.floor(Math.random() * 100); // away from 8390/8391
const TMP = mkdtempSync(join(tmpdir(), "tune-"));

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

/** Write one config's chunks as NNNN.md (indexer format) into its own dir. */
function writeChunks(chunkTokens: number, messages: any[]): { dir: string; count: number } {
  const dir = join(TMP, `ct${chunkTokens}`);
  mkdirSync(dir, { recursive: true });
  const chunks = chunkSpan({ sessionId: `tune-ct${chunkTokens}`, messages, chunkTokens });
  for (const c of chunks) writeFileSync(join(dir, `${String(c.seq).padStart(4, "0")}.md`), fileContent(c));
  return { dir, count: chunks.length };
}

/** All tokens of fact i present in the chunk file? (disk is ground truth) */
function chunkHasFact(dir: string, file: string, fact: Fact): boolean {
  const p = join(dir, file.split("/").pop() ?? file);
  try {
    const text = readFileSync(p, "utf8");
    return fact.tokens.every((t) => text.includes(t));
  } catch {
    return false;
  }
}

/** Rank of the fact's chunk in a limit=10 search (1-based; null = not in top 10). */
async function rankFact(backend: QmdBackend, coll: string, dir: string, fact: Fact): Promise<number | null> {
  const hits = await backend.search(coll, fact.query, { limit: 10 });
  for (let i = 0; i < hits.length; i++) {
    const rel = (hits[i].file as string).split("/").pop();
    if (rel && chunkHasFact(dir, rel, fact)) return i + 1;
  }
  return null;
}

async function main(): Promise<void> {
  const messages = buildMessages();
  const backend = new QmdBackend({
    indexName: INDEX,
    daemonPort: PORT,
    gpu: "cpu",
    healthTimeoutMs: 60_000,
    timeoutMs: 120_000,
    log: (s) => log(`qmd: ${s}`),
  });

  log(`index ${INDEX} (throwaway), daemon port ${PORT}, corpus ${NOTES_PER_BLOCK * BLOCKS} notes / ${FACTS.length} facts`);
  const dirs: Record<number, string> = {};
  const chunkCounts: Record<number, number> = {};
  for (const ct of CHUNK_TOKENS_LIST) {
    const { dir, count } = writeChunks(ct, messages);
    dirs[ct] = dir;
    chunkCounts[ct] = count;
    await backend.ensureIndex(`tune-ct${ct}`, dir);
    await backend.embed(`tune-ct${ct}`);
    log(`ct${ct}: ${count} chunks written + embedded`);
  }
  await backend.ensureDaemon();

  // First query may span the one-time model load — wait until any hits come back.
  log("waiting for daemon readiness (model load can span the first queries)…");
  for (let i = 0; i < 40; i++) {
    try {
      const hits = await backend.search("tune-ct1000", FACTS[0].query, { limit: 10 });
      if (hits.length > 0) break;
    } catch {
      /* daemon still warming */
    }
    log(`  no hits yet, retrying in 5s (${i + 1}/40)`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ranks[ct][factIdx] = rank | null
  const ranks: Record<number, (number | null)[]> = {};
  for (const ct of CHUNK_TOKENS_LIST) {
    const coll = `tune-ct${ct}`;
    ranks[ct] = [];
    for (let f = 0; f < FACTS.length; f++) {
      ranks[ct][f] = await rankFact(backend, coll, dirs[ct], FACTS[f]);
    }
    log(`ct${ct}: ranks [${ranks[ct].join(", ")}]`);
  }

  // --- report -----------------------------------------------------------------
  const hitAt = (ct: number, L: number) => ranks[ct].filter((r) => r !== null && r <= L).length;
  const n = FACTS.length;
  const rows = CHUNK_TOKENS_LIST.map(
    (ct) =>
      `| ${ct} | ${chunkCounts[ct]} | ${hitAt(ct, 1)}/${n} | ${LIMITS.map((L) => `${hitAt(ct, L)}/${n}`).join(" | ")}`,
  );
  const rankRows = FACTS.map((f, i) =>
    `| ${i + 1}. ${f.query.slice(0, 60)}… | ${CHUNK_TOKENS_LIST.map((ct) => ranks[ct][i] ?? "—").join(" | ")}`,
  );
  const report = [
    `# Phase 7b — tuning matrix evidence`,
    ``,
    `- Date: ${new Date().toISOString()}`,
    `- Harness: \`scripts/tuning-matrix.ts\` (LLM-free; real chunker + real qmd, CPU, throwaway index \`${INDEX}\`)`,
    `- Corpus: ${NOTES_PER_BLOCK * BLOCKS} deterministic notes (~${Math.round((NOTES_PER_BLOCK * BLOCKS * 160) / 4)} tokens), ${FACTS.length} planted facts, one paraphrase query per fact (near-zero keyword overlap)`,
    `- Method: per chunkTokens → real \`chunkSpan\` → NNNN.md → embed → limit=10 vsearch per fact → rank of the fact's chunk (disk-verified tokens)`,
    ``,
    `## hit@k (facts found / ${n})`,
    ``,
    `| chunkTokens | chunks | hit@1 | ${LIMITS.map((L) => `hit@${L}`).join(" | ")} |`,
    `|---|---|---|${LIMITS.map(() => "---").join(" | ")}|`,
    ...rows,
    ``,
    `## Per-fact rank (limit=10; — = not in top 10)`,
    ``,
    `| query | ${CHUNK_TOKENS_LIST.map((ct) => `ct${ct}`).join(" | ")} |`,
    `|---|${CHUNK_TOKENS_LIST.map(() => "---").join(" | ")}|`,
    ...rankRows,
    ``,
    `## Decision`,
    ``,
    DECISION,
    ``,
  ].join("\n");
  const reportPath = resolve(process.cwd(), "docs/validation/phase7b-evidence.md");
  mkdirSync(join("docs", "validation"), { recursive: true });
  writeFileSync(reportPath, report);
  log(`report → ${reportPath}`);
  console.log("\n" + report);

  // --- cleanup ------------------------------------------------------------------
  for (const ct of CHUNK_TOKENS_LIST) await backend.remove(`tune-ct${ct}`).catch(() => {});
  await backend.stopDaemon().catch(() => {});
  rmSync(TMP, { recursive: true, force: true });
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(join(homedir(), ".cache", "qmd", `${INDEX}.sqlite${suffix}`), { force: true });
  }
  log("cleaned up (collections, daemon, tmpdir, sqlite)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
