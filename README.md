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
- **Regex search** — `vcc_recall` supports regex patterns (`hook|inject`, `fail.*build`) and OR-ranked multi-word queries
- **Result ranking** — search results ranked by term relevance, rare terms weighted higher than common ones
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
