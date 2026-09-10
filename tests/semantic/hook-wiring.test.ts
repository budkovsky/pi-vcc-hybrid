/**
 * Phase 6a — hook wiring tests.
 *
 * Asserts that registerBeforeCompactHook, when given semantic wiring opts,
 * hands the trimmed span to the indexer after the VCC summary is compiled:
 *   - indexSpan receives the summarized messages (not the kept tail)
 *   - chunk files land in the session's vector dir
 *   - a failing backend cannot break compaction (result unchanged)
 *   - disabled config / missing opts / missing getSessionId → no-op, no throw
 *
 * Pattern follows tests/before-compact-hook.test.ts (mock pi + event).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../../src/hooks/before-compact";
import { DEFAULT_SEMANTIC_CONFIG } from "../../src/semantic/config";
import type { SemanticHookOptions } from "../../src/semantic/hook-bridge";

let tmpDir: string;
let CONFIG_PATH: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-hookwiring-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ debug: false, overrideDefaultCompaction: false }));
});

afterEach(() => {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
});

const flush = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeBackend {
  calls: string[];
  ensureIndex: (sid: string, dir: string) => Promise<void>;
  embed: (sid: string) => Promise<void>;
}

function makeFakeBackend(overrides: Partial<Record<string, unknown>> = {}): FakeBackend & Record<string, unknown> {
  const calls: string[] = [];
  return {
    calls,
    ensureIndex: async (sid: string, dir: string) => {
      calls.push(`ensureIndex:${sid}`);
    },
    embed: async (sid: string) => {
      calls.push(`embed:${sid}`);
    },
    ...overrides,
  };
}

function createMockPi(sessionId?: string) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getEntries: () => [],
      ...(sessionId !== undefined ? { getSessionId: () => sessionId } : {}),
    },
    ui: { notify: () => {} },
  };
  const pi = {
    on: (eventName: string, handler: (event: any, context: any) => any) => {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
  } as any;
  return {
    pi,
    invoke: (event: any) => handlers.get("session_before_compact")![0](event, ctx),
  };
}

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

function makeEvent(branchEntries: any[], customInstructions?: string) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
    },
    signal: new AbortController().signal,
  };
}

/**
 * Entries where the own-cut summarizes [m1, m2] and keeps [m3]:
 * trimmed span = user "go" + assistant "work"; kept tail = user "continue".
 */
const ENTRIES = [
  msg("m1", "user", "go"),
  msg("m2", "assistant", "work"),
  msg("m3", "user", "continue"),
];

describe("registerBeforeCompactHook: semantic wiring (Phase 6a)", () => {
  test("indexes the trimmed span (not the kept tail) after compaction", async () => {
    const vectorRoot = join(tmpDir, "v1");
    const backend = makeFakeBackend();
    const log: string[] = [];
    const opts: SemanticHookOptions = {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
      log: (line) => log.push(line),
    };
    const { pi, invoke } = createMockPi("sess-hook-1");
    registerBeforeCompactHook(pi, { semantic: opts });

    const result = invoke(makeEvent(ENTRIES, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();

    await flush();

    const dir = join(vectorRoot, "sess-hook-1");
    expect(existsSync(join(dir, "0001.md"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    const content = readFileSync(join(dir, "0001.md"), "utf-8");
    expect(content).toContain("go");
    expect(content).toContain("work");
    expect(content).not.toContain("continue");
    expect(backend.calls).toContain("ensureIndex:sess-hook-1");
    expect(backend.calls).toContain("embed:sess-hook-1");
    expect(log).toHaveLength(0);
  });

  test("a failing backend cannot break compaction", async () => {
    const vectorRoot = join(tmpDir, "v2");
    const log: string[] = [];
    const backend = makeFakeBackend({
      embed: async () => {
        throw new Error("embed exploded");
      },
    });
    const opts: SemanticHookOptions = {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
      log: (line) => log.push(line),
    };
    const { pi, invoke } = createMockPi("sess-hook-2");
    registerBeforeCompactHook(pi, { semantic: opts });

    const result = invoke(makeEvent(ENTRIES, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary.length).toBeGreaterThan(0);

    await flush();
    expect(log.some((l) => l.includes("embed exploded"))).toBe(true);
  });

  test("semantic.enabled=false → no indexing, no backend calls", async () => {
    const vectorRoot = join(tmpDir, "v3");
    const backend = makeFakeBackend();
    const opts: SemanticHookOptions = {
      config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: false },
      backend,
      vectorRoot,
    };
    const { pi, invoke } = createMockPi("sess-hook-3");
    registerBeforeCompactHook(pi, { semantic: opts });

    const result = invoke(makeEvent(ENTRIES, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();

    await flush();
    expect(existsSync(vectorRoot)).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  test("no semantic opts → compaction unchanged, no indexing (back-compat)", async () => {
    const { pi, invoke } = createMockPi("sess-hook-4");
    registerBeforeCompactHook(pi);

    const result = invoke(makeEvent(ENTRIES, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
  });

  test("ctx without getSessionId → falls back, never throws", async () => {
    const vectorRoot = join(tmpDir, "v5");
    const backend = makeFakeBackend();
    const opts: SemanticHookOptions = {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
    };
    const { pi, invoke } = createMockPi(); // no getSessionId on sessionManager
    registerBeforeCompactHook(pi, { semantic: opts });

    const result = invoke(makeEvent(ENTRIES, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();

    await flush();
    expect(existsSync(join(vectorRoot, "default", "0001.md"))).toBe(true);
  });
});
