# pi-vcc-hybrid

## Project description

A hybrid context-management extension for **pi**: proven **deterministic VCC compaction** (forked from `monotykamary/pi-vcc` — no LLM, no pause, 8-section structured summary) in the foreground, plus a **background vectorized semantic index** of the trimmed context, exposed to the assistant as a `semantic_recall` tool.

- **Compaction:** reuses the VCC `compile()` pipeline as-is (Option A — single owner of `session_before_compact`); not reinvented.
- **Semantic layer (new, self-contained `src/semantic/`):** fire-and-forget chunking of the trimmed span → `~/.pi/vector/<sessionId>/` → local **qmd** embeddings (`embeddinggemma-300M`, CPU-forced by default). Never blocks a turn; degrades gracefully if the index lags.
- **Recall:** two complementary tools — inherited `vcc_recall` (keyword/BM25/regex) + new `semantic_recall` (vector search, paraphrase-tolerant).

Repo: GitHub fork `budkovsky/pi-vcc-hybrid` of `monotykamary/pi-vcc` (baseline v0.8.8); default branch is `develop` — all work branches off it.

Key docs: `docs/plan/hybrid-recall-spec.md` (spec), `docs/plan/hybrid-recall-implementation-plan.md` (TDD phases 0–7, data contracts, risks), `docs/implementation-progress.md` (checklist — the single source of truth for what is done; mark items `[x]` as they are completed, one phase at a time, in order).

## Commands (bun, not npm)

| Command | What |
|---|---|
| `bun run test` | full suite: `bun test ./tests` (unit) + `vitest run __tests__` (regression) |
| `bun run typecheck` | `tsc --noEmit` (no build/emit — pi loads extensions as raw TS) |
| `bun run lint:dead` | knip dead-code check |
| `RUN_QMD=1` | opt-in flag: enables real-qmd integration tests (default: skipped) |

Green gate: a phase is done only when the **entire** suite (inherited pi-vcc tests + new `tests/semantic/`) passes. The inherited suite must stay green unchanged.

## Layout & boundaries

- `src/` core — **untouched** VCC pipeline (`compile()`, 8 sections, `vcc_recall`). Do not modify; it is the proven mechanism.
- `src/semantic/` — NEW self-contained module (config, paths, chunk, qmd, indexer, recall); no imports from pi-vcc internals except the trimmed-span hand-off.
- Wiring points (only these touch existing files): `src/hooks/before-compact.ts` (few lines after VCC summary) + `index.ts` (tool registration, lifecycle).
- Tests: `tests/semantic/` (new), existing `tests/` + `__tests__/` inherited.

## Branch model

Work on `feat/semantic-layer` off `develop`; one PR per phase (6a/6b and 7a/7b included) so each green gate is reviewable.

## Environment facts

- qmd 2.8.3 installed (`~/.nvm/.../bin/qmd`); embedding model `embeddinggemma-300M-Q8_0` + 1.7B expansion model pre-cached in `~/.cache/qmd/models/`.
- No network at test time; tests force CPU (`QMD_FORCE_CPU=1`) — GPU has observed CUDA OOM contention on this box.
- Known latency: `qmd vsearch` ≈ 5.4s/call on CPU (model load dominates) — Phase 0 decision gate (accept vs. `qmd mcp --http` daemon).

## Data contracts

Cross-phase shapes (Chunk, Hit, QmdBackend, meta.json, serialization format) are pinned in the implementation plan **§0c** — the only shapes that cross phase boundaries. Everything internal to one module is defined by that phase's red tests; TDD *is* the design step. Token estimation: chars/4 (same as pi-vcc `report.ts`); parsing: `JSON.parse` — no new deps either way.

## Hard constraints

- No new npm runtime deps (builtins + qmd only). If a phase tempts a new package (tokenizers, JSON parsers) — stop, that's the smell.
- Red-first TDD; whole suite green per phase.
- sessionId flows into paths and shell args — sanitize in `paths.ts`, always argv arrays, never `sh -c` strings.
- `QMD_FORCE_CPU=1` default (GPU contention hazard).
- Semantic indexing is fire-and-forget — never awaited on the turn path, failures logged, never thrown.



