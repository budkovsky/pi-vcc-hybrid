/**
 * Semantic-layer configuration.
 *
 * Sources, highest precedence first:
 *   1. environment overrides (PI_SEMANTIC_*)
 *   2. the `semantic` key of the pi-vcc config file
 *      (default <agentDir>/pi-vcc-config.json, override: PI_VCC_CONFIG_PATH)
 *   3. built-in defaults (DEFAULT_SEMANTIC_CONFIG)
 *
 * Invalid values never throw: they fall back to the default and emit a
 * warning (injected `warn`, defaults to console.warn).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SHARED_INDEX_NAME, sanitizeSessionId } from "./paths";

export type SemanticMode = "vsearch" | "query";
export type GpuMode = "auto" | "cpu" | "force";

export interface SemanticConfig {
  /** Master switch. false → no indexing, no semantic_recall tool. */
  enabled: boolean;
  /** Target chunk size in estimated tokens (chars/4). */
  chunkTokens: number;
  /** Default hit count for semantic_recall. */
  limit: number;
  /**
   * Recall mode: "vsearch" = vector-only (daemon `vec` query, fast);
   * "query" = hybrid + expansion (slower).
   */
  mode: SemanticMode;
  /**
   * GPU policy for qmd subprocess calls. Default "cpu" → QMD_FORCE_CPU=1
   * (GPU on the reference box is saturated; see docs/qmd-contract.md).
   */
  gpu: GpuMode;
  /** Shared qmd index name (one daemon serves one index). */
  indexName: string;
  /** Port for the resident qmd daemon (http). */
  daemonPort: number;
  /**
   * Keep the per-session chunk dir + collection on session_shutdown.
   * Default false → vectors are removed (rebuildable; raw JSONL persists).
   */
  keepOnShutdown: boolean;
}

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = {
  enabled: true,
  chunkTokens: 1500,
  limit: 5,
  mode: "vsearch",
  gpu: "cpu",
  indexName: SHARED_INDEX_NAME,
  daemonPort: 8390,
  keepOnShutdown: false,
};

const MODES: readonly SemanticMode[] = ["vsearch", "query"];
const GPUS: readonly GpuMode[] = ["auto", "cpu", "force"];

/** env var per overridable key (keys without an entry are file-only). */
const ENV_KEYS: Partial<Record<keyof SemanticConfig, string>> = {
  enabled: "PI_SEMANTIC_ENABLED",
  chunkTokens: "PI_SEMANTIC_CHUNK_TOKENS",
  limit: "PI_SEMANTIC_LIMIT",
  mode: "PI_SEMANTIC_MODE",
  gpu: "PI_SEMANTIC_GPU",
};

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const parseBool = (v: unknown): boolean | undefined => {
  if (isBool(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true") return true;
    if (s === "0" || s === "false") return false;
  }
  return undefined;
};
const parseIntInRange = (v: unknown, min: number, max: number): number | undefined => {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v);
  else return undefined;
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
};
const parseEnum = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

type Warn = (message: string) => void;

/** Typed per-key assignment (TS can't verify generic indexed writes directly). */
function assign<K extends keyof SemanticConfig>(
  cfg: SemanticConfig,
  key: K,
  value: SemanticConfig[K],
): void {
  (cfg as Record<K, SemanticConfig[K]>)[key] = value;
}

/** Coerce one raw value into a valid config value, or undefined (→ default + warn). */
function coerce<K extends keyof SemanticConfig>(
  key: K,
  value: unknown,
  warn: Warn,
): SemanticConfig[K] | undefined {
  switch (key) {
    case "enabled":
    case "keepOnShutdown":
      return parseBool(value) as SemanticConfig[K] | undefined;
    case "chunkTokens":
      return parseIntInRange(value, 100, 50_000) as SemanticConfig[K] | undefined;
    case "limit":
      return parseIntInRange(value, 1, 100) as SemanticConfig[K] | undefined;
    case "daemonPort":
      return parseIntInRange(value, 1, 65_535) as SemanticConfig[K] | undefined;
    case "mode":
      return parseEnum(value, MODES) as SemanticConfig[K] | undefined;
    case "gpu":
      return parseEnum(value, GPUS) as SemanticConfig[K] | undefined;
    case "indexName": {
      if (typeof value !== "string" || !value.trim()) return undefined;
      const clean = sanitizeSessionId(value);
      if (clean !== value) {
        warn(`semantic.indexName ${JSON.stringify(value)} is not a safe name; using ${JSON.stringify(clean)}`);
      }
      return clean as SemanticConfig[K];
    }
  }
}

export interface ResolveOptions {
  /** Parsed pi-vcc config JSON (the whole file), or null if absent. */
  file?: unknown;
  /** Environment to read PI_SEMANTIC_* from (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Warning sink (defaults to console.warn). */
  warn?: Warn;
}

/**
 * Pure config resolution: defaults ← file `semantic` key ← env overrides.
 * Invalid values fall back to defaults with a warning; never throws.
 */
export function resolveSemanticConfig(opts: ResolveOptions = {}): SemanticConfig {
  const warn: Warn = opts.warn ?? console.warn;
  const env = opts.env ?? {};
  const cfg: SemanticConfig = { ...DEFAULT_SEMANTIC_CONFIG };

  const file = opts.file;
  const fileSem =
    file && typeof file === "object" && !Array.isArray(file)
      ? (file as Record<string, unknown>).semantic
      : undefined;
  const fileSemObj =
    fileSem && typeof fileSem === "object" && !Array.isArray(fileSem)
      ? (fileSem as Record<string, unknown>)
      : undefined;

  const keys = Object.keys(DEFAULT_SEMANTIC_CONFIG) as (keyof SemanticConfig)[];
  for (const key of keys) {
    // 1. file
    if (fileSemObj && fileSemObj[key] !== undefined) {
      const raw = fileSemObj[key];
      const v = coerce(key, raw, warn);
      if (v === undefined) {
        warn(
          `semantic.${key}: invalid value ${JSON.stringify(raw)} — using default ${JSON.stringify(DEFAULT_SEMANTIC_CONFIG[key])}`,
        );
      } else {
        assign(cfg, key, v);
      }
    }
    // 2. env (takes precedence over file)
    const envName = ENV_KEYS[key];
    if (envName && env[envName] !== undefined) {
      const raw = env[envName];
      const v = coerce(key, raw, warn);
      if (v === undefined) {
        warn(
          `semantic.${key}: invalid ${envName}=${JSON.stringify(raw)} — using default ${JSON.stringify(DEFAULT_SEMANTIC_CONFIG[key])}`,
        );
      } else {
        assign(cfg, key, v);
      }
    }
  }
  return cfg;
}

const configPath = (): string =>
  process.env.PI_VCC_CONFIG_PATH ?? join(getAgentDir(), "pi-vcc-config.json");

const readConfigFile = (): unknown => {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8"));
  } catch {
    return null;
  }
};

/** Load the effective semantic config from disk + process.env. */
export function loadSemanticConfig(): SemanticConfig {
  return resolveSemanticConfig({ file: readConfigFile() });
}
