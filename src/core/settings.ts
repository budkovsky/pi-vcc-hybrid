import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const SETTINGS_PATH_DEFAULT = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
const SETTINGS_PATH = settingsPath();

/** Per-model compaction threshold override. */
export interface ModelThreshold {
  /**
   * Tokens to reserve for LLM response. Overrides pi-core's
   * compaction.reserveTokens for matching models.
   *
   * This controls *when* compaction triggers:
   *   contextTokens > contextWindow - reserveTokens
   *
   * A higher value compacts earlier (more conservative); a lower value
   * lets context grow larger before compacting.
   */
  reserveTokens: number;
  /**
   * Recent tokens to keep (not summarized) when pi-core handles compaction.
   *
   * Only affects pi-core's default compaction (when overrideDefaultCompaction
   * is false). Pi-vcc's own buildOwnCut uses task-boundary heuristics instead
   * of token budgets, so this value is advisory/forward-compat for now.
   */
  keepRecentTokens?: number;
}

export interface PiVccSettings {
  /**
   * When true, pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else
   * falls back to pi core's default LLM-based compaction.
   */
  overrideDefaultCompaction: boolean;
  /** Write debug snapshot to /tmp/pi-vcc-debug.json on each compaction. */
  debug: boolean;
  /**
   * Per-model compaction thresholds. Keys are matched against
   * "provider/modelId" (e.g., "neuralwatt/zai-org/GLM-5.1-FP8") or
   * just "modelId" (e.g., "GLM-5.1-FP8").
   *
   * When a model matches, its reserveTokens overrides pi-core's global
   * compaction.reserveTokens for the *when to compact* decision.
   * This lets different models compact at different context fill levels.
   */
  modelThresholds?: Record<string, ModelThreshold>;
  /**
   * Default threshold for models not matched by modelThresholds.
   * If omitted, pi-core's global compaction settings apply (no override).
   */
  defaultThreshold?: ModelThreshold;
}

const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: true,
  debug: false,
};

/**
 * Resolve the effective ModelThreshold for a given model.
 *
 * Lookup order:
 *  1. Exact match on "provider/modelId" key
   *  2. Exact match on "modelId" key
   *  4. defaultThreshold from settings
   *  5. undefined (no override — pi-core's global settings apply)
 */
export function getModelThreshold(
  settings: PiVccSettings,
  model: { id: string; provider?: string } | undefined,
): ModelThreshold | undefined {
  if (!model) return settings.defaultThreshold;

  const providerModelId = model.provider ? `${model.provider}/${model.id}` : undefined;

  // Exact match on provider/modelId
  if (providerModelId && settings.modelThresholds?.[providerModelId]) {
    return settings.modelThresholds[providerModelId];
  }

  // Exact match on just modelId
  if (settings.modelThresholds?.[model.id]) {
    return settings.modelThresholds[model.id];
  }

  return settings.defaultThreshold;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

export function loadSettings(): PiVccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
}

/**
 * Ensure ~/.pi/agent/pi-vcc-config.json exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
