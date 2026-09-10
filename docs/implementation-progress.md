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
- [ ] `bun install` + full suite green → baseline commit, tagged `base-v0.8.8` (suite verified green 2026-07-10: 391 unit + 27 regression pass, typecheck clean; bun 1.4.2 installed; tag pending)
- [ ] Peer-dep/import names verified against installed pi (`@earendil-works/…` + `typebox`)
- [ ] Dev tooling bootstrapped if missing (vitest + typescript devDeps, test/typecheck scripts, tsconfig)
- [ ] `scripts/qmd-probe.sh` run: collection add → embed → vsearch end-to-end on 3 dummy files
- [ ] `vsearch --format json` schema captured → `tests/semantic/fixtures/vsearch-sample.json`
- [ ] CPU vs GPU timing per chunk measured (`QMD_FORCE_CPU=1`)
- [ ] Per-session `--index` overhead measured (file size, startup)
- [ ] **Recall-latency decision gate:** accept ~5s/call vs. `qmd mcp --http --daemon` (resident) — decision recorded
- [ ] Daemon ↔ index isolation probed (if daemon chosen: shared index + per-session collections)
- [ ] Findings recorded in `docs/qmd-contract.md`
- [ ] Branch `feat/semantic-layer` created

## Phase 1 — `paths.ts` + `config.ts`

- [ ] `tests/semantic/paths.test.ts` + `config.test.ts` written red
- [ ] `paths.ts`: `chunkDir` / `indexName`, sessionId sanitization (no `/`, no `..`, length cap)
- [ ] `config.ts`: defaults (`enabled:true, chunkTokens:1500, limit:5, mode:"vsearch"`), settings merge, env override, invalid → default + warning
- [ ] Full suite green

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
