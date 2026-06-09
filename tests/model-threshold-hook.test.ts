import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact";

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

function createMockPi(model?: { id: string; provider?: string; contextWindow?: number }) {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    model: model ?? undefined,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  } as any;
  return {
    pi: {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        if (eventName === "session_before_compact") handler = h;
      },
    } as any,
    invoke: (event: any) => handler!(event, ctx),
    notifyCalls,
  };
}

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

function makeEvent(branchEntries: any[], customInstructions?: string, tokensBefore = 100000) {
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

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

describe("session_before_compact: per-model threshold", () => {
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  });

  test("cancels when context is below per-model threshold (provider/modelId)", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, invoke, notifyCalls } = createMockPi({
      id: "GLM-5.1",
      provider: "neuralwatt",
      contextWindow: 200000,
    });
    registerBeforeCompactHook(pi);

    // 100k tokens < 200k - 32768 = 167232 → below threshold
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, undefined, 100000));
    expect(result).toEqual({ cancel: true });
    expect(notifyCalls.length).toBeGreaterThanOrEqual(1);
    expect(notifyCalls[0].msg).toContain("Skipped compaction");
  });

  test("allows compaction when context exceeds per-model threshold", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, invoke } = createMockPi({
      id: "GLM-5.1",
      provider: "neuralwatt",
      contextWindow: 200000,
    });
    registerBeforeCompactHook(pi);

    // 180k tokens > 200k - 32768 = 167232 → above threshold
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, undefined, 180000));
    // Not cancelled — pi-vcc proceeds with its own summary
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });

  test("cancels when context is below defaultThreshold", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      defaultThreshold: { reserveTokens: 16384 },
    });
    const { pi, invoke } = createMockPi({
      id: "some-model",
      provider: "some-provider",
      contextWindow: 128000,
    });
    registerBeforeCompactHook(pi);

    // 50k tokens < 128k - 16384 = 111616 → below threshold
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, undefined, 50000));
    expect(result).toEqual({ cancel: true });
  });

  test("does NOT cancel on /pi-vcc even when below threshold", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, invoke } = createMockPi({
      id: "GLM-5.1",
      provider: "neuralwatt",
      contextWindow: 200000,
    });
    registerBeforeCompactHook(pi);

    // Below threshold, but explicit /pi-vcc command — should NOT cancel
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION, 100000));
    // Not cancelled — explicit /pi-vcc bypasses threshold check
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
  });

  test("does not cancel when no modelThresholds configured", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
    });
    const { pi, invoke } = createMockPi({
      id: "GLM-5.1",
      provider: "neuralwatt",
      contextWindow: 200000,
    });
    registerBeforeCompactHook(pi);

    // No modelThresholds → no threshold override → fall through to normal flow
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, undefined, 100000));
    // Not cancelled by threshold check (may be cancelled by other logic)
    expect(result.cancel === true).toBe(false);
  });

  test("does not cancel when model is undefined", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "GLM-5.1": { reserveTokens: 32768 },
      },
    });
    // No model provided — ctx.model is undefined
    const { pi, invoke } = createMockPi(undefined);
    registerBeforeCompactHook(pi);

    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, undefined, 100000));
    // No model → can't check threshold → fall through to normal flow
    expect(result.cancel === true).toBe(false);
  });

  test("threshold check also applies when overrideDefaultCompaction is false", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, invoke } = createMockPi({
      id: "GLM-5.1",
      provider: "neuralwatt",
      contextWindow: 200000,
    });
    registerBeforeCompactHook(pi);

    // Below threshold → cancel, even though pi-vcc wouldn't handle the summary
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
    ];
    const result = invoke(makeEvent(entries, undefined, 100000));
    expect(result).toEqual({ cancel: true });
  });

  test("modelId-only key matches when provider/modelId does not", () => {
    setConfig({
      debug: false,
      overrideDefaultCompaction: true,
      modelThresholds: {
        "GLM-5.1": { reserveTokens: 32768 },
      },
    });
    const { pi, invoke } = createMockPi({
      id: "GLM-5.1",
      provider: "neuralwatt",
      contextWindow: 200000,
    });
    registerBeforeCompactHook(pi);

    // Should match on modelId-only key
    const entries = [
      msg("m1", "user", "hello"),
      msg("m2", "assistant", "hi"),
      msg("m3", "user", "do work"),
      msg("m4", "assistant", "done"),
    ];
    const result = invoke(makeEvent(entries, undefined, 100000));
    expect(result).toEqual({ cancel: true });
  });
});
