# Hybrid Context Manager for Pi — Specification

A hybrid context-management extension for [pi](https://github.com/earendil-works/pi-mono):
**proven deterministic compaction** in the foreground (no LLM, no pause) + **background
vectorized semantic indexing** of the trimmed context, exposed to the assistant as a recall
tool it is aware of and uses actively.

## 1. Goal

1. **Smooth conversation** — no long stall when context hits the compaction threshold.
2. **Proven deterministic compaction** — reuse an existing, battle-tested no-LLM compactor
   (the **VCC pipeline** from `pi-vcc`), not a from-scratch implementation.
3. **Background indexing** — the trimmed context is vectorized by a small local model,
   non-blocking, never stalls a turn.
4. **Assistant-aware recall** — the assistant has a command/function to query the index,
   knows it exists, and uses it actively when it needs something no longer in live context.

**Net effect:** deterministic compaction keeps live context small and cheap; the trimmed
history stays *semantically reachable* at near-zero token cost. You only pay for the chunks
you actually recall.

## 2. Prior art (and what we reuse vs. add)

There are **two independent `pi-vcc` forks** plus `pi-blackhole`. All three use the same
underlying **VCC** (View-oriented Conversation Compiler) deterministic mechanism, but they
diverge substantially. All three recall tools are **keyword/BM25/regex over the raw session
JSONL — none is semantic.**

| Extension | VCC base | Compaction sections / features | Recall | LLM cost |
|---|---|---|---|---|
| pi default | — | LLM summary | — (history gone) | yes, blocking |
| `sting8k/pi-vcc` | base | 5 sections (Goal, Files, Commits, Outstanding, Prefs) + brief transcript; ranked brief; sophisticated brief (heredoc strip, head/tail truncation) | `vcc_recall` keyword | none |
| **`monotykamary/pi-vcc`** | extended | **8 sections** (adds **Type Catalog, Earlier Turns, Anchors**) + **symbol-annotated files, type catalog (exported signatures), deep error extraction, priority error tags** `[ERROR]/[WARN]/[INFO]/[RESOLVED]`, **cache-friendly section ordering**, structured anchors for zero-tool-call recall, fabric-trace, proactive threshold | `vcc_recall` keyword | none |
| `pi-blackhole` | fork of sting8k | sting8k core (simpler brief) + **window-aware auto-compact thresholds** (ratio/preset curves) + **newest-first retained tool-output budgeting** + **observational memory** (Observer/Reflector/Dropper) | unified `recall` keyword | memory workers only |

### Verified: is pi-blackhole's compaction "more effective"?

**Partly, but not in the summarizer.** From the source diffs:
- pi-blackhole's VCC core is a **fork of `sting8k/pi-vcc`** (file headers cite it as upstream),
  **not** the more advanced `monotykamary` line.
- Real fixes it adds: line-boundary section-header matching; Session Goal keeps *first* items;
  `Read ∩ Modified` dedup; `normalize` captures tool_result `isError` + `thinking`.
- But it **removed** pi-vcc's ranked-brief and its `brief.ts` is **simpler** than current
  `sting8k/pi-vcc` (lost heredoc stripping, head/tail token truncation, segment-closing
detection; `BASH_CAP` 240→120).
- Its genuine wins are **orthogonal to the deterministic summarizer**: **when** to compact
  (window-aware thresholds) and **what survives** (tool-output budgeting), plus the
  **LLM-based** observational-memory layer (out of scope for a deterministic goal).

### Strongest deterministic base: `monotykamary/pi-vcc`

The most developed pure-deterministic compactor (largest, richest core: brief 741 lines,
build-sections 312 lines vs ~76 for the others). It adds code-awareness the others lack:
**Type Catalog** (exported API surface), **symbol-annotated file tracking**, **deep error
extraction** with priority tags, **Anchors** (commit hashes / error IDs / key paths for
zero-tool-call recall), and **cache-friendly section ordering** (stable sections first to
maximize the prompt-cacheable prefix). This is the best proven mechanism to build on.

**Key gap we still fill:** every fork's recall is **keyword/BM25**, not **semantic**.
They cannot match a query to content that is *about* the same thing but not the same words.
Our differentiator is a **vectorized semantic recall layer** on top of the proven compactor.

**Decision: build on `monotykamary/pi-vcc`.** Reuse its VCC compaction pipeline (the
strongest proven mechanism) and keep its `vcc_recall` keyword tool. Optionally adopt
pi-blackhole's **window-aware thresholds** and **tool-output budgeting** (orthogonal, additive).
Add only the semantic layer. Do **not** reinvent compaction.

## 3. The proven compaction mechanism (VCC pipeline)

From `monotykamary/pi-vcc` `src/core/summarize.ts` → `compile()`:

```
compile({ messages, previousSummary, fileOps })
  → normalize(messages)          // raw pi messages → uniform blocks
  → filterNoise(blocks)          // strip system / empty / noise tools
  → buildSections({blocks, fileOps})  // 8 sections incl. Type Catalog, Anchors, error tags
  → formatSummary(data)          // bracket-tagged sections + brief transcript, cache-friendly order
  → mergePrevious(prev, fresh)   // bounded merge across repeated compactions
```

Properties (measured by the project): **no LLM calls, 30–470ms latency, 35–99% token
reduction, deterministic (same input = same output).** Output is **8 structured sections**
(Session Goal, Files And Changes, Commits, Type Catalog, Outstanding Context, Earlier
Turns, Anchors, User Preferences) plus a rolling brief transcript, with priority error tags
and cache-friendly ordering. Cut is task-boundary-aware (splits at complete turns, not
mid-tool-call).

We use this as-is for the compaction slot. Our earlier "cheap skeleton" idea is discarded —
VCC's extraction is strictly better.

## 4. Architecture overview

```
context grows
     │
     ▼
threshold crossed ──► session_before_compact fires  (single owner: our forked VCC hook)
     │                       │
     │                       ├─► (foreground, deterministic, NO LLM)
     │                       │     VCC compile() → structured summary + brief transcript
     │                       │     → CompactionEntry  (30–470ms, no pause)
     │                       │
     │                       └─► (background, fire-and-forget)
     │                             serialize trimmed span → chunk
     │                             → write to ~/.pi/vector/<sessionId>/
     │                             → qmd embed --index <sessionId>
     ▼
LLM context = VCC summary + kept tail   (small, fast, cheap)
     │
     ▼
model needs a forgotten detail?
     │
     ├──► vcc_recall(query)      [proven, keyword/BM25/regex over raw JSONL]
     └──► semantic_recall(query) [NEW, vector search over qmd index]
```

Two complementary recall tools:
- **`vcc_recall`** (inherited from pi-vcc): fast keyword/regex — great for exact terms,
  file paths, error IDs, commit hashes.
- **`semantic_recall`** (ours): vector similarity — great for "the thing we decided about
  X" when the exact words aren't in the query.

## 5. Components

### 5.1 Deterministic compaction (reused, not reinvented)
- Fork `monotykamary/pi-vcc`; keep its `session_before_compact` hook and VCC `compile()` pipeline.
- Keep its config surface (`overrideDefaultCompaction`, per-model thresholds, smart keep,
  `continueAfterThresholdCompact`, etc.).
- No change to compaction behavior — it is the proven mechanism.

### 5.2 Background semantic indexing (NEW)
In the same `session_before_compact` hook, after the VCC summary is produced, fire-and-forget:
1. Take the trimmed span (`preparation.messagesToSummarize` + `turnPrefixMessages`).
2. `serializeConversation(convertToLlm(...))` → chunk into ~1500-token pieces.
3. Write each chunk to `~/.pi/vector/<sessionId>/NNNN.md` (metadata header: turn,
   timestamp, files touched).
4. Ensure the session's qmd index exists, then `qmd embed --index <sessionId>` in the
   background.
- Never awaited on the turn path. If it lags, `semantic_recall` just returns fewer results
  until it catches up — the conversation is never blocked.

### 5.3 `semantic_recall` tool (NEW, assistant-facing)
- `pi.registerTool({ name: "semantic_recall", ... })`.
- **Input:** `{ query: string, limit?: number }`.
- **Behavior:** `qmd vsearch "<query>" --index <sessionId> -n <limit> --format json`
  → parse top chunks → return text + provenance.
- **Awareness:** `promptSnippet` + `promptGuidelines` tell the model it exists and *when*
  to use it ("when keyword recall / live context lacks a detail that was discussed earlier —
  use semantic recall for conceptual/paraphrased lookups").
- **Default limit:** 5 (tunable).

### 5.4 Lifecycle
- `session_start` — ensure the session's qmd index/collection exists.
- `session_shutdown` — clean up the session's index / directory.

## 6. Backend: qmd (local embeddings + storage)

| Property | Detail |
|---|---|
| Embedding model | `embeddinggemma-300M-Q8_0` (GGUF, already cached at `~/.cache/qmd/models/`) |
| Search | Hybrid available (BM25 + vector + rerank). Default recall uses `vsearch` (vector) for latency; `query` if rerank quality is wanted. |
| Isolation | `--index <sessionId>` → each pi session gets its own isolated index. |
| Process | Separate process → embedding work never blocks the LLM turn. |

**Tradeoff:** full `qmd query` uses a 1.7B expansion model (slower); default is `vsearch`.

## 7. Storage layout

```
~/.pi/vector/
  <sessionId>/
    0001.md
    0002.md
    ...
```
Each chunk file: small metadata header (turn, timestamp, files touched) + chunk text.
Session qmd index keyed by `--index <sessionId>`.

## 8. Configuration (defaults, tunable)

| Setting | Default | Description |
|---|---|---|
| *(pi-vcc settings)* | — | inherited: `overrideDefaultCompaction`, thresholds, smart keep, etc. |
| `semantic.enabled` | `true` | enable the background index + `semantic_recall` tool |
| `semantic.chunkTokens` | `1500` | chunk size for indexing the trimmed span |
| `semantic.limit` | `5` | default top-k returned by `semantic_recall` |
| `semantic.mode` | `vsearch` | `vsearch` (vector) / `search` (BM25) / `query` (hybrid+rerank) |

## 9. Out of scope (for now)
- Auto-injecting relevant chunks before each turn (chosen: on-demand only).
- Cross-session / global memory.
- Persisting vectors across restarts beyond qmd's own index (raw messages already persist in
  the session JSONL; vectors can be rebuilt if needed).

## 10. Deliverables
- A fork of **`monotykamary/pi-vcc`** (or a companion extension that layers on top) adding:
  - background qmd vector indexing in the compaction hook,
  - the `semantic_recall` tool,
  - lifecycle cleanup.
  - (optional) pi-blackhole's window-aware compact thresholds + retained tool-output budgeting.
- No new npm dependencies beyond what pi-vcc already uses — relies on `qmd` + the cached
  embedding model.

## 11. Open integration question
How tightly to couple to pi-vcc (base = `monotykamary/pi-vcc`):
- **Option A — fork pi-vcc** (recommended): own the single `session_before_compact` hook,
  run VCC compile + background index together. Clean, single owner, full control.
- **Option B — companion extension**: install pi-vcc as-is, add a separate extension that
  indexes + exposes `semantic_recall`. Needs pi to allow a second `session_before_compact`
  handler to observe the trimmed span (to verify) — otherwise it must re-derive the trimmed
  span from the session file.

## 12. Validation plan
1. Build the extension (fork or companion) and wire it.
2. Run a real session long enough to cross the compaction threshold.
3. Confirm VCC compaction is instant (no LLM) and the structured summary is present.
4. Confirm the trimmed span was written + indexed in the background.
5. Call `semantic_recall(query)` for a fact that only exists in the trimmed span, phrased in
   *different words* than the original — verify semantic (not keyword) retrieval works.
6. Compare against `vcc_recall` to confirm the semantic layer adds value on paraphrased
   queries.
7. Tune chunk size / recall limit / mode based on observed recall quality.
