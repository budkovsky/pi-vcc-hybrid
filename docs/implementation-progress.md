# Implementation Progress

Track for `docs/plan/hybrid-recall-implementation-plan.md`. Mark items `[x]` as they are
completed (with a short note/date where useful). A phase is **done** only when its exit
criteria are met — for Phases 1–6b that includes the full suite green (`npm test`:
inherited pi-vcc tests + all `tests/semantic/` tests).

## Phase 0 — Base fork + qmd contract probe (no TDD)

Fork status (verified 2026-07-10): repo = `budkovsky/pi-vcc-hybrid` (fork of `monotykamary/pi-vcc`),
default branch = `develop` (at `98fd534`, v0.8.8 = latest upstream). Work branches off `develop`.

- [x] Fork `monotykamary/pi-vcc` on GitHub → `budkovsky/pi-vcc-hybrid`, cloned locally
- [x] `upstream` remote — **not needed** (decision 2026-07-10: fork is standalone, no upstream pulls planned)
- [x] `bun install` + full suite green → baseline, tagged `base-v0.8.8` (re-verified 2026-07-10: 391 unit + 27 regression pass, typecheck + knip clean; tag on develop HEAD `2cc5650`)
- [x] Peer-dep/import names verified against installed pi — only `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox` + node builtins; all resolve in node_modules
- [x] Dev tooling already present in fork (vitest 4.1.7, typescript 6.0.3, tsconfig, test/typecheck scripts) — no bootstrap needed
- [x] `scripts/qmd-probe.sh` written + run: collection add → embed → vsearch end-to-end on 3 dummy files (re-runnable)
- [x] `vsearch --format json` schema captured → `tests/semantic/fixtures/vsearch-sample.json`
- [x] CPU timing per chunk measured (`QMD_FORCE_CPU=1`): embed ≈0.2s/chunk; vsearch 1–6s warm / ~24s cold. **GPU not measured** — GPU saturated (15.8/16.3GB) with OOM contention risk; CPU-only is the contract
- [x] Per-session `--index` overhead measured: ~3.3MB fixed + ~5KB/chunk sqlite; startup (no model load) <0.1s
- [x] **Recall-latency decision gate: DAEMON chosen** (user-approved) — `qmd mcp --http --daemon`, ~30ms steady-state vs 1–6s CLI; **`rerank:false` mandatory** (default rerank ≈30s/query on CPU)
- [x] Daemon ↔ index isolation probed: one daemon = one index → **shared index + per-session collections** (`collections` filter in `query`); lifecycle pinned (spawn/health/stop `--index`)
- [x] Findings recorded in `docs/qmd-contract.md`
- [x] Branch `feat/semantic-layer` created (off phase0 HEAD, which is develop + Phase 0 artifacts)

## Phase 1 — `paths.ts` + `config.ts`

- [x] `tests/semantic/paths.test.ts` + `config.test.ts` written red (43 tests)
- [x] `paths.ts`: `chunkDir` / `collectionName` (plan's `indexName` → collection per Phase-0 daemon decision) + `SHARED_INDEX_NAME` constant; sessionId sanitization (no `/`, no `..`, charset `[A-Za-z0-9_-]`, 64-char cap, `"default"` fallback)
- [x] `config.ts`: defaults (`enabled:true, chunkTokens:1500, limit:5, mode:"vsearch", gpu:"cpu", indexName:"pi-semantic", daemonPort:8390, keepOnShutdown:false`), `semantic` key merge from pi-vcc config file, env override (`PI_SEMANTIC_*`), invalid → default + warning, never throws
- [x] Full suite green (2026-09-10: 434 unit + 27 regression; typecheck + knip clean)

## Phase 2 — `chunk.ts`

- [ ] `tests/semantic/chunk.test.ts` written red (empty span, 1-chunk, boundaries, header format, determinism, estimator edges)
- [ ] `chunk.ts`: message-boundary chunking ≤ `chunkTokens` (chars/4), stable parseable header, byte-identical determinism
- [ ] Full suite green

## Phase 3 — `qmd.ts` backend

- [ ] `tests/semantic/qmd.test.ts` written red (fake exec: idempotent ensureIndex, exact argv, `QMD_FORCE_CPU=1`, error handling)
- [ ] `qmd.ts`: `QmdBackend` (ensureIndex / embed / search / remove), argv-array only (no shell string)
- [ ] `qmd.integration.test.ts` (skipped unless `RUN_QMD=1`)
- [ ] Full suite green

## Phase 4 — `recall.ts` + `semantic_recall` tool

- [ ] `tests/semantic/recall.test.ts` written red (fixture parse, malformed/empty JSON, limit, no-hits friendly message, query sanitization, registration gating)
- [ ] `recall.ts`: `parseVsearchJson` → `Hit[]` with provenance
- [ ] Tool registered in `index.ts` (name, input schema, promptSnippet, promptGuidelines), session resolution from `session_start`
- [ ] Full suite green

## Phase 5 — `indexer.ts`

- [ ] `tests/semantic/indexer.test.ts` written red (fake backend + tmpdir: happy path, idempotent re-call, embed failure logged, single embed in flight, <5ms return)
- [ ] `indexer.ts`: fire-and-forget `indexSpan` (write NNNN.md + meta.json → ensureIndex → embed), failures to `indexer.log`, never throw
- [ ] Full suite green

## Phase 6 — Wiring + lifecycle

### 6a — Hook wiring

- [ ] `before-compact.ts`: after VCC summary → `convertToLlm` → `indexSpan(...)` (guarded by `semantic.enabled`)
- [ ] `session_start` / `session_shutdown` lifecycle (ensureIndex / remove + cleanup)
- [ ] Hook-level tests: indexSpan called with trimmed span; failure cannot break compaction
- [ ] Full suite green

### 6b — Real-shape pipeline test

- [ ] Real session JSONL fixture → convertToLlm → chunker → indexer (fake backend) pipeline test
- [ ] Chunker rework from real message shapes (expected) — suite green again

## Phase 7 — Manual validation

### 7a — Validation checklist (definition of done)

- [ ] `scripts/manual-validation.md` runbook created
- [ ] 1. Fork installed as pi extension; session driven past compaction threshold
- [ ] 2. Compaction instant (no LLM), 8-section summary present
- [ ] 3. `~/.pi/vector/<sessionId>/` populated; qmd index healthy; indexer.log empty
- [ ] 4. Paraphrased query on trimmed-only fact → `semantic_recall` hit
- [ ] 5. Same query via `vcc_recall` → keyword layer misses / ranks lower (value proof)
- [ ] 6. Assistant spontaneously calls `semantic_recall` on a follow-up turn
- [ ] Evidence recorded (timings, sample outputs)

### 7b — Tuning matrix (deferrable polish, post-DoD)

- [ ] chunkTokens 1000/1500/2500 × limit 3/5/10 matrix, hit@1 table
- [ ] Defaults finalized + documented in README

## Release / DoD

- [ ] Fork's original suite green unchanged + `tests/semantic/` green
- [ ] Spec §12 items 1–6 checked with evidence
- [ ] README: install, config table, how recall works, CPU/GPU note, cleanup behavior
- [ ] No new npm runtime deps (builtins + qmd only)
