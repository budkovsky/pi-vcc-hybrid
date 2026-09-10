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

- [x] `tests/semantic/chunk.test.ts` written red (empty span, 1-chunk, boundaries, header format, determinism, estimator edges) — 36 tests
- [x] `chunk.ts`: message-boundary chunking ≤ `chunkTokens` (chars/4), stable parseable header, byte-identical determinism
- [x] Full suite green (2026-09-10: 470 unit + 27 regression; typecheck + knip clean)

## Phase 3 — `qmd.ts` backend

- [x] `tests/semantic/qmd-cli.test.ts` + `qmd-daemon.test.ts` + `qmd.test.ts` written red (57 unit tests: fake exec + fake fetch; real-spawn paths tested against a fake qmd binary in a tmpdir)
- [x] `qmd-cli.ts`: `QmdError` (structured codes), exact argv builders, `qmdEnv` (`QMD_FORCE_CPU=1` unless `gpu:"force"`), `execQmd` real spawn (streams separate, timeout → `QmdError`)
- [x] `qmd-daemon.ts`: daemon HTTP client — `queryBody` (JSON-RPC, **`rerank:false` mandatory**, 2025 protocol), SSE parse, `checkHealth` (never throws), `queryDaemon` → raw hits
- [x] `qmd.ts`: `QmdBackend` — CLI indexing (ensureIndex / embed / remove, exit-code idempotency) + full daemon lifecycle (ensureDaemon: health→reuse | spawn→poll→warmup-not-awaited; stopDaemon) + `search` (raw hits)
- [x] **Contract amendment (user-approved 2026-09-10):** `search` returns `QmdRawHit[]` (raw daemon entries), not §0c `Hit[]` — Hit shaping (chunk-file read + header → provenance) moves to Phase 4; daemon lifecycle lives in Phase 3, not 6
- [x] `qmd.integration.test.ts` (skipped unless `RUN_QMD=1`): real qmd, throwaway index, 3 chunks, paraphrased query → right chunk top hit, collection isolation — **verified 2026-09-10 (2 pass, 6.6s warm)**
- [x] Full suite green (2026-09-10: 527 unit + 27 regression; typecheck + knip clean)

## Phase 4 — `recall.ts` + `semantic_recall` tool

- [x] `tests/semantic/recall.test.ts` written red (37 tests: seqOf parse incl. Phase-0 fixture forms, malformed header/snippet fallbacks, limit, no-hits friendly message, query sanitization, registration gating, handler session/limit/mode/error paths)
- [x] `recall.ts`: `shapeHits`/`shapeHitsFromDisk` → `Hit[]` with provenance (plan's `parseVsearchJson` renamed — the daemon client already delivers typed `QmdRawHit[]`, so the pure unit is raw-hits → Hits); chunk-file read for full text + `parseHeader` → `"turn <t>, <iso>"`; snippet fallback (line numbers + hunk header stripped) when the file is missing
- [x] `recall-tool.ts` + wired in `index.ts`: `semantic_recall` (name, TypeBox schema `{query, limit?}`, promptSnippet, promptGuidelines), gated by `semantic.enabled`; sessionId resolved per call from `ctx.sessionManager.getSessionId()` (deviation from plan's `session_start` module state — multi-session-safe, no state); zero hits / backend failure → friendly degraded text, never an error object
- [x] Full suite green (2026-09-10: 568 unit + 27 regression; typecheck + knip clean)

## Phase 5 — `indexer.ts`

- [x] `tests/semantic/indexer.test.ts` written red (fake backend + tmpdir: happy path, idempotent re-call, embed failure logged, single embed in flight, <5ms return) — 16 tests
- [x] `indexer.ts`: fire-and-forget `indexSpan` (write NNNN.md + meta.json → ensureIndex → embed), failures to `indexer.log`, never throw
- [x] Full suite green (2026-09-10: 584 unit + 27 regression; typecheck + knip clean)

## Phase 6 — Wiring + lifecycle

### 6a — Hook wiring

- [x] `before-compact.ts`: after VCC summary → `indexTrimmedSpan(...)` (guarded by `semantic.enabled`; `convertToLlm` from the plan doesn't exist in this codebase — the chunker takes pi-native messages directly, so the trimmed span is passed as-is) (2026-09-10)
- [x] `session_start` / `session_shutdown` lifecycle — `session_start` → `ensureDaemon` warmup (deviation from plan's `ensureIndex`, see notes); `session_shutdown` → cleanup **only on `reason === "quit"`** (user decision 2026-09-10: the event also fires on new/resume/fork/reload) (2026-09-10)
- [x] Hook-level tests: indexSpan called with trimmed span; failure cannot break compaction — `tests/semantic/hook-wiring.test.ts` (5) + `tests/semantic/lifecycle.test.ts` (8) (2026-09-10)
- [x] Full suite green (2026-09-10: 597 unit + 27 regression; typecheck + knip clean)

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
