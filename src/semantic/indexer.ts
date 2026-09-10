/**
 * Fire-and-forget span indexer (Phase 5).
 *
 * `indexSpan()` returns immediately (latency contract: <5ms — it never
 * awaits embed). The background pipeline, per session:
 *
 *   1. prepare (serialized per session via a promise chain, so the
 *      meta.json read-modify-write is race-free):
 *        read meta.json → chunkSpan(startSeq = lastSeq + 1) → write NNNN.md
 *      only for seqs whose sha1 changed (idempotent re-compaction) →
 *      update meta.json
 *   2. embed (coalesced per session): ensureIndex → embed. If an embed is
 *      already in flight, a pending flag is set (at most one queued); the
 *      follow-up embed covers files that landed during the in-flight one.
 *
 * All failures → append to <chunkDir>/indexer.log + injected log sink.
 * indexSpan never throws and never rejects.
 */
import { createHash } from "crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Message } from "@earendil-works/pi-ai";
import { chunkSpan } from "./chunk";
import { DEFAULT_SEMANTIC_CONFIG } from "./config";
import { chunkDir, defaultVectorRoot, sanitizeSessionId } from "./paths";

/** Backend surface the indexer needs (QmdBackend satisfies it). */
export interface IndexerBackend {
  ensureIndex(sessionId: string, dir: string): Promise<void>;
  embed(sessionId: string): Promise<void>;
}

export interface IndexSpanInput {
  sessionId: string;
  messages: Message[];
  backend: IndexerBackend;
  /** Target chunk size in estimated tokens (default: config default). */
  chunkTokens?: number;
  /** Chunk-dir root (default: ~/.pi/vector). Injectable for tests. */
  vectorRoot?: string;
  /** Failure sink (default: console.error). */
  log?: (line: string) => void;
}

export const META_FILE = "meta.json";
export const INDEXER_LOG_FILE = "indexer.log";

/** NNNN.md name for a seq (zero-padded 4 — recall.ts reads the same). */
export function chunkFileName(seq: number): string {
  return `${String(seq).padStart(4, "0")}.md`;
}

/** On-disk content of a chunk file: header + blank line + text. */
export function fileContent(chunk: { header: string; text: string }): string {
  return `${chunk.header}\n\n${chunk.text}`;
}

/** sha1 hex — meta.json idempotency key (see prepareSpan for what is hashed). */
export function fileHash(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

interface Meta {
  lastSeq: number;
  hashes: Record<string, string>;
}

const emptyMeta = (): Meta => ({ lastSeq: 0, hashes: {} });

/** Read meta.json; missing/corrupt → empty (seq restarts at 1). */
function readMeta(dir: string): Meta {
  try {
    const m = JSON.parse(readFileSync(join(dir, META_FILE), "utf-8")) as Partial<Meta>;
    if (typeof m?.lastSeq !== "number" || !Number.isFinite(m.lastSeq)) return emptyMeta();
    return {
      lastSeq: Math.max(0, Math.floor(m.lastSeq)),
      hashes: m.hashes && typeof m.hashes === "object" ? m.hashes : {},
    };
  } catch {
    return emptyMeta();
  }
}

interface SessionState {
  /** Serializes the prepare phase per session (meta read-modify-write). */
  chain: Promise<void>;
  embedding: boolean;
  pendingEmbed: boolean;
}

const sessions = new Map<string, SessionState>();

function stateFor(session: string): SessionState {
  let st = sessions.get(session);
  if (!st) {
    st = { chain: Promise.resolve(), embedding: false, pendingEmbed: false };
    sessions.set(session, st);
  }
  return st;
}

const defaultLog = (line: string): void => console.error(`[pi-vcc-semantic] ${line}`);

/** Log a failure to the sink + indexer.log. Never throws. */
function fail(session: string, input: IndexSpanInput, stage: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const line = `[${new Date().toISOString()}] ${session} ${stage} failed: ${msg}`;
  (input.log ?? defaultLog)(line);
  try {
    const dir = chunkDir(session, input.vectorRoot ?? defaultVectorRoot());
    appendFileSync(join(dir, INDEXER_LOG_FILE), line + "\n");
  } catch {
    // the sink already got the line; never throw from the failure path
  }
}

interface PrepareResult {
  dir: string;
  written: number;
}

/**
 * Read meta, chunk the span, write new files, update meta.
 *
 * Idempotency: the dedup key is the sha1 of the chunk's *text* (not the
 * whole file — the header embeds the seq, so a re-compacted span would get
 * new seqs and file hashes would never collide). A chunk whose text hash
 * already exists at any seq is skipped: re-compaction of the same span
 * writes nothing and triggers no embed.
 */
async function prepareSpan(session: string, input: IndexSpanInput): Promise<PrepareResult> {
  const dir = chunkDir(session, input.vectorRoot ?? defaultVectorRoot());
  const meta = readMeta(dir);
  const chunks = chunkSpan({
    sessionId: session,
    messages: input.messages,
    chunkTokens: input.chunkTokens ?? DEFAULT_SEMANTIC_CONFIG.chunkTokens,
    startSeq: meta.lastSeq + 1,
  });
  let written = 0;
  if (chunks.length > 0) {
    const existing = new Set(Object.values(meta.hashes));
    mkdirSync(dir, { recursive: true });
    for (const c of chunks) {
      const hash = fileHash(c.text);
      if (existing.has(hash)) continue; // same content already indexed → skip
      writeFileSync(join(dir, chunkFileName(c.seq)), fileContent(c));
      meta.hashes[String(c.seq)] = hash;
      existing.add(hash);
      written++;
    }
    if (written > 0) {
      meta.lastSeq = Math.max(meta.lastSeq, chunks[chunks.length - 1].seq);
      writeFileSync(join(dir, META_FILE), JSON.stringify(meta));
    }
  }
  return { dir, written };
}

async function runEmbed(session: string, dir: string, input: IndexSpanInput): Promise<void> {
  await input.backend.ensureIndex(session, dir);
  await input.backend.embed(session);
}

/**
 * Request an embed for the session. In-flight guard + pending flag: at most
 * one embed runs, at most one is queued; the follow-up covers files written
 * during the in-flight embed. Never rejects.
 */
function requestEmbed(session: string, st: SessionState, dir: string, input: IndexSpanInput): void {
  if (st.embedding) {
    st.pendingEmbed = true; // at most one queued
    return;
  }
  st.embedding = true;
  runEmbed(session, dir, input)
    .catch((e) => fail(session, input, "embed", e))
    .then(() => {
      st.embedding = false;
      if (st.pendingEmbed) {
        st.pendingEmbed = false;
        runEmbed(session, dir, input).catch((e) => fail(session, input, "embed", e));
      }
    });
}

/**
 * Drop the per-session state entry (called on session_shutdown reason=quit
 * so the in-flight guard / promise chain don't outlive the session).
 */
export function dropSessionState(sessionId: string): void {
  sessions.delete(sanitizeSessionId(sessionId));
}

/**
 * Index a trimmed span, fire-and-forget. Returns immediately; all work
 * (chunk, write, ensureIndex, embed) happens in the background. Failures
 * are logged, never thrown.
 */
export function indexSpan(input: IndexSpanInput): void {
  const session = sanitizeSessionId(input.sessionId);
  const st = stateFor(session);
  const prepare = st.chain.catch(() => undefined).then(() => prepareSpan(session, input));
  st.chain = prepare.then(
    (r) => {
      if (r.written > 0) requestEmbed(session, st, r.dir, input);
    },
    (e) => fail(session, input, "prepare", e),
  );
}
