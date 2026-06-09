import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings, getModelThreshold } from "../core/settings";

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

// Cooldown after compaction to prevent double-trigger.
// Set when compaction runs, cleared after 3 seconds.
let lastCompactTime = 0;
const COOLDOWN_MS = 3000;

const setCooldown = () => { lastCompactTime = Date.now(); };
const isCoolingDown = () => Date.now() - lastCompactTime < COOLDOWN_MS;

/** Reset cooldown state (for testing). */
export const resetProactiveCooldown = () => { lastCompactTime = 0; };

/**
 * Check if per-model threshold has been crossed and trigger compaction
 * if so. Safe to call from multiple event handlers — cooldown prevents
 * double-triggering.
 */
const checkAndTrigger = (ctx: { model?: any; getContextUsage?: () => any; compact?: () => void; ui?: any }, source: string) => {
  const settings = loadSettings();
  const threshold = getModelThreshold(settings, ctx.model);

  // No per-model threshold → nothing to do (pi-core's global threshold owns it)
  if (!threshold) return;

  const contextWindow = ctx.model?.contextWindow ?? 0;
  if (contextWindow <= 0) return;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  // This model's compaction threshold
  const effectiveThreshold = contextWindow - threshold.reserveTokens;

  // Only trigger if context EXCEEDS the per-model threshold.
  // If context is below the threshold, there's no need to compact.
  if (usage.tokens <= effectiveThreshold) return;

  // Cooldown guard — prevent double-trigger within 3s of last compaction.
  // This handles the case where pi-core also triggers compaction on the
  // same turn (global threshold crossed too) or where our model_select
  // and turn_end handlers both fire for the same switch.
  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(
      `pi-vcc: [${source}] Context at ${pct}% exceeds model threshold (${formatTokens(effectiveThreshold)} tok). Compacting...`,
      "info",
    );
  } catch {}
  ctx.compact?.();
  setCooldown();
};

/**
 * Registers proactive per-model compaction thresholds.
 *
 * Two triggers:
 *
 * 1. `agent_end` — after each agent run completes, check if context
 *    exceeds the current model's per-model threshold. If the per-model
 *    threshold is *lower* than pi-core's global threshold (meaning the
 *    model wants to compact *earlier*), pi-core won't trigger compaction
 *    at this point. We step in and trigger it proactively.
 *
 *    If the global threshold is already crossed, pi-core will trigger
 *    compaction itself, and our session_before_compact handler will
 *    either cancel (model can handle more) or proceed (threshold
 *    actually crossed).
 *
 * 2. `model_select` — when switching to a model with a lower effective
 *    threshold, the current context may already exceed the new model's
 *    capacity. Trigger compaction immediately.
 *
 * 3. `session_compact` — cooldown tracking. After any compaction
 *    completes, we set a cooldown to prevent double-triggering.
 */
export const registerProactiveThresholdHook = (pi: ExtensionAPI) => {
  // Proactive compaction after each agent run
  pi.on("agent_end", (_event, ctx) => {
    checkAndTrigger(ctx, "auto");
  });

  // Proactive compaction on model switch
  pi.on("model_select", (_event, ctx) => {
    checkAndTrigger(ctx, "model-switch");
  });

  // Track compaction completion for cooldown
  pi.on("session_compact", () => {
    setCooldown();
  });

  // Reset cooldown on session start so state doesn't leak between sessions
  pi.on("session_start", () => {
    lastCompactTime = 0;
  });
};
