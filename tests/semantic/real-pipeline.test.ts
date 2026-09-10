/**
 * Phase 6b — real-shape pipeline test.
 *
 * Closes the fixture-vs-reality gap: loads genuine pi session JSONL files
 * (same support helpers as the inherited real-sessions.test.ts), runs them
 * through the chunker and the indexer (fake backend), and asserts chunk
 * sanity against the real message shapes (content arrays with
 * text/thinking/toolCall/image parts, toolResult messages, bashExecution,
 * custom/compactionSummary roles).
 *
 * The reference for "message boundaries respected" is
 * `messages.flatMap(messageLines)` — the exact per-message line list the
 * packer consumes (oversized parts split, thinking omitted by design).
 * Chunk texts must reassemble to it byte-for-byte: no loss, no reorder,
 * no message split across chunks.
 *
 * Verified against the full local corpus (610 sessions, 32k messages)
 * before pinning these assertions — see docs/implementation-notes.md.
 */
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";
import type { Message } from "@earendil-works/pi-ai";
import { prepareSessionSamples, type SessionSample } from "../support/real-sessions";
import { loadSessionMessages } from "../support/load-session";
import {
  chunkSpan,
  estimateTokens,
  messageLines,
  parseHeader,
} from "../../src/semantic/chunk";
import { DEFAULT_SEMANTIC_CONFIG } from "../../src/semantic/config";
import {
  INDEXER_LOG_FILE,
  META_FILE,
  chunkFileName,
  fileContent,
  fileHash,
  indexSpan,
  type IndexerBackend,
} from "../../src/semantic/indexer";
import { chunkDir } from "../../src/semantic/paths";

const CHUNK_TOKENS = DEFAULT_SEMANTIC_CONFIG.chunkTokens;
const SESSION_ID = "real-pipeline-probe";

interface Loaded {
  sample: SessionSample;
  messages: Message[];
}

let loaded: Loaded[] = [];

beforeAll(async () => {
  const samples = await prepareSessionSamples(3);
  loaded = samples.map((sample) => ({
    sample,
    messages: loadSessionMessages(sample.copy).messages,
  }));
});

const countParts = (messages: Message[], type: string): number => {
  let n = 0;
  for (const m of messages) {
    const c = (m as any).content;
    if (!Array.isArray(c)) continue;
    for (const p of c) if (p?.type === type) n++;
  }
  return n;
};

// ---------------------------------------------------------------------------
// fixture sanity
// ---------------------------------------------------------------------------

describe("real-shape pipeline: fixtures", () => {
  it("loads genuine pi sessions with real message shapes", () => {
    expect(loaded.length).toBe(3);
    let thinking = 0;
    let toolCall = 0;
    const roles = new Set<string>();
    for (const { messages } of loaded) {
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) roles.add((m as any).role);
      thinking += countParts(messages, "thinking");
      toolCall += countParts(messages, "toolCall");
    }
    for (const role of ["user", "assistant", "toolResult"]) {
      expect(roles.has(role)).toBe(true);
    }
    expect(toolCall).toBeGreaterThan(0);
    expect(thinking).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// chunker invariants on real data
// ---------------------------------------------------------------------------

describe("real-shape pipeline: chunker", () => {
  it("respects message boundaries: chunk texts reassemble to per-message lines", () => {
    for (const { messages } of loaded) {
      const chunks = chunkSpan({ sessionId: SESSION_ID, messages, chunkTokens: CHUNK_TOKENS });
      expect(chunks.length).toBeGreaterThan(0);
      const expected = messages.flatMap((m) => messageLines(m, CHUNK_TOKENS));
      expect(expected.length).toBeGreaterThan(0);
      expect(chunks.flatMap((c) => c.text.split("\n"))).toEqual(expected);
    }
  });

  it("no empty chunks, no empty lines, size budget honored", () => {
    for (const { messages } of loaded) {
      for (const c of chunkSpan({ sessionId: SESSION_ID, messages, chunkTokens: CHUNK_TOKENS })) {
        expect(c.text.trim().length).toBeGreaterThan(0);
        expect(c.text.split("\n").every((l) => l.trim().length > 0)).toBe(true);
        expect(estimateTokens(c.text)).toBeLessThanOrEqual(CHUNK_TOKENS);
      }
    }
  });

  it("seq contiguous, turn monotonic, header round-trips, real timestamps", () => {
    for (const { messages } of loaded) {
      const chunks = chunkSpan({ sessionId: SESSION_ID, messages, chunkTokens: CHUNK_TOKENS });
      chunks.forEach((c, i) => {
        expect(c.seq).toBe(i + 1);
        // turn = count of user messages up to the chunk's first message:
        // 0 is valid when the span starts mid-turn (assistant/toolResult first)
        expect(c.turn).toBeGreaterThanOrEqual(0);
        if (i > 0) expect(c.turn).toBeGreaterThanOrEqual(chunks[i - 1].turn);
        const h = parseHeader(c.header);
        expect(h).not.toBeNull();
        expect(h!.session).toBe(SESSION_ID);
        expect(h!.seq).toBe(c.seq);
        expect(h!.turn).toBe(c.turn);
        expect(h!.ts).not.toBe("unknown"); // real messages carry timestamps
        expect(new Date(h!.ts).toISOString()).toBe(h!.ts);
        expect(h!.files).toEqual(c.filesTouched);
      });
    }
  });

  it("toolCall + toolResult content arrays are serialized; filesTouched recorded", () => {
    let sawFileTouched = false;
    for (const { messages } of loaded) {
      const chunks = chunkSpan({ sessionId: SESSION_ID, messages, chunkTokens: CHUNK_TOKENS });
      const lines = chunks.flatMap((c) => c.text.split("\n"));
      expect(lines.some((l) => l.startsWith("[tool: "))).toBe(true);
      expect(lines.some((l) => l.startsWith("[tool_result:"))).toBe(true);
      // thinking is omitted by design — proven by the reassembly invariant
      // (messageLines is the reference and never emits thinking lines)
      for (const c of chunks) {
        if (c.filesTouched.length > 0) sawFileTouched = true;
        for (const f of c.filesTouched) expect(f.length).toBeGreaterThan(0);
      }
    }
    expect(sawFileTouched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// indexer pipeline on real data (fake backend)
// ---------------------------------------------------------------------------

describe("real-shape pipeline: indexer", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-sem-real-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("real span → NNNN.md + meta + single ensureIndex/embed, <5ms return", async () => {
    const { messages } = loaded[0]; // largest session
    const events: string[] = [];
    const backend: IndexerBackend = {
      async ensureIndex(sessionId, dir) {
        events.push(`ensure:${sessionId}:${dir === chunkDir(sessionId, root)}`);
      },
      async embed(sessionId) {
        events.push(`embed:${sessionId}`);
      },
    };

    const t0 = performance.now();
    indexSpan({ sessionId: SESSION_ID, messages, backend, vectorRoot: root, chunkTokens: CHUNK_TOKENS });
    expect(performance.now() - t0).toBeLessThan(5);

    await new Promise((r) => setTimeout(r, 25));

    const expected = chunkSpan({ sessionId: SESSION_ID, messages, chunkTokens: CHUNK_TOKENS });
    const dir = chunkDir(SESSION_ID, root);
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(expected.length);
    for (const c of expected) {
      expect(readFileSync(join(dir, chunkFileName(c.seq)), "utf-8")).toBe(fileContent(c));
    }
    const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf-8"));
    expect(meta.lastSeq).toBe(expected.length);
    for (const c of expected) expect(meta.hashes[c.seq]).toBe(fileHash(c.text));
    expect(events).toEqual([`ensure:${SESSION_ID}:true`, `embed:${SESSION_ID}`]);
    expect(readdirSync(dir).includes(INDEXER_LOG_FILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// synthetic real shapes (deterministic pin of the edge shapes)
// ---------------------------------------------------------------------------

describe("real-shape pipeline: synthetic edge shapes", () => {
  const T0 = Date.parse("2026-09-10T00:00:00Z");
  const msg = (m: any): Message => m as unknown as Message;

  it("assistant [thinking, text, toolCall] → text + toolCall lines, no thinking", () => {
    const m = msg({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SECRET-REASONING-DO-NOT-LEAK" },
        { type: "text", text: "I checked the config." },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/etc/hosts" } },
      ],
      timestamp: T0,
    });
    const chunks = chunkSpan({ sessionId: SESSION_ID, messages: [m], chunkTokens: CHUNK_TOKENS });
    const lines = chunks.flatMap((c) => c.text.split("\n"));
    expect(lines).toEqual([
      "[assistant] I checked the config.",
      "[tool: read] path=/etc/hosts",
    ]);
    expect(lines.join("\n")).not.toContain("SECRET-REASONING-DO-NOT-LEAK");
    expect(chunks[0].filesTouched).toEqual(["/etc/hosts"]);
  });

  it("toolResult content array (text + image) → single line with placeholder", () => {
    const m = msg({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "screenshot",
      content: [
        { type: "text", text: "captured\nthe screen" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: T0,
    });
    const chunks = chunkSpan({ sessionId: SESSION_ID, messages: [m], chunkTokens: CHUNK_TOKENS });
    expect(chunks.flatMap((c) => c.text.split("\n"))).toEqual([
      "[tool_result:screenshot] captured the screen [image:image/png]",
    ]);
  });

  it("user array content (text + image) and bashExecution are handled", () => {
    const user = msg({
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
      ],
      timestamp: T0,
    });
    const bash = msg({ role: "bashExecution", command: "ls -la", output: "total 0\n", exitCode: 0, timestamp: T0 });
    const chunks = chunkSpan({ sessionId: SESSION_ID, messages: [user, bash], chunkTokens: CHUNK_TOKENS });
    expect(chunks.flatMap((c) => c.text.split("\n"))).toEqual([
      "[user] look at this",
      "[user] [image:image/jpeg]",
      "[bash] ls -la",
      "[tool_result:bash] total 0",
    ]);
  });

  it("custom and compactionSummary roles are dropped without crashing", () => {
    const custom = msg({ role: "custom", content: "a custom note", display: true, timestamp: T0 });
    const summary = msg({ role: "compactionSummary", content: undefined, timestamp: T0 });
    const user = msg({ role: "user", content: "hello", timestamp: T0 });
    const chunks = chunkSpan({ sessionId: SESSION_ID, messages: [custom, summary, user], chunkTokens: CHUNK_TOKENS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("[user] hello");
  });
});
