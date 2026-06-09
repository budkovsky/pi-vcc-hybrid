import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compile, type CompileInput } from "../core/summarize";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { triggerInvisibleContinue } from "../core/invisible-continue";
import type { PiVccCompactionDetails } from "../details";

export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptTokensEst: number;
}

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let lastCompactHandledByVcc = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

/**
 * Compute the entry-ID range for summarized messages.
 *
 * Uses entry IDs instead of numeric indices so that vcc_recall can correctly
 * resolve the range against the full session file (not just the active branch,
 * where numeric indices would be branch-relative and wrong).
 *
 * Returns [firstSummarizedEntryId, lastSummarizedEntryId] or undefined.
 */
const computeMessageRange = (
  branchEntries: any[],
  firstKeptEntryId: string,
): [string, string] | undefined => {
  if (!firstKeptEntryId) return undefined;

  // If compact-all sentinel, find the last message entry
  if (firstKeptEntryId === "") {
    let lastId: string | undefined;
    for (const e of branchEntries) {
      if (e.type === "message" && e.message && e.id) {
        lastId = e.id;
      }
    }
    return lastId ? [branchEntries.find((e: any) => e.type === "message" && e.message)?.id ?? "", lastId] as [string, string] : undefined;
  }

  // Find the first message entry (start of summarized range)
  const firstMsgId = branchEntries.find(
    (e: any) => e.type === "message" && e.message && e.id,
  )?.id;
  if (!firstMsgId) return undefined;

  // If first kept entry IS the first message, nothing was summarized
  if (firstMsgId === firstKeptEntryId) return undefined;

  return [firstMsgId, firstKeptEntryId];
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

export function buildOwnCut(branchEntries: any[]): OwnCutResult {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (e.type === "message" && e.message) {
        liveMessages.push({ entry: e, message: e.message });
      }
    }
  }

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  // Task-boundary-aware cut: find the last user message whose response cycle
  // is complete (no unmatched tool calls). If the turn is mid-flight, push the
  // cut back to the previous user message to keep the entire in-progress turn
  // in the tail.
  let cutIdx = liveMessages.length - 1;
  while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") {
    cutIdx--;
  }

  // Check if the turn following the last user message is "in progress"
  // (has an unmatched toolCall — assistant started but didn't finish)
  if (cutIdx > 0) {
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (let i = cutIdx + 1; i < liveMessages.length; i++) {
      const msg = liveMessages[i].message;
      if (msg.role === "user") break; // next turn starts
      const content = msg.content;
      if (typeof content === "string" || !Array.isArray(content)) continue;
      for (const part of content) {
        if (part.type === "toolCall" && part.id) toolCallIds.add(part.id);
        if (part.type === "toolResult" && part.toolCallId) toolResultIds.add(part.toolCallId);
      }
    }
    const hasUnmatchedToolCall = [...toolCallIds].some(id => !toolResultIds.has(id));
    if (hasUnmatchedToolCall) {
      // Push cut back to the previous user message
      for (let i = cutIdx - 1; i > 0; i--) {
        if (liveMessages[i].message.role === "user") {
          cutIdx = i;
          break;
        }
      }
    }
  }

  if (cutIdx <= 0) {
    // Single user prompt scenario (or no user at all).
    // Compact EVERYTHING and keep no tail. This handles both:
    //  - Single user prompt at index 0: compact all, fresh start after summary
    //  - No user message at all (e.g., long assistant/tool chain): still compact
    //    to recover from context overflow rather than cancelling and leaving
    //    the session unrecoverable.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return {
      ok: true,
      messages: liveMessages.map((e) => e.message),
      firstKeptEntryId: "",
      compactAll: true,
    };
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
  };
}

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const settings = loadSettings();

    // Always handle explicit /pi-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const isPiVcc = customInstructions === PI_VCC_COMPACT_INSTRUCTION;
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;

    const ownCut = buildOwnCut(branchEntries as any[]);
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = (lastComp as any)?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && (branchEntries as any[]).some((e: any) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      dbg(settings, {
        cancelled: true,
        reason: ownCut.reason,
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!(lastComp as any).firstKeptEntryId,
          foundInBranch: (lastComp as any).firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === (lastComp as any).firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = agentMessages;

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce((sum: number, e: any) => {
      const c = e.message?.content;
      if (typeof c === "string") return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s: number, p: any) => {
        if (p.text) return s + p.text.length;
        if (p.type === "toolCall") return s + (p.name?.length ?? 0) + (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? "").length);
        if (p.type === "toolResult") return s + (typeof p.content === "string" ? p.content.length : JSON.stringify(p.content ?? "").length);
        return s;
      }, 0);
      return sum;
    }, 0);
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: Math.round(keptChars / 4),
    };

    const config = settings;

    // Compute entry-ID range for compaction-scoped recall
    const messageRange = computeMessageRange(
      branchEntries as any[],
      firstKeptEntryId,
    );

    const compileInput: CompileInput = {
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    };

    const summary = compile(compileInput);

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(config, {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      messageRange,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const sections = [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);
    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections,
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      messageRange,
      compressionRatio: preparation.tokensBefore > 0
        ? Math.round(preparation.tokensBefore / Math.max(1, agentMessages.length))
        : undefined,
      timestamp: new Date().toISOString(),
      tokensBefore: preparation.tokensBefore || undefined,
      keptCount: lastStats?.kept || undefined,
      keptTokensEst: lastStats?.keptTokensEst || undefined,
    };

    lastCompactWasPiVcc = isPiVcc;
    lastCompactHandledByVcc = true;

    // Signal to neuralwatt-mcr that pi-vcc is handling compaction
    // so it doesn't cancel the event. Without this flag, neuralwatt-mcr
    // returns { cancel: true } for MCR models and pi-vcc's summary is
    // discarded by the runner's short-circuit.
    (event as any)._piVccOverriding = true;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // After compaction completes, check if the agent loop stalled and needs
  // an invisible continue to resume.  This handles threshold compaction
  // where willRetry=false — pi-core doesn't auto-retry, and the agent loop
  // exits because hasQueuedMessages() returns false.  If the last message in
  // the rebuilt context is an assistant mid-task (tool_use, length, or error
  // that isn't a clean end_turn), the agent was interrupted and should
  // continue.
  pi.on("session_compact", (event, ctx) => {
    // Only act when pi-vcc drove the compaction
    if (!lastCompactHandledByVcc) return;
    lastCompactHandledByVcc = false;

    // Fire success toast for /compact path only (delayed to let UI settle).
    // /pi-vcc path uses its own onComplete callback in the command handler.
    if (!lastCompactWasPiVcc) {
      const stats = lastStats;
      if (stats) {
        setTimeout(() => {
          try {
            ctx?.ui?.notify?.(
              `pi-vcc: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
              "info",
            );
          } catch {}
        }, 500);
      }
    }

    // Determine if the agent needs to continue after compaction.
    // After rebuildSessionContext, the agent's state.messages are updated.
    // Check the last message: if it's an assistant message that isn't a
    // clean stop, the agent was mid-task and needs to resume.
    //
    // We do NOT continue when:
    // - Last message is user/toolResult (agent can continue naturally)
    // - Last message is assistant with stopReason=stop (task finished)
    // - Last message is assistant with stopReason=aborted (user cancelled)
    // - Last message is assistant with stopReason=error (pi-retry handles
    //   retry via its agent_end handler — avoid duplicate triggerInvisibleContinue)
    //
    // We DO continue when:
    // - Last message is assistant with stopReason=toolUse (mid-tool cycle)
    // - Last message is assistant with stopReason=length (hit max tokens)
    // - Compact-all (firstKeptEntryId="") — context is just the summary,
    //   the agent needs to re-enter the loop to continue the task
    try {
      const entries = ctx.sessionManager.getEntries();
      // Walk backwards to find the last message entry
      let lastMsg: { role: string; stopReason?: string; content?: unknown } | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = (entries as any[])[i];
        if (e.type === "message" && e.message) {
          lastMsg = e.message;
          break;
        }
      }
      if (!lastMsg || lastMsg.role !== "assistant") return;

      // Agent completed its turn cleanly — no continuation needed
      if (lastMsg.stopReason === "stop") return;

      // Agent was aborted by user — don't auto-continue
      if (lastMsg.stopReason === "aborted") return;

      // Agent hit an error — pi-retry handles this via its agent_end handler.
      // If we also fire triggerInvisibleContinue, both extensions race
      // to call prompt([]), causing "Agent is already processing" (wasteful)
      // or a duplicate continuation. Let pi-retry own error retries.
      if (lastMsg.stopReason === "error") return;

      // Agent was mid-task (toolUse or length) — needs to continue.
      triggerInvisibleContinue();
    } catch {
      // Non-critical — if context inspection fails, don't block compaction
    }
  });
};
