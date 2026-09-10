import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_SEMANTIC_CONFIG,
  loadSemanticConfig,
  resolveSemanticConfig,
  type SemanticConfig,
  type SemanticMode,
  type GpuMode,
} from "../../src/semantic/config";

const warnings: string[] = [];
const warn = (m: string) => warnings.push(m);
const noWarn = () => warnings.length;

describe("resolveSemanticConfig — defaults", () => {
  it("returns the pinned defaults with no file and no env", () => {
    const cfg = resolveSemanticConfig({ file: null, env: {}, warn });
    expect(cfg).toEqual({
      enabled: true,
      chunkTokens: 1500,
      limit: 5,
      mode: "vsearch",
      gpu: "cpu",
      indexName: "pi-semantic",
      daemonPort: 8390,
      keepOnShutdown: false,
    });
    expect(noWarn()).toBe(0);
  });

  it("DEFAULT_SEMANTIC_CONFIG matches what resolve returns", () => {
    expect(DEFAULT_SEMANTIC_CONFIG).toEqual(resolveSemanticConfig({ file: null, env: {}, warn }));
  });

  it("defaults are valid mode/gpu members", () => {
    const mode: SemanticMode = DEFAULT_SEMANTIC_CONFIG.mode;
    const gpu: GpuMode = DEFAULT_SEMANTIC_CONFIG.gpu;
    expect(["vsearch", "query"]).toContain(mode);
    expect(["auto", "cpu", "force"]).toContain(gpu);
  });
});

describe("resolveSemanticConfig — file merge", () => {
  it("merges the `semantic` key over defaults", () => {
    const cfg = resolveSemanticConfig({
      file: { overrideDefaultCompaction: true, semantic: { limit: 10, chunkTokens: 2000 } },
      env: {},
      warn,
    });
    expect(cfg.limit).toBe(10);
    expect(cfg.chunkTokens).toBe(2000);
    expect(cfg.mode).toBe("vsearch"); // untouched → default
  });

  it("ignores a missing or non-object semantic key", () => {
    expect(resolveSemanticConfig({ file: {}, env: {}, warn })).toEqual(DEFAULT_SEMANTIC_CONFIG);
    expect(resolveSemanticConfig({ file: { semantic: "nope" }, env: {}, warn })).toEqual(
      DEFAULT_SEMANTIC_CONFIG,
    );
    expect(resolveSemanticConfig({ file: null, env: {}, warn })).toEqual(DEFAULT_SEMANTIC_CONFIG);
  });

  it("ignores unknown keys inside semantic", () => {
    const cfg = resolveSemanticConfig({
      file: { semantic: { bogus: 1, limit: 7 } },
      env: {},
      warn,
    });
    expect(cfg.limit).toBe(7);
    expect((cfg as Record<string, unknown>).bogus).toBeUndefined();
  });
});

describe("resolveSemanticConfig — invalid values fall back to defaults + warn (never throw)", () => {
  it.each([
    ["enabled", "yes"],
    ["enabled", 1],
    ["chunkTokens", "abc"],
    ["chunkTokens", 50], // below minimum
    ["chunkTokens", 100000], // above maximum
    ["chunkTokens", 12.5],
    ["limit", 0],
    ["limit", "x"],
    ["limit", 999], // above maximum
    ["mode", "banana"],
    ["gpu", "banana"],
    ["daemonPort", 0],
    ["daemonPort", 65536],
    ["daemonPort", "port"],
    ["indexName", ""],
    ["keepOnShutdown", "truthy"],
  ] as const)("%s: %j → default + warning", (key, bad) => {
    warnings.length = 0;
    const cfg = resolveSemanticConfig({ file: { semantic: { [key]: bad } }, env: {}, warn });
    expect(cfg[key as keyof SemanticConfig]).toBe(DEFAULT_SEMANTIC_CONFIG[key as keyof SemanticConfig]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(" ")).toContain(key);
  });
});

describe("resolveSemanticConfig — env overrides", () => {
  it("PI_SEMANTIC_ENABLED accepts 0/1/true/false", () => {
    const env = (v: string) => ({ PI_SEMANTIC_ENABLED: v });
    expect(resolveSemanticConfig({ file: null, env: env("0"), warn }).enabled).toBe(false);
    expect(resolveSemanticConfig({ file: null, env: env("1"), warn }).enabled).toBe(true);
    expect(resolveSemanticConfig({ file: null, env: env("false"), warn }).enabled).toBe(false);
    expect(resolveSemanticConfig({ file: null, env: env("true"), warn }).enabled).toBe(true);
  });

  it("PI_SEMANTIC_ENABLED invalid → default + warn", () => {
    warnings.length = 0;
    const cfg = resolveSemanticConfig({ file: null, env: { PI_SEMANTIC_ENABLED: "banana" }, warn });
    expect(cfg.enabled).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("numeric/env-string fields: PI_SEMANTIC_LIMIT, PI_SEMANTIC_CHUNK_TOKENS", () => {
    const cfg = resolveSemanticConfig({
      file: null,
      env: { PI_SEMANTIC_LIMIT: "7", PI_SEMANTIC_CHUNK_TOKENS: "2500" },
      warn,
    });
    expect(cfg.limit).toBe(7);
    expect(cfg.chunkTokens).toBe(2500);
  });

  it("enum env fields: PI_SEMANTIC_MODE, PI_SEMANTIC_GPU", () => {
    const cfg = resolveSemanticConfig({
      file: null,
      env: { PI_SEMANTIC_MODE: "query", PI_SEMANTIC_GPU: "force" },
      warn,
    });
    expect(cfg.mode).toBe("query");
    expect(cfg.gpu).toBe("force");
  });

  it("env takes precedence over the file", () => {
    const cfg = resolveSemanticConfig({
      file: { semantic: { limit: 10, enabled: true } },
      env: { PI_SEMANTIC_LIMIT: "3", PI_SEMANTIC_ENABLED: "0" },
      warn,
    });
    expect(cfg.limit).toBe(3);
    expect(cfg.enabled).toBe(false);
  });
});

describe("loadSemanticConfig — disk path", () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-semantic-cfg-"));
    savedPath = process.env.PI_VCC_CONFIG_PATH;
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the `semantic` key from the pi-vcc config file", () => {
    const path = join(dir, "pi-vcc-config.json");
    writeFileSync(path, JSON.stringify({ overrideDefaultCompaction: true, semantic: { limit: 9 } }));
    process.env.PI_VCC_CONFIG_PATH = path;
    expect(loadSemanticConfig().limit).toBe(9);
    expect(loadSemanticConfig().chunkTokens).toBe(1500);
  });

  it("missing file → pure defaults", () => {
    process.env.PI_VCC_CONFIG_PATH = join(dir, "does-not-exist.json");
    expect(loadSemanticConfig()).toEqual(DEFAULT_SEMANTIC_CONFIG);
  });

  it("invalid JSON file → defaults (never throws)", () => {
    const path = join(dir, "pi-vcc-config.json");
    writeFileSync(path, "{not json");
    process.env.PI_VCC_CONFIG_PATH = path;
    expect(loadSemanticConfig()).toEqual(DEFAULT_SEMANTIC_CONFIG);
  });
});
