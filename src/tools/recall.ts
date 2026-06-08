import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { loadAllMessages } from "../core/load-messages";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";
import { getActiveLineageEntryIds } from "../core/lineage";
import { normalizeRecallScope } from "../core/recall-scope";
import type { PiVccCompactionDetails } from "../details";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/**
 * Read the session file, find compaction entries, and resolve the
 * message range for a given compaction index (0-based).
 *
 * The stored messageRange uses entry IDs ([firstId, lastId]).
 * This function resolves those IDs to global message indices
 * by scanning the session file.
 *
 * Returns [startIndex, endIndex] or undefined if not found.
 */
const resolveCompactionMessageRange = (
  sessionFile: string,
  scopeStr: string,
): [number, number] | undefined => {
  const isLatest = scopeStr === "compaction:latest";
  const targetIndex = isLatest
    ? -1
    : parseInt(scopeStr.replace("compaction:", ""), 10);
  if (isNaN(targetIndex) && !isLatest) return undefined;

  const content = readFileSync(sessionFile, "utf-8");
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* skip malformed lines */
    }
  }

  // Collect pi-vcc compaction entries in order
  const compactions = entries.filter(
    (e: any) => e.type === "compaction" && e.details?.compactor === "pi-vcc",
  );

  if (compactions.length === 0) return undefined;

  const target = isLatest
    ? compactions[compactions.length - 1]
    : compactions[targetIndex];

  const msgRange = target?.details?.messageRange as [string, string] | undefined;
  if (!msgRange) return undefined;

  // Build entry-id → global-index map from the full session file
  const idToGlobal = new Map<string, number>();
  let globalIdx = 0;
  for (const e of entries) {
    if (e.type === "message" && e.message) {
      if (e.id) idToGlobal.set(e.id, globalIdx);
      globalIdx++;
    }
  }

  const firstIdx = idToGlobal.get(msgRange[0]);
  const lastIdx = idToGlobal.get(msgRange[1]);
  if (firstIdx === undefined || lastIdx === undefined) return undefined;

  return [firstIdx, lastIdx];
};

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Search session history. Defaults to active lineage; use scope:'all' to include off-lineage branches." +
      " Supports regex queries, paging, and expand indices. " +
      "Use scope:'compaction:N' to search within a specific compaction's message range.",
    promptSnippet:
      "vcc_recall: Search history; default scope is active lineage. " +
      "Use scope:'all' for off-lineage branches. " +
      "Use scope:'compaction:N' or scope:'compaction:latest' for targeted search within a compaction segment.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance." }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" }),
      ),
      page: Type.Optional(
        Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1." }),
      ),
      scope: Type.Optional(
        Type.String({ description: "Search scope. Options: 'lineage' (default), 'all' (entire session), 'compaction:N' (within compaction #N), 'compaction:latest' (most recent compaction segment)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }

      const rawScope = normalizeRecallScope(params.scope);
      const scopeStr = String(params.scope ?? "").toLowerCase();
      const isCompactionScope = scopeStr.startsWith("compaction:");

      // Resolve compaction-scoped message range
      let entryFilter: ((idx: number) => boolean) | undefined;
      let scopeLabel = "";

      if (isCompactionScope) {
        const range = resolveCompactionMessageRange(sessionFile, scopeStr);
        if (!range) {
          return {
            content: [{ type: "text", text: `No compaction found for scope: ${scopeStr}. Use scope:'lineage' (default) or scope:'all'.` }],
            details: undefined,
          };
        }
        const [start, end] = range;
        entryFilter = (idx: number) => idx >= start && idx <= end;
        scopeLabel = ` (scope: ${scopeStr}, messages [#${start}, #${end}])`;
      }

      const lineageEntryIds = rawScope === "lineage"
        ? getActiveLineageEntryIds(ctx.sessionManager)
        : undefined;
      const expandSet = new Set(params.expand ?? []);
      const hasExpand = expandSet.size > 0;

      if (hasExpand && !params.query) {
        const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds, entryFilter);
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside ${rawScope === "all" ? "session history" : "active lineage"}${scopeLabel}: ${invalid.join(", ")}` }],
            details: undefined,
          };
        }

        const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        const output = (scopeLabel || (rawScope === "all" ? "Scope: all" : "")) + "\n" + formatRecallOutput(expanded);
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds, entryFilter);
      const allResults = params.query?.trim()
        ? searchEntries(msgs, rawMessages, params.query)
        : msgs.slice(-DEFAULT_RECENT);

      if (params.query?.trim()) {
        const searchScopeLabel = scopeLabel || (rawScope === "all" ? " (scope: all)" : "");
        const page = Math.max(1, params.page ?? 1);
        const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
        // Cap pages: don't let the agent page through hundreds of results.
        // If totalPages is too large, suggest narrowing the query instead.
        const MAX_PAGES = 10;
        if (allResults.length > 0 && page > Math.min(totalPages, MAX_PAGES)) {
          return {
            content: [{ type: "text", text: `Too many results to page through (${allResults.length} matches across ${totalPages} pages). Try a more specific query or use scope:'compaction:N' to narrow the range${searchScopeLabel}.` }],
            details: undefined,
          };
        }
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = allResults.slice(start, start + PAGE_SIZE);
        const header = totalPages > 1
          ? `Page ${page}/${totalPages} (${allResults.length} total matches${searchScopeLabel})`
          : `${allResults.length} matches${searchScopeLabel}`;
        const footer = page < totalPages && page < MAX_PAGES
          ? `\n--- Use page:${page + 1} for more results ---`
          : totalPages > MAX_PAGES
            ? `\n--- Results truncated at ${MAX_PAGES} pages. Use a more specific query or scope to narrow results. ---`
            : "";
        const output = formatRecallOutput(pageResults, params.query, header) + footer;
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const output = (scopeLabel || (rawScope === "all" ? "Scope: all" : "")) + "\n" + formatRecallOutput(allResults, params.query);
      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    },
  });
};

