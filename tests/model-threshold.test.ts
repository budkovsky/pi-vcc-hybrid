import { describe, test, expect } from "bun:test";
import { getModelThreshold, type PiVccSettings, type ModelThreshold } from "../src/core/settings";

const t = (reserveTokens: number, keepRecentTokens?: number): ModelThreshold => ({
  reserveTokens,
  ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
});

describe("getModelThreshold", () => {
  test("returns undefined when no modelThresholds and no defaultThreshold", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
    };
    expect(getModelThreshold(settings, { id: "GLM-5.1", provider: "neuralwatt" })).toBeUndefined();
  });

  test("returns undefined when model is undefined and no defaultThreshold", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: { "neuralwatt/GLM-5.1": t(32768) },
    };
    expect(getModelThreshold(settings, undefined)).toBeUndefined();
  });

  test("returns defaultThreshold when model doesn't match any key", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: { "neuralwatt/GLM-5.1": t(32768) },
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "other-model", provider: "other" })).toEqual(t(8192));
  });

  test("returns defaultThreshold when model is undefined", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, undefined)).toEqual(t(8192));
  });

  test("matches on provider/modelId key", () => {
    const threshold = t(32768, 40000);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/zai-org/GLM-5.1-FP8": threshold,
      },
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "zai-org/GLM-5.1-FP8", provider: "neuralwatt" })).toEqual(threshold);
  });

  test("matches on modelId-only key when provider/modelId not found", () => {
    const threshold = t(16384);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "zai-org/GLM-5.1-FP8": threshold,
      },
      defaultThreshold: t(8192),
    };
    // provider/modelId doesn't match, but modelId does
    expect(getModelThreshold(settings, { id: "zai-org/GLM-5.1-FP8", provider: "other-provider" })).toEqual(threshold);
  });

  test("provider/modelId takes precedence over modelId-only key", () => {
    const providerThreshold = t(32768);
    const modelIdThreshold = t(16384);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": providerThreshold,
        "GLM-5.1": modelIdThreshold,
      },
    };
    expect(getModelThreshold(settings, { id: "GLM-5.1", provider: "neuralwatt" })).toEqual(providerThreshold);
  });

  test("falls through to modelId-only when provider is absent", () => {
    const threshold = t(16384);
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "GLM-5.1": threshold,
      },
    };
    expect(getModelThreshold(settings, { id: "GLM-5.1" })).toEqual(threshold);
  });

  test("falls through to defaultThreshold when neither key matches", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/GLM-5.1": t(32768),
      },
      defaultThreshold: t(8192),
    };
    expect(getModelThreshold(settings, { id: "Kimi-K2.6", provider: "neuralwatt" })).toEqual(t(8192));
  });

  test("works with multiple modelThresholds entries", () => {
    const settings: PiVccSettings = {
      overrideDefaultCompaction: true,
      debug: false,
      modelThresholds: {
        "neuralwatt/zai-org/GLM-5.1-FP8": t(32768),
        "neuralwatt/moonshotai/Kimi-K2.6": t(65536),
        "makora/deepseek-ai/DeepSeek-V4-Pro": t(32768),
      },
      defaultThreshold: t(16384),
    };

    expect(getModelThreshold(settings, { id: "zai-org/GLM-5.1-FP8", provider: "neuralwatt" })).toEqual(t(32768));
    expect(getModelThreshold(settings, { id: "moonshotai/Kimi-K2.6", provider: "neuralwatt" })).toEqual(t(65536));
    expect(getModelThreshold(settings, { id: "deepseek-ai/DeepSeek-V4-Pro", provider: "makora" })).toEqual(t(32768));
    expect(getModelThreshold(settings, { id: "unknown-model", provider: "other" })).toEqual(t(16384));
  });
});
