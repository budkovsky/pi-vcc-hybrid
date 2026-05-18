# pi-vcc

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls — produces a brief transcript via extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) **(View-oriented Conversation Compiler)**.

## Demo

![pi-vcc demo](./demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input = same output, always |
| **Token reduction** | Varies | 35-99% on real sessions (higher on longer sessions) |
| **Compaction latency** | Waits for LLM call | 30-470ms, no API calls |
| **History after compaction** | Gone — agent only sees summary | Active lineage searchable via `vcc_recall` (`scope:"all"` available) |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and accumulate |
| **Cost** | Burns tokens on summarization call | Zero — no API calls |
| **Structure** | Free-form prose | Brief transcript + 7 semantic sections + priority tags + metadata footer |
| **Code awareness** | None (summarizes text only) | Symbol-annotated files, type catalog, deep error extraction |

### Real session metrics

Measured on real session JSONLs under `~/.pi/agent/sessions` (chars = rendered message text).

| Session | Messages | Before | After | Reduction | Time |
|---|---|---|---|---|---|
| Session A | 2,943 | 997,162 | 7,959 | 99.2% | 64ms |
| Session B | 1,703 | 428,334 | 7,762 | 98.2% | 29ms |
| Session C | 1,657 | 424,183 | 9,577 | 97.7% | 54ms |
| Session D | 1,004 | 2,258,477 | 4,439 | 99.8% | 30ms |
| Session E | 486 | 295,006 | 11,163 | 96.2% | 30ms |
| Session F | 46 | 5,234 | 3,364 | 35.7% | 5ms |
| Session G | 27 | 8,595 | 2,489 | 71.0% | 2ms |

## Compaction Deep Dive

pi-vcc is one of four compaction approaches in the AI coding-agent ecosystem. Here is how they compare.

### Pi Default Harness

*Based in `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`*

**Architecture**: LLM-based structured summarization via a summarization model.

**Flow**:
1. `shouldCompact()` — checks if `contextTokens > contextWindow - reserveTokens (16k)`
2. `prepareCompaction()` — walks branch entries, finds previous compaction boundary, calculates cut point by walking newest→oldest accumulating estimated message sizes until hitting `keepRecentTokens` (20k default)
3. `compact()` → `generateSummary()` — serializes conversation to plain text (not LLM messages, to prevent the model from continuing it), calls LLM with structured summarization prompt
4. Two prompt variants: initial `SUMMARIZATION_PROMPT` (first time) or `UPDATE_SUMMARIZATION_PROMPT` (merges into existing summary)
5. Output format: `## Goal / ## Constraints & Preferences / ## Progress / ## Key Decisions / ## Next Steps / ## Critical Context`
6. Detects mid-turn splits — when the cut falls mid-turn, generates a separate turn prefix summary in parallel and merges both
7. Tracks file operations (read/write/edit from tool calls) and appends `<read-files>` / `<modified-files>` XML tags to each summary

**Key characteristics**:
- Pure LLM — every compaction costs a model call
- Token-budget backwalk keeps a configurable tail (20k recent tokens)
- Turn-aware: `isSplitTurn` preserves incomplete assistant turns
- Previous-summary merging via update prompt (incremental)
- Non-deterministic — different runs produce different summaries

---

### Claude Code

*Based in `claude-code/src/services/compact/`*

**Architecture**: Three-tier compaction — proactive/manual (LLM), session memory (LLM-free), and micro-compaction (cache-editing).

**Flow (Main Compaction — `compactConversation()`)** :
1. `shouldAutoCompact()` → `getAutoCompactThreshold()` = context window minus reserved output minus buffer (13k)
2. PreCompact hooks execute (SDK extensions can inject custom instructions)
3. `getCompactPrompt()` builds a prompt with a `NO_TOOLS_PREAMBLE`, a detailed 9-section template, and a trailer rejecting tool calls
4. `streamCompactSummary()` first tries a **cache-sharing fork path** (piggybacks on the main thread's prompt-cache prefix with a forked agent), then falls back to a direct streaming path with only `FileReadTool` + `ToolSearchTool`
5. Strips images/documents from messages before sending to the compact API (replaces with `[image]` / `[document]` markers)
6. PTL (Prompt Too Long) retry: `truncateHeadForPTLRetry()` drops oldest API-round groups and retries (up to 3)
7. After summary generation: creates post-compact file attachments (re-reads recently accessed files), plan attachments, skill attachments, delta tool announcements
8. Executes SessionStart hooks and PostCompact hooks
9. Returns `CompactionResult { boundaryMarker, summaryMessages, attachments, hookResults, messagesToKeep }`

**Flow (Session Memory Compact — `trySessionMemoryCompaction()`)** :
1. Feature-gated: `tengu_session_memory` + `tengu_sm_compact` flags
2. Waits for in-progress session memory extraction to finish
3. `calculateMessagesToKeepIndex()` starts from `lastSummarizedMessageId`, expands backwards to meet `minTokens` (10k) and `minTextBlockMessages` (5), capped at `maxTokens` (40k)
4. `adjustIndexToPreserveAPIInvariants()` ensures tool_use/tool_result pairs are not split (handles streaming message fragmentation)
5. No LLM call — uses already-extracted session memory content as the summary
6. Truncates oversized sections via `truncateSessionMemoryForCompact()`
7. Falls back to legacy compact if session memory is empty or boundary can't be found

**Flow (Micro Compact — `microcompactMessages()`)** :
1. **Time-based trigger**: if the gap since the last main-loop assistant message exceeds the threshold (cold server cache), content-clear old tool results to shrink what gets rewritten
2. **Cached microcompact** (experimental, `CACHED_MICROCOMPACT` feature): tracks tool results per message, queues `cache_edits` blocks for the API layer — removes tool results from the server-side cached prompt without mutating local messages and without invalidating the cached prefix
3. Legacy microcompact (content-clear) fully replaced by the cache-editing approach

**Key characteristics**:
- Three compaction tiers: full LLM / session memory (LLM-free) / micro (cache-edit only)
- Cache-aware: cache-sharing fork path, cache-editing microcompact, PTL retry
- Heavy hook system: 3 hook sets (PreCompact → SessionStart → PostCompact)
- File restoration: re-attaches recently read files post-compact
- Circuit breaker: 3 consecutive failures stops retrying
- Partial compact: supports `up_to` (summarize before, keep prefix) / `from` (summarize after, keep suffix) directions
- Analytics: `tengu_compact` events with full token breakdowns, `analyzeContext()` walks every content block

---

### Codex (OpenAI)

*Based in `codex/codex-rs/core/src/compact.rs`, `compact_remote.rs`, `compact_remote_v2.rs`*

**Architecture**: Rust-based, three concurrent compaction paths — inline (local LLM), remote (server-side), and remote v2 (streaming).

**Flow**:
1. Decision: `should_use_remote_compact_task()` checks whether the provider supports remote compaction
2. Three parallel implementations:

**Inline (local) Path** (`compact.rs`):
1. Pre-hooks → LLM call with a compact prompt → Post-hooks
2. Uses `ContextCompactionItem` — a first-class protocol item embedded in conversation history (not a hack)
3. `COMPACT_USER_MESSAGE_MAX_TOKENS` = 20k token cap
4. `InitialContextInjection` controls when system context is re-injected:
   - `DoNotInject` — for pre-turn/manual compaction (next regular turn handles reinjection)
   - `BeforeLastUserMessage` — for mid-turn compaction (injects above the last real user message)
5. Summarization prompt (from `templates/compact/prompt.md`):
   - "Context checkpoint compaction" handoff summary
   - Key sections: progress, decisions, constraints, remaining work
6. Summary prefix (`templates/compact/summary_prefix.md`): `"Another language model started to solve this problem..."`
7. `trim_function_call_history_to_fit_context_window()` — truncates oversized call histories before compact
8. Event-driven: emits TurnStarted, stream events, TurnCompleted
9. Backoff retry via `codex_util::backoff`

**Remote Path** (`compact_remote.rs`):
1. Delegates compaction to the codex-backend server via the Responses API Compact endpoint
2. Server-side compaction uses OpenAI's own compact infrastructure
3. Client sends history, server returns a `CompactedItem`
4. `process_compacted_history()` replaces conversation items with the compacted version
5. Same hook system (PreCompact → PostCompact) and analytics tracking
6. Logs request/response data via `build_compact_request_log_data()`

**Remote v2 Path** (`compact_remote_v2.rs`):
1. Uses Responses API streaming compact — same endpoint as v1 but leverages the existing `ModelClientSession` for streaming
2. Feature-gated: `Feature::RemoteCompactionV2` (under development, disabled by default)
3. Reuses `process_compacted_history()` and `trim_function_call_history_to_fit_context_window()`
4. Rollout-trace aware: `CompactionCheckpointTracePayload` for end-to-end observability

**Key characteristics**:
- Three parallel compaction implementations: inline / remote / remote-v2
- Server-side compaction can delegate to OpenAI's backend (token savings on the client)
- Rust async with cancellation tokens throughout
- `ContextCompactionItem` is a first-class protocol type, not a synthetic message
- Fine-grained `InitialContextInjection` control over system context reinjection
- Event-driven architecture: full turn lifecycle for compaction (start → stream → complete → error)
- `CompactionAnalyticsAttempt` tracks every phase, status, and implementation

---

### Comparison Summary

| Aspect | Pi Default | pi-vcc | Claude Code | Codex |
|--------|-----------|--------|-------------|-------|
| **Language** | TypeScript (compiled) | TypeScript (extension) | TypeScript (source) | Rust |
| **LLM dependency** | Always required | None | Optional (session memory bypass) | Always (inline) / server-offloaded |
| **Cut strategy** | Token-budget backwalk (20k recent) | Keep last user message | Min tokens (10k) + min text messages (5) | Context window trim |
| **Summary format** | Markdown structured sections `## Goal` etc. | Bracket-tagged sections `[Session Goal]` | `<analysis>` scratchpad + 9-section `<summary>` | Markdown handoff |
| **Merge with prev** | Update prompt (LLM merges) | Header-by-header deterministic dedup | Via session memory (LLM-free) or prompt | Replaces (no merge) |
| **File tracking** | `<read-files>` / `<modified-files>` XML tags | `[Files And Changes]` with symbol annotations | Post-compact file re-attachment (re-reads recent files) | Via server (server-managed) |
| **Turn splitting** | Yes (`isSplitTurn` with parallel prefix summary) | No (cuts at last user message) | Via `preservedSegment` metadata | Via `InitialContextInjection` |
| **Cache awareness** | None | Section ordering (stable first for prompt cache) | Cache-sharing fork path, cache-editing microcompact, PTL retry | Server-side cache (remote path) |
| **Hook system** | 2 hooks (`session_before_compact`, `session_compact`) | 2 hooks (before_compact, session_compact) | 3 hooks (PreCompact, SessionStart, PostCompact) | 2 hooks (PreCompact, PostCompact) |
| **Micro compaction** | None | None | Yes (cache-editing + time-based content clear) | None |
| **Partial compact** | None | None | Yes (`up_to` / `from` directions) | None |
| **Error handling** | Basic | Orphan recovery (auto-fixes broken kept-entry IDs) | PTL retry (3x), circuit breaker (3 failures) | Backoff retry |
| **Token estimation** | chars/4 heuristic | chars/4 heuristic | `roughTokenCountEstimation` + 4/3 padding | `approx_token_count` |
| **Determinism** | Non-deterministic (LLM) | Deterministic (no LLM) | Non-deterministic (LLM) / deterministic (SM) | Non-deterministic (LLM) / deterministic (server) |
| **Latency** | LLM call time | 2–64ms | LLM call time (or instant with SM/micro) | LLM call time (or server-offloaded) |
| **Cost** | Per-compact LLM tokens | Zero | Per-compact LLM tokens or zero (SM/micro) | Per-compact LLM tokens or server-side |
| **Debugging** | Basic | `/tmp/pi-vcc-debug.json` snapshots | `logForDebugging`, analytics events | Rollout trace, compaction analytics |

## Features

- **No LLM** — purely algorithmic, zero extra API cost
- **Brief transcript** — chronological conversation flow, each tool call collapsed to a one-liner with `(#N)` refs, text truncated to keep it compact
- **6 semantic sections** — session goal, files & changes, type catalog, commits, outstanding context, user preferences
- **Bounded merge** — rolling sections re-capped after merge instead of growing unbounded
- **Lossless recall** — `vcc_recall` reads raw session JSONL, so active-lineage history stays searchable across compactions
- **Scoped recall** — default search is active lineage; use `scope:"all"` for all lineages, or `scope:"compaction:N"` / `scope:"compaction:latest"` to search within a specific compaction segment's original messages
- **Priority error tags** — outstanding context items tagged `[ERROR]`, `[WARN]`, `[INFO]` for urgency at a glance
- **Metadata footer** — each compaction summary ends with timestamp, compression ratio, and message range
- **Cache-friendly ordering** — stable sections (goal, preferences, files, commits) come first; volatile sections (outstanding context, current status) come last, maximizing prompt-cacheable prefix across compactions
- **Adaptive recall view** — search results grouped by conversation segments (turns) with match indicators (`>`) and context preservation, so the agent sees the conversational structure around each match
- **Regex search** — `vcc_recall` supports regex patterns (`hook|inject`, `fail.*build`) and OR-ranked multi-word queries
- **Result ranking** — search results ranked by BM25 term relevance, rare terms weighted higher than common ones
- **`/pi-vcc-recall`** — slash command to search history directly, results shown as collapsible message and auto-fed to agent as context
- **Fallback cut** — still works when Pi core returns nothing to summarize
- **`/pi-vcc`** — manual compaction on demand

## Install

```bash
pi install https://github.com/monotykamary/pi-vcc@tom
```

Or try without installing:

```bash
pi -e https://github.com/monotykamary/pi-vcc@tom
```

## Usage

Once installed, pi-vcc registers a `session_before_compact` hook.

- Run `/pi-vcc` to trigger pi-vcc compaction manually.
- By default, `/compact` and auto-threshold compactions still go through pi core (LLM-based). Set `overrideDefaultCompaction: true` in the config to let pi-vcc handle all compaction paths.
- To search older active-lineage history after compaction, use `vcc_recall`.
- To intentionally search across all lineages, pass `scope:"all"` to `vcc_recall` or run `/pi-vcc-recall <query> scope:all`.
- To search and feed results to agent yourself, run `/pi-vcc-recall <query> [page:N]`.
  - Tip: type `/recall` and Pi will autocomplete to `/pi-vcc-recall`.

### How compaction works

Pi splits the conversation at the **last user message**. Everything after — the **kept tail** — stays intact and untouched. pi-vcc only summarizes the older portion before that cut point.

### Compacted message structure

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts (refreshToken, verifyToken, Session)
- Read: src/types.ts (User, AuthPayload)
- Created: tests/auth-refresh.test.ts

[Type Catalog]
- src/auth/session.ts [modified]:
  export function refreshToken(token: string): Promise<Session>
  export function verifyToken(token: string): Promise<User>
  export interface Session {
- src/types.ts [read]:
  export interface User {
  export type AuthPayload = {

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- [ERROR] [tsc] src/session.ts(5,18): error TS2304: Cannot find name 'authenticateUser'
- [ERROR] [bash:exit 1] bun test tests/auth.test.ts → 3 tests failed
- [WARN]  [tests] FAIL auth.test.ts > refresh token should work
- [INFO]  [no matches] grep "verifyCredentials"

[Current Status]
- Working on: fix the auth bug, users can't log in after password reset
- Last action: Edit "src/auth/session.ts"
- Next: need to add the refreshToken function signature

---

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset...
* Read "src/auth/session.ts" (#3)
* Read "src/types.ts" (#5)
* Edit "src/auth/session.ts" (#7)
* bash "bun test tests/auth.test.ts" (#9)
...(28 earlier lines omitted)

---

---
Compaction at 2026-05-18T14:32:00Z — 47 msgs → 23k tok (12x) | tail: 3 msgs ~5.2k tok (range: [#0, #43])

Use `vcc_recall` to search for prior work, decisions, and context from before this summary.
Do not redo work already completed.
```

Sections appear only when relevant — a session with no git commits won't have `[Commits]`.

**Sections:**

| Section | Description |
|---|---|
| `[Session Goal]` | Initial goal + scope changes (regex-based extraction) |
| `[Files And Changes]` | Modified/created/read files from tool calls, annotated with exported symbol names (capped, paths trimmed to common root) |
| `[Type Catalog]` | Exported signature lines from modified and read files — the public API surface the model needs for continuation |
| `[Commits]` | Git commits made during the session (last 8, hash + first line) |
| `[Outstanding Context]` | Unresolved items — error exit codes, test failures, tsc errors, empty search results, pending questions — tagged `[ERROR]`/`[WARN]`/`[INFO]` by severity |
| `[Current Status]` | Current focus, last file-modifying action, and next steps — extracted from the conversation tail |
| `[User Preferences]` | Regex-extracted from user messages (`always`, `never`, `prefer`...) |
| Brief transcript | Chronological conversation flow — rolling window of ~120 recent lines, tool calls collapsed to one-liners with `(#N)` refs |

**Merge policy:**
- `Session Goal`, `User Preferences`: concise sticky sections
- `Outstanding Context`, `Type Catalog`, `Current Status`: volatile (replaced each compaction)
- `Files And Changes`, `Commits`: unique union across compactions
- Brief transcript: rolling window, older lines drop off

### Deep error extraction

`[Outstanding Context]` goes beyond keyword matching. It captures:

| Signal | Format | Example |
|---|---|---|
| Bash non-zero exit code | `[bash:exit N]` | `[bash:exit 1] npm test → 3 tests failed` |
| TypeScript compiler error | `[tsc]` | `[tsc] src/auth.ts(12,5): error TS2322: Type 'string' is not...` |
| Test failure | `[tests]` | `[tests] FAIL auth.test.ts > login should work` |
| Empty grep/glob | `[no matches]` | `[no matches] Grep "verifyCredentials"` |
| Tool error result | `[tool]` | `[bash] Command not found` |
| Blocker text | `[user]` or plain | `[user] The build is still failing with...` |

All items are deduplicated — the same error won't appear twice.

### Symbol-level file annotations

`[Files And Changes]` annotates file paths with exported symbol names extracted from tool call arguments and results:

```
- Modified: src/auth.ts (login, verifyToken, Session)
- Read: src/types.ts (User, AuthPayload)
```

Supported languages: TypeScript/JavaScript (`export function/class/type/interface`), Python (`def`/`class`), Go (`func`, exported only), Rust (`pub fn/struct/enum/trait`).

### Type catalog

`[Type Catalog]` captures the exact exported signature lines from modified and read files. This gives the compacted model the type signatures it needs to continue coding — without re-reading files.

Modified files appear first, read files second. Entries are capped at 8 signatures per file and 12 files total.

## Recall (Lossless History)

Pi's default compaction discards old messages permanently. After compaction, the agent only sees the summary.

`vcc_recall` bypasses this by reading the raw session JSONL file directly. By default it searches only the active conversation lineage, regardless of how many compactions have happened. Use `scope:"all"` only when you intentionally want to include off-lineage branches.

### Adaptive View (Structure-Preserving Search Results)

Search results are grouped by **conversation segments** (turns) instead of showing flat ranked entries. Each segment starts at a user or bash message and includes all subsequent assistant responses, tool calls, and tool results.

Matched entries are marked with `>`, non-matched entries within the same segment are shown for context:

```
vcc_recall({ query: "auth bug" })
```

Returns:
```
Found 4 matches for "auth bug" — 2 matches across 1 segment

--- #12-#17 (2/6 entries match) ---
> #12 [user] I found an auth bug in the login flow
  #13 [assistant] Let me check the auth module...
  #14 [tool_call] Read src/auth.ts
  #15 [tool_result] export function login...
> #16 [assistant] The bug is in refreshToken
  #17 [tool_result] Edit src/auth.ts (success)
```

When matches span multiple segments, adjacent non-matching turns are shown with a `(context)` tag:

```
Found 3 matches for "cache" — 2 matches across 2 segments

--- #5-#8 (1/4 entries match) ---
  #5 [user] add caching to the API layer
  #6 [assistant] I'll set up Redis...
  #7 [tool_call] Edit src/cache.ts
> #8 [tool_result] Redis connected successfully

--- #20-#23 (1/4 entries match) ---
> #20 [user] the cache eviction policy is wrong
  #21 [assistant] Let me check the TTL config...
  #22 [tool_call] Read src/cache.ts
  #23 [tool_result] export const TTL = 3600

--- #9-#19 (context) ---
  #9 [user] also fix the error handling
  #10 [assistant] Added try/catch around cache calls
```

This format preserves the conversational structure around matches, so the agent can understand *where* in the conversation flow each match occurred and what context surrounds it.

### Search

Queries support **regex** and **multi-word OR logic** ranked by relevance:

```
vcc_recall({ query: "auth token" })                                    // active-lineage OR search, ranked
vcc_recall({ query: "auth token", page: 2 })                           // paginated (5 results/page)
vcc_recall({ query: "hook|inject" })                                    // regex pattern
vcc_recall({ query: "fail.*build" })                                    // regex pattern
vcc_recall({ query: "auth token", scope: "all" })                      // search all lineages
vcc_recall({ query: "race condition", scope: "compaction:2" })         // search within compaction #2's segment
vcc_recall({ query: "design rationale", scope: "compaction:latest" })  // search most recent compaction segment
```

Compaction-scoped search targets only the original messages that were summarized by that compaction cycle. This lets you drill into specific conversation segments without sifting through unrelated chat.

Manual slash command:

```
/pi-vcc-recall auth token scope:all
/pi-vcc-recall race condition scope:compaction:latest
```

### Browse

Without a query, returns the last 25 entries as brief summaries:

```
vcc_recall()
vcc_recall({ scope: "all" })  // browse recent entries across all lineages
```

### Expand

Returns full untruncated content for specific indices found via search:

```
vcc_recall({ expand: [41, 42] })                 // active-lineage expand
vcc_recall({ expand: [41, 42], scope: "all" })   // expand across all lineages
```

Typical workflow: **search → find relevant entry indices → expand those indices for full content**.

> Some tool results are truncated by Pi core at save time. `expand` returns everything in the JSONL but can't recover what Pi already cut.

## Pipeline

1. **Normalize** — raw Pi messages → uniform blocks (user, assistant, tool_call, tool_result, thinking, bash)
2. **Filter noise** — strip system messages, empty blocks, noise tools (TodoWrite, etc.)
3. **Build sections** — extract goal, file paths + symbols, type catalog, blockers (exit codes, tsc, tests, empty grep), preferences
4. **Brief transcript** — chronological conversation flow, tool calls collapsed to one-liners, text truncated
5. **Format** — render into bracketed sections + transcript, with cache-friendly ordering (stable sections first, volatile last)
6. **Merge** — if previous summary exists: sticky sections merge, volatile sections replace, transcript rolls
7. **Footer** — append timestamp, compression ratio, message range, and recall note

## Config

Config lives at `~/.pi/agent/pi-vcc-config.json` (auto-scaffolded on first load with safe defaults):

```json
{
  "overrideDefaultCompaction": false,
  "debug": false
}
```

- **`overrideDefaultCompaction`** *(default `false`)*: when `false`, pi-vcc only runs for `/pi-vcc`; `/compact` and auto-threshold compactions fall through to pi core. Set `true` to make pi-vcc handle all compaction paths.
- **`debug`** *(default `false`)*: when `true`, each compaction writes detailed info to `/tmp/pi-vcc-debug.json` — message counts, cut boundary, summary preview, sections.

## Related Work

- [VCC](https://github.com/lllyasviel/VCC) — the original transcript-preserving conversation compiler
- [Pi](https://github.com/badlogic/pi-mono) — the AI coding agent this extension is built for

## License

MIT
