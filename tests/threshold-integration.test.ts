/**
 * Integration tests: proactive threshold + session_before_compact interaction.
 *
 * These tests verify the cross-hook contract:
 * - When proactive trigger calls ctx.compact(), session_before_compact
 *   must NOT cancel the compaction even if tokensBefore differs from
 *   getContextUsage().
 * - When the global threshold triggers compaction but the model can
 *   handle more (per-model threshold not crossed), session_before_compact
 *   must cancel.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook } from "../src/hooks/before-compact";
import { registerProactiveThresholdHook, resetProactiveState } from "../src/hooks/proactive-threshold";

let tmpDir: string;
let CONFIG_PATH: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-test-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

function createMockPi(
  model?: { id: string; provider?: string; contextWindow?: number },
  usage?: { tokens: number | null; contextWindow: number; percent: number | null },
) {
  const handlers: Record<string, ((e: any, c: any) => any)[]> = {};
  const compactCalls: number[] = [];
  const notifyCalls: { msg: string; level: string }[] = [];

  const ctx = {
    hasUI: true,
    model: model ?? undefined,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
    getContextUsage: () => usage ?? { tokens: null, contextWindow: 0, percent: null },
    compact: () => {
      compactCalls.push(Date.now());
    },
  } as any;

  const pi = {
    on: (eventName: string, handler: (e: any, c: any) => any) => {
      if (!handlers[eventName]) handlers[eventName] = [];
      handlers[eventName].push(handler);
    },
  } as any;

  const emit = (eventName: string, event: any = {}) => {
    const hs = handlers[eventName] ?? [];
    let result: any;
    for (const h of hs) result = h(event, ctx);
    return result;
  };

  return { pi, ctx, emit, compactCalls, notifyCalls };
}

function makeBeforeCompactEvent(branchEntries: any[], customInstructions?: string, tokensBefore = 100000) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore,
    },
    signal: new AbortController().signal,
  };
}

describe("integration: proactive trigger + before-compact", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    resetProactiveState();
  });

  test("proactive trigger then before-compact: does NOT cancel when proactiveTriggerActive", () => {
    // Scenario: agent_end fires, getContextUsage says 110k tokens,
    // per-model threshold is 95232 (128k - 32768). Proactive triggers compact.
    // Then session_before_compact fires with tokensBefore = 94000
    // (slightly different due to estimation).
    // Without the proactiveTriggerActive guard, this would be cancelled.
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit, compactCalls } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 110000, contextWindow: 128000, percent: 86 },
    );
    registerProactiveThresholdHook(pi);
    registerBeforeCompactHook(pi);

    // Step 1: agent_end fires → proactive trigger calls ctx.compact()
    emit("agent_end", { type: "agent_end", messages: [] });
    expect(compactCalls).toHaveLength(1);

    // Step 2: session_before_compact fires with tokensBefore = 94000
    // (below the 95232 threshold — but we should NOT cancel because
    // we ourselves triggered this compaction)
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = emit("session_before_compact", makeBeforeCompactEvent(entries, undefined, 94000));

    // Should NOT cancel — proactiveTriggerActive is true
    expect(result?.cancel).toBeUndefined();
    // Should proceed with compaction (pi-vcc's own summary)
    expect(result?.compaction).toBeDefined();
  });

  test("global trigger + before-compact: CANCELS when per-model threshold not crossed and no proactive trigger", () => {
    // Scenario: pi-core's global threshold triggers compaction,
    // but the model's per-model threshold hasn't been crossed.
    // No proactive trigger was set — this is pi-core's own initiative.
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit, compactCalls } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      // getContextUsage says 80k — well below per-model threshold
      { tokens: 80000, contextWindow: 128000, percent: 63 },
    );
    registerProactiveThresholdHook(pi);
    registerBeforeCompactHook(pi);

    // No agent_end fired (global threshold triggered this)
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    // tokensBefore = 90k < 95232 — should cancel
    const result = emit("session_before_compact", makeBeforeCompactEvent(entries, undefined, 90000));
    expect(result).toEqual({ cancel: true });
  });

  test("proactiveTriggerActive is cleared after session_compact", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit, compactCalls } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 110000, contextWindow: 128000, percent: 86 },
    );
    registerProactiveThresholdHook(pi);
    registerBeforeCompactHook(pi);

    // Step 1: proactive trigger
    emit("agent_end", { type: "agent_end", messages: [] });
    expect(compactCalls).toHaveLength(1);

    // Step 2: compaction completes
    emit("session_compact", { type: "session_compact", compactionEntry: {} });

    // Step 3: now a subsequent session_before_compact (e.g., from pi-core
    // also triggering) with tokensBelow below threshold — should CANCEL
    // because proactiveTriggerActive was cleared by session_compact
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = emit("session_before_compact", makeBeforeCompactEvent(entries, undefined, 90000));
    expect(result).toEqual({ cancel: true });
  });

  test("explicit /pi-vcc bypasses both the proactive flag AND threshold guard", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 50000, contextWindow: 128000, percent: 39 },
    );
    registerProactiveThresholdHook(pi);
    registerBeforeCompactHook(pi);

    // Direct /pi-vcc with tokens well below threshold — should still proceed
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = emit("session_before_compact", makeBeforeCompactEvent(entries, "__pi_vcc__", 50000));
    expect(result?.cancel).toBeUndefined();
    expect(result?.compaction).toBeDefined();
  });
});

describe("integration: proactive trigger + before-compact with overrideDefaultCompaction: false", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    resetProactiveState();
  });

  test("proactive trigger fires, before-compact doesn't cancel, then pi-core handles summary", () => {
    // When overrideDefaultCompaction: false, pi-vcc doesn't handle the summary
    // for non-/pi-vcc compactions. But the threshold guard and proactive trigger
    // should still work — the threshold guard controls WHEN compaction triggers,
    // and pi-core handles the actual summary.
    setConfig({
      debug: false,
      overrideDefaultCompaction: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit, compactCalls } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 110000, contextWindow: 128000, percent: 86 },
    );
    registerProactiveThresholdHook(pi);
    registerBeforeCompactHook(pi);

    // agent_end fires → proactive trigger
    emit("agent_end", { type: "agent_end", messages: [] });
    expect(compactCalls).toHaveLength(1);

    // session_before_compact fires: threshold is crossed (tokensBefore = 110k
    // > 95232), and our guard allows it because proactiveTriggerActive.
    // Then overrideDefaultCompaction: false means pi-vcc returns undefined,
    // letting pi-core handle the summary.
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = emit("session_before_compact", makeBeforeCompactEvent(entries, undefined, 110000));
    // pi-vcc doesn't handle it (overrideDefaultCompaction: false) → returns undefined
    // pi-core will handle the summary
    expect(result).toBeUndefined();
  });

  test("threshold guard cancels even with overrideDefaultCompaction: false", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 80000, contextWindow: 128000, percent: 63 },
    );
    registerProactiveThresholdHook(pi);
    registerBeforeCompactHook(pi);

    // No proactive trigger (context below threshold)
    // Pi-core's global threshold triggers compaction, but per-model threshold
    // says the model can handle more → cancel
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
    ];
    const result = emit("session_before_compact", makeBeforeCompactEvent(entries, undefined, 80000));
    expect(result).toEqual({ cancel: true });
  });
});

describe("integration: cooldown prevents double compaction", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    resetProactiveState();
  });

  test("agent_end + model_select on same turn: only one compact()", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit, compactCalls } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 110000, contextWindow: 128000, percent: 86 },
    );
    registerProactiveThresholdHook(pi);

    // agent_end triggers compact and sets cooldown
    emit("agent_end", { type: "agent_end", messages: [] });
    expect(compactCalls).toHaveLength(1);

    // model_select fires on same turn — blocked by cooldown
    emit("model_select", { type: "model_select" });
    expect(compactCalls).toHaveLength(1);
  });

  test("two consecutive agent_ends without session_compact: second blocked by cooldown", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, ctx, emit, compactCalls } = createMockPi(
      { id: "GLM-5.1", provider: "neuralwatt", contextWindow: 128000 },
      { tokens: 110000, contextWindow: 128000, percent: 86 },
    );
    registerProactiveThresholdHook(pi);

    emit("agent_end", { type: "agent_end", messages: [] });
    expect(compactCalls).toHaveLength(1);

    // No session_compact between — cooldown still active
    emit("agent_end", { type: "agent_end", messages: [] });
    expect(compactCalls).toHaveLength(1);
  });
});
