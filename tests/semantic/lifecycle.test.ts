/**
 * Phase 6a — semantic lifecycle tests (session_start / session_shutdown).
 *
 * Contract:
 *   session_start   → ensureDaemon, fire-and-forget (warm the daemon off the
 *                     turn path); a rejection is logged, never thrown.
 *   session_shutdown→ cleanup ONLY when reason === "quit" (user decision
 *                     2026-09-10: session_shutdown also fires on
 *                     new/resume/fork/reload — those must NOT destroy the
 *                     vectors of resumable sessions):
 *                       keepOnShutdown=false → backend.remove(sessionId) +
 *                       rm -rf the session's chunk dir
 *                       drop the indexer's per-session state
 *                       stopDaemon (the daemon is a detached child — stop it
 *                       so quitting pi doesn't leak the process)
 *   enabled=false   → no handlers at all.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SEMANTIC_CONFIG } from "../../src/semantic/config";
import { registerSemanticLifecycle } from "../../src/semantic/lifecycle";

const flush = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeBackend {
  calls: string[];
  ensureDaemon: () => Promise<void>;
  remove: (sid: string) => Promise<void>;
  stopDaemon: () => Promise<void>;
}

function makeFakeBackend(overrides: Partial<Record<string, unknown>> = {}): FakeBackend & Record<string, unknown> {
  const calls: string[] = [];
  return {
    calls,
    ensureDaemon: async () => {
      calls.push("ensureDaemon");
    },
    remove: async (sid: string) => {
      calls.push(`remove:${sid}`);
    },
    stopDaemon: async () => {
      calls.push("stopDaemon");
    },
    ...overrides,
  };
}

function createMockPi(sessionId?: string) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const ctx = {
    sessionManager: {
      ...(sessionId !== undefined ? { getSessionId: () => sessionId } : {}),
    },
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
    handlers,
    emit: (eventName: string, event: any) => {
      for (const handler of handlers.get(eventName) ?? []) handler(event, ctx);
    },
  };
}

describe("registerSemanticLifecycle (Phase 6a)", () => {
  let tmpDir: string;
  let vectorRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-lifecycle-"));
    vectorRoot = join(tmpDir, "vector");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("session_start → ensureDaemon fire-and-forget", async () => {
    const backend = makeFakeBackend();
    const { pi, emit, handlers } = createMockPi("sess-lc-1");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
    });
    expect(handlers.get("session_start")).toHaveLength(1);

    emit("session_start", { type: "session_start", reason: "startup" });
    await flush();
    expect(backend.calls).toContain("ensureDaemon");
  });

  test("session_start: ensureDaemon rejection is logged, never thrown", async () => {
    const log: string[] = [];
    const backend = makeFakeBackend({
      ensureDaemon: async () => {
        throw new Error("daemon spawn failed");
      },
    });
    const { pi, emit } = createMockPi("sess-lc-2");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
      log: (line) => log.push(line),
    });

    emit("session_start", { type: "session_start", reason: "startup" });
    await flush();
    expect(log.some((l) => l.includes("daemon spawn failed"))).toBe(true);
  });

  test("session_shutdown reason=quit → remove + rm -rf chunk dir + stopDaemon", async () => {
    const backend = makeFakeBackend();
    const dir = join(vectorRoot, "sess-lc-3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001.md"), "chunk");

    const { pi, emit } = createMockPi("sess-lc-3");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG }, // keepOnShutdown: false
      backend,
      vectorRoot,
    });

    emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await flush();

    expect(backend.calls).toContain("remove:sess-lc-3");
    expect(backend.calls).toContain("stopDaemon");
    expect(existsSync(dir)).toBe(false);
  });

  test("keepOnShutdown=true → chunk dir + collection kept", async () => {
    const backend = makeFakeBackend();
    const dir = join(vectorRoot, "sess-lc-4");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001.md"), "chunk");

    const { pi, emit } = createMockPi("sess-lc-4");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG, keepOnShutdown: true },
      backend,
      vectorRoot,
    });

    emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await flush();

    expect(backend.calls).not.toContain("remove:sess-lc-4");
    expect(existsSync(join(dir, "0001.md"))).toBe(true);
    expect(backend.calls).toContain("stopDaemon");
  });

  test("session_shutdown reason=new → NO cleanup (resumable session)", async () => {
    const backend = makeFakeBackend();
    const dir = join(vectorRoot, "sess-lc-5");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001.md"), "chunk");

    const { pi, emit } = createMockPi("sess-lc-5");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
    });

    emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    await flush();

    expect(backend.calls).toHaveLength(0);
    expect(existsSync(join(dir, "0001.md"))).toBe(true);
  });

  test("remove failure is logged, stopDaemon still runs", async () => {
    const log: string[] = [];
    const backend = makeFakeBackend({
      remove: async () => {
        throw new Error("collection remove failed");
      },
    });
    const { pi, emit } = createMockPi("sess-lc-6");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
      log: (line) => log.push(line),
    });

    emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await flush();

    expect(log.some((l) => l.includes("collection remove failed"))).toBe(true);
    expect(backend.calls).toContain("stopDaemon");
  });

  test("ctx without getSessionId → no crash, stopDaemon still runs", async () => {
    const backend = makeFakeBackend();
    const { pi, emit } = createMockPi(); // no getSessionId
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG },
      backend,
      vectorRoot,
    });

    emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await flush();

    expect(backend.calls).toContain("stopDaemon");
    expect(backend.calls.filter((c) => c.startsWith("remove:"))).toHaveLength(0);
  });

  test("enabled=false → no handlers registered", () => {
    const backend = makeFakeBackend();
    const { pi, handlers } = createMockPi("sess-lc-7");
    registerSemanticLifecycle(pi, {
      config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: false },
      backend,
      vectorRoot,
    });
    expect(handlers.get("session_start")).toBeUndefined();
    expect(handlers.get("session_shutdown")).toBeUndefined();
  });
});
