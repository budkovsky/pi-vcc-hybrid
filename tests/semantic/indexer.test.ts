import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performance } from "perf_hooks";
import type { Message } from "@earendil-works/pi-ai";
import {
  INDEXER_LOG_FILE,
  META_FILE,
  chunkFileName,
  fileContent,
  fileHash,
  indexSpan,
  type IndexerBackend,
} from "../../src/semantic/indexer";
import { DEFAULT_SEMANTIC_CONFIG } from "../../src/semantic/config";
import { chunkSpan } from "../../src/semantic/chunk";
import { chunkDir } from "../../src/semantic/paths";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-07-10T12:00:00Z");
const user = (text: string, ts: number): Message =>
  ({ role: "user", content: text, timestamp: ts }) as unknown as Message;
const assistant = (text: string, ts: number): Message =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts }) as unknown as Message;

const SPAN_1: Message[] = [
  user("when does the nightly backup run?", T0),
  assistant("The backup cron runs at 03:15 UTC.", T0 + 1_000),
];
const SPAN_2: Message[] = [
  user("where is the deploy key stored?", T0 + 60_000),
  assistant("The deploy key lives in 1Password.", T0 + 61_000),
];

// small chunkTokens → every message becomes its own chunk (4 chunks total)
const SPAN_MULTI: Message[] = [
  user("alpha ".repeat(60), T0),
  assistant("beta ".repeat(60), T0 + 1_000),
  user("gamma ".repeat(60), T0 + 2_000),
  assistant("delta ".repeat(60), T0 + 3_000),
];
const MULTI_CHUNK_TOKENS = 100;

// ---------------------------------------------------------------------------
// fake backend
// ---------------------------------------------------------------------------

interface EmbedRecord {
  sessionId: string;
  promise: Promise<void>;
}

function makeFakeBackend() {
  const ensureCalls: { sessionId: string; dir: string }[] = [];
  const embeds: EmbedRecord[] = [];
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  // When set, holds the FIRST embed until its release() is called; later
  // embeds (follow-ups) auto-resolve.
  let hold: ((release: () => void) => void) | null = null;
  let embedError: Error | null = null;

  const backend: IndexerBackend = {
    async ensureIndex(sessionId, dir) {
      ensureCalls.push({ sessionId, dir });
      events.push(`ensure:${sessionId}`);
    },
    embed(sessionId) {
      const isHeld = hold !== null && embeds.length === 0;
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`embed:${sessionId}`);
      const promise = new Promise<void>((resolve, reject) => {
        const done = (): void => {
          active--;
          resolve();
        };
        if (embedError) {
          const err = embedError;
          embedError = null;
          active--;
          reject(err);
          return;
        }
        if (isHeld) hold!(done);
        else setTimeout(done, 0);
      });
      embeds.push({ sessionId, promise });
      return promise;
    },
  };

  return {
    backend,
    ensureCalls,
    embeds,
    events,
    maxActive: (): number => maxActive,
    holdEmbeds(fn: (release: () => void) => void): void {
      hold = fn;
    },
    failEmbed(msg: string): void {
      embedError = new Error(msg);
    },
    waitAll: async (): Promise<void> => {
      await Promise.all(embeds.map((e) => e.promise.catch(() => {})));
    },
  };
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let root: string;
let n = 0;
const sid = (): string => `s${++n}`;
const flush = async (ms = 5): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-sem-indexer-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const readMeta = (id: string): { lastSeq: number; hashes: Record<string, string> } =>
  JSON.parse(readFileSync(join(chunkDir(id, root), META_FILE), "utf-8"));

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("chunkFileName / fileContent / fileHash", () => {
  it("zero-pads seq to 4 digits", () => {
    expect(chunkFileName(1)).toBe("0001.md");
    expect(chunkFileName(42)).toBe("0042.md");
    expect(chunkFileName(12345)).toBe("12345.md");
  });
  it("file content is header + blank line + text", () => {
    expect(fileContent({ header: "H", text: "T" })).toBe("H\n\nT");
  });
  it("hash is stable sha1 hex", () => {
    expect(fileHash("abc")).toBe(fileHash("abc"));
    expect(fileHash("abc")).not.toBe(fileHash("abd"));
    expect(fileHash("abc")).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

describe("indexSpan happy path", () => {
  it("span → NNNN.md with header + text → ensureIndex then embed, once each, in order", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();

    const dir = chunkDir(id, root);
    const expected = chunkSpan({
      sessionId: id,
      messages: SPAN_1,
      chunkTokens: DEFAULT_SEMANTIC_CONFIG.chunkTokens,
    });
    expect(expected).toHaveLength(1);
    const onDisk = readFileSync(join(dir, "0001.md"), "utf-8");
    expect(onDisk).toBe(fileContent(expected[0]));
    expect(onDisk).toContain(`session=${id} seq=1 turn=1 ts=${new Date(T0).toISOString()} files= -->`);
    expect(onDisk).toContain("[user] when does the nightly backup run?");
    expect(onDisk).toContain("[assistant] The backup cron runs at 03:15 UTC.");

    const meta = readMeta(id);
    expect(meta.lastSeq).toBe(1);
    expect(meta.hashes).toEqual({ 1: fileHash(expected[0].text) });

    expect(fb.ensureCalls).toEqual([{ sessionId: id, dir }]);
    expect(fb.embeds).toHaveLength(1);
    expect(fb.embeds[0].sessionId).toBe(id);
    expect(fb.events).toEqual([`ensure:${id}`, `embed:${id}`]);
  });

  it("multi-chunk span → one file per chunk, single ensureIndex + embed", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    indexSpan({
      sessionId: id,
      messages: SPAN_MULTI,
      backend: fb.backend,
      vectorRoot: root,
      chunkTokens: MULTI_CHUNK_TOKENS,
    });
    await flush();
    await fb.waitAll();

    const expected = chunkSpan({
      sessionId: id,
      messages: SPAN_MULTI,
      chunkTokens: MULTI_CHUNK_TOKENS,
    });
    expect(expected.length).toBeGreaterThan(1);
    const meta = readMeta(id);
    expect(meta.lastSeq).toBe(expected.length);
    for (const c of expected) {
      expect(readFileSync(join(chunkDir(id, root), chunkFileName(c.seq)), "utf-8")).toBe(fileContent(c));
      expect(meta.hashes[c.seq]).toBe(fileHash(c.text));
    }
    expect(fb.ensureCalls).toHaveLength(1);
    expect(fb.embeds).toHaveLength(1);
  });

  it("empty span → nothing written, no backend calls, no log", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    const logs: string[] = [];
    indexSpan({ sessionId: id, messages: [], backend: fb.backend, vectorRoot: root, log: (l) => logs.push(l) });
    await flush();
    expect(existsSync(chunkDir(id, root))).toBe(false);
    expect(fb.ensureCalls).toHaveLength(0);
    expect(fb.embeds).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// idempotency + sequencing
// ---------------------------------------------------------------------------

describe("indexSpan idempotency + sequencing", () => {
  it("re-call with the same span → no duplicate writes, no second embed", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();
    const first = readFileSync(join(chunkDir(id, root), "0001.md"), "utf-8");
    const meta1 = readMeta(id);

    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();

    expect(readFileSync(join(chunkDir(id, root), "0001.md"), "utf-8")).toBe(first);
    expect(readMeta(id)).toEqual(meta1);
    expect(fb.ensureCalls).toHaveLength(1);
    expect(fb.embeds).toHaveLength(1);
  });

  it("second span continues seq from meta.lastSeq", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();
    indexSpan({ sessionId: id, messages: SPAN_2, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();

    const dir = chunkDir(id, root);
    expect(existsSync(join(dir, "0001.md"))).toBe(true);
    expect(existsSync(join(dir, "0002.md"))).toBe(true);
    const meta = readMeta(id);
    expect(meta.lastSeq).toBe(2);
    expect(Object.keys(meta.hashes).sort()).toEqual(["1", "2"]);
    const c2 = chunkSpan({
      sessionId: id,
      messages: SPAN_2,
      chunkTokens: DEFAULT_SEMANTIC_CONFIG.chunkTokens,
      startSeq: 2,
    });
    expect(readFileSync(join(dir, "0002.md"), "utf-8")).toBe(fileContent(c2[0]));
    expect(readFileSync(join(dir, "0002.md"), "utf-8")).toContain("seq=2");
    expect(fb.embeds).toHaveLength(2);
  });

  it("corrupt meta.json → treated as empty (starts at seq 1)", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    const dir = chunkDir(id, root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, META_FILE), "not json");
    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();
    expect(existsSync(join(dir, "0001.md"))).toBe(true);
    expect(readMeta(id).lastSeq).toBe(1);
  });

  it("meta.json with valid lastSeq but bogus hashes → continues seq, rewrites nothing new", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    const dir = chunkDir(id, root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, META_FILE), JSON.stringify({ lastSeq: 3, hashes: "bogus" }));
    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();
    expect(existsSync(join(dir, "0004.md"))).toBe(true);
    expect(readMeta(id).lastSeq).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------

describe("indexSpan failures (logged, never thrown)", () => {
  it("embed failure → indexer.log + log sink; state consistent; next span retries", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    const logs: string[] = [];
    fb.failEmbed("embed boom");
    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root, log: (l) => logs.push(l) });
    await flush();
    await fb.waitAll();

    const dir = chunkDir(id, root);
    const logFile = readFileSync(join(dir, INDEXER_LOG_FILE), "utf-8");
    expect(logFile).toContain("embed boom");
    expect(logFile).toContain(id);
    expect(logs.some((l) => l.includes("embed boom"))).toBe(true);

    // state stays consistent: files + meta written, no lingering embeds
    expect(existsSync(join(dir, "0001.md"))).toBe(true);
    expect(readMeta(id).lastSeq).toBe(1);
    expect(fb.embeds).toHaveLength(1);

    // next span retries (and succeeds this time)
    indexSpan({ sessionId: id, messages: SPAN_2, backend: fb.backend, vectorRoot: root, log: (l) => logs.push(l) });
    await flush();
    await fb.waitAll();
    expect(fb.embeds).toHaveLength(2);
    expect(existsSync(join(dir, "0002.md"))).toBe(true);
  });

  it("ensureIndex failure → logged, embed not called", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    const logs: string[] = [];
    const backend: IndexerBackend = {
      ensureIndex: async () => {
        throw new Error("collection add boom");
      },
      embed: fb.backend.embed,
    };
    indexSpan({ sessionId: id, messages: SPAN_1, backend, vectorRoot: root, log: (l) => logs.push(l) });
    await flush();
    await fb.waitAll();

    const dir = chunkDir(id, root);
    expect(readFileSync(join(dir, INDEXER_LOG_FILE), "utf-8")).toContain("collection add boom");
    expect(logs.some((l) => l.includes("collection add boom"))).toBe(true);
    expect(fb.embeds).toHaveLength(0);
    // files + meta still written (prepare succeeded)
    expect(readMeta(id).lastSeq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// concurrency + latency contracts
// ---------------------------------------------------------------------------

describe("indexSpan concurrency + latency contracts", () => {
  it("concurrent indexSpan calls → single embed in flight, one follow-up queued", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    let release: (() => void) | null = null;
    fb.holdEmbeds((rel) => {
      release = rel;
    });

    indexSpan({ sessionId: id, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    expect(fb.embeds).toHaveLength(1); // span1's embed in flight (held)

    indexSpan({ sessionId: id, messages: SPAN_2, backend: fb.backend, vectorRoot: root });
    await flush();
    expect(fb.embeds).toHaveLength(1); // span2's embed queued, not started
    expect(existsSync(join(chunkDir(id, root), "0002.md"))).toBe(true); // files written regardless

    release!();
    await flush();
    await fb.waitAll();
    await flush();
    await fb.waitAll();

    expect(fb.embeds).toHaveLength(2); // follow-up embed covered span2's files
    expect(fb.maxActive()).toBe(1);
    expect(readMeta(id).lastSeq).toBe(2);
  });

  it("indexSpan returns in <5ms (never awaits embed)", async () => {
    const fb = makeFakeBackend();
    const id = sid();
    fb.holdEmbeds(() => {}); // never released — awaiting embed would hang the test
    const t0 = performance.now();
    indexSpan({ sessionId: id, messages: SPAN_MULTI, backend: fb.backend, vectorRoot: root });
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// session isolation + sanitization
// ---------------------------------------------------------------------------

describe("indexSpan session handling", () => {
  it("sanitizes sessionId for paths", async () => {
    const fb = makeFakeBackend();
    indexSpan({ sessionId: "a/b/../c", messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();
    expect(existsSync(join(root, "a_b_c", "0001.md"))).toBe(true);
    expect(fb.ensureCalls[0].sessionId).toBe("a_b_c");
  });

  it("different sessions are isolated (state, files, embeds)", async () => {
    const fb = makeFakeBackend();
    const a = sid();
    const b = sid();
    indexSpan({ sessionId: a, messages: SPAN_1, backend: fb.backend, vectorRoot: root });
    indexSpan({ sessionId: b, messages: SPAN_2, backend: fb.backend, vectorRoot: root });
    await flush();
    await fb.waitAll();
    expect(existsSync(join(chunkDir(a, root), "0001.md"))).toBe(true);
    expect(existsSync(join(chunkDir(b, root), "0001.md"))).toBe(true);
    expect(readMeta(a).lastSeq).toBe(1);
    expect(readMeta(b).lastSeq).toBe(1);
    expect(fb.embeds.map((e) => e.sessionId).sort()).toEqual([a, b]);
  });
});
