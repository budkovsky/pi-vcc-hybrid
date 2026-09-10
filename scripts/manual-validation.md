# Phase 7a — manual validation runbook

Validates the semantic recall pipeline end-to-end against a **real pi session**
(SDK-driven, hermetic agentDir). This is the Phase 7a definition of done.

## Automated run (preferred)

```sh
bun scripts/validate-phase7a.ts          # ~4-6 min wall time
P7A_KEEP=1 bun scripts/validate-phase7a.ts   # keep the temp agentDir for inspection
P7A_MODEL=<provider/model> bun scripts/validate-phase7a.ts
```

Requirements: qmd installed with the embedding model cached, and a working
chat model (default: `homelab-vllm/qwen38` from the hermetic `models.json`;
override with `P7A_MODEL`). The script is hermetic — it never touches the
user's real `~/.pi/agent` (sessions/settings), but it **does** use the real
`~/.pi/vector/<sessionId>/` (that is what is being validated) and the shared
qmd daemon (port 8390; a running daemon is reused, otherwise one is spawned).

Exit code 0 = all items pass. Evidence: `docs/validation/phase7a-evidence.md`
(results, compaction summary, tool outputs, final answer, run log).

## What the script does (the 6 items)

1. **Extension loads** — `semantic_recall` + `vcc_recall` registered in a real
   session; context pushed past the compaction threshold (11k tokens) with two
   filler prompts, one of which carries the planted fact.
2. **Compaction quality** — a compaction entry appears in the session JSONL,
   instant (duration from file timestamps, no LLM), with the VCC summary
   sections present, and the planted fact trimmed OUT of the live context.
3. **Vector dir + daemon** — `~/.pi/vector/<sessionId>/` populated
   (`NNNN.md` chunks + `meta.json`), daemon answers queries for this
   collection, `indexer.log` absent (no failures).
4. **Paraphrase recall** — a near-zero-keyword-overlap paraphrase of the
   fact → `semantic_recall` returns the chunk containing the fact
   (all distinctive tokens present).
5. **Value proof** — the *same* paraphrase via `vcc_recall` (keyword/BM25)
   finds 0 of the distinctive tokens. Run **before** item 4 on purpose:
   once the model has seen the fact, its own reply keeps it in the
   task-boundary kept tail and poisons items 4/6.
6. **Spontaneous use** — after one more filler turn + compaction pushes the
   fact out of the kept tail (pre-checked: fact absent from live context), a
   follow-up question makes the assistant call `semantic_recall` on its own
   and answer with the exact fact.

## Manual fallback (if the script can't be run)

1. Install the fork as a pi extension (`pi -e <path-to-fork>/index.ts`),
   enable `semantic.enabled` in `pi-vcc-config.json`.
2. Drive a session past the compaction threshold (e.g. paste a large context
   dump containing one distinctive fact, then more filler).
3. Check the session JSONL: compaction entry with an 8-section-style summary;
   confirm the fact is gone from the live context.
4. Check `~/.pi/vector/<sessionId>/`: `NNNN.md` files + `meta.json`,
   no `indexer.log` (or one without errors).
5. Ask the assistant a paraphrased question about the fact (no keyword
   overlap) → it should call `semantic_recall` and answer correctly.
6. Ask the same via `vcc_recall` → keyword layer misses / ranks lower.

## Known gotchas (learned while building the script)

- **The proactive compaction hook fires on `agent_end`** — *after*
  `prompt()` resolves. A prompt sent immediately after a threshold-crossing
  prompt can collide with an in-flight compaction. Quiesce (grace + wait for
  in-flight compactions) and retry on "compaction is in progress".
- **`createAgentSession` does not fire `session_start`** — the SDK flow skips
  `bindExtensions()`. Call `await session.bindExtensions({})` after
  `createAgentSession` to get the daemon warmup exactly like the TUI does;
  otherwise the daemon is spawned lazily on the first `semantic_recall` call
  (works, but the first query pays the model-load cost).
- **The task-boundary cut always keeps the last turn.** Any turn that
  *contains* the fact (a tool result, or the model's own reply quoting it)
  stays in the live context until a *later* compaction trims it. That is why
  item 5 precedes item 4, and why a filler turn + compaction is inserted
  before item 6 (with a pre-check that the fact is actually gone).
- **The session file lags in-memory state** — poll the JSONL for the
  compaction entry instead of reading it once.
- **Compaction summaries elide** — the VCC brief transcript drops long
  verbatim content, so a fact quoted in a trimmed turn does not survive into
  the next summary (verified in runs; if it ever does, the item-6 pre-check
  catches it and the item fails with a contamination warning).
- **Counting tool calls across the whole live context is unreliable** — a
  compaction between two measurements can trim the baseline call out. Count
  within the turn (messages after the last user prompt).
- **First daemon query is slow** (embedding + expansion model load on CPU,
  ~1-3 min cold). The script's item 3 polls up to 180s; a warm daemon makes
  item 4 fast.
