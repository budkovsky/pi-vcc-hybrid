# Implementation notes

Running notes for the semantic layer. Formal contracts live in
`docs/qmd-contract.md`; the done/not-done checklist lives in
`docs/implementation-progress.md`. This file captures the *why* and the
gotchas that are easy to trip over again.

## Key facts and decisions

- **Recall runs through a resident qmd daemon**, not per-call CLI
  (decision 2026-07-10, user-approved): `qmd mcp --http --daemon` on **one
  shared index** (name: `pi-semantic`), **per-session collections** named by
  sanitized sessionId. Rationale: CLI `vsearch` = 1–6s warm / ~24s cold per
  call (fresh process + model load each time); daemon = ~30ms steady-state.
  Cost: extension owns daemon lifecycle (spawn/health/warmup/stop) + ~1–2GB
  resident RAM.
- **`rerank: false` is mandatory in every daemon `query` call.** Default
  `rerank: true` runs the 1.7B LLM reranker: ~30s per *fresh* query on this
  CPU. (Identical repeated query text is server-cached → 33ms, but that is
  not part of the contract.)
- **CPU-only is the contract** (`QMD_FORCE_CPU=1` default). GPU on this box
  is saturated (15.8/16.3GB at probe time) with observed CUDA OOM
  contention — do not "just try GPU" in tests or probes.
- **Indexing (CLI) and recall (daemon) are separate paths.**
  `collection add` / `embed` / `collection remove` go through the CLI in the
  background (fire-and-forget, never on the turn path). Only `query` goes
  over HTTP. The daemon sees new collections/chunks without restart (shared
  sqlite).
- **One daemon = one index** (`--index` is a process-level flag). Do not
  spawn a daemon per session; spawn one for the shared index, reuse it.
- **Daemon warmup is required and async:** after `/health` is OK, fire one
  throwaway `query` (`vec`, `rerank:false`) and discard the result. The
  one-time model load (~30–67s, page-cache dependent) can span the first
  ~2–3 queries — never gate a turn on it.
- **`QmdBackend` splits in two** (consequence of the daemon decision):
  a CLI backend for indexing (argv arrays, exit-code contracts) and an HTTP
  backend for recall. Phase 3 tests assert on the argv arrays *and* the HTTP
  request bodies.
- **sessionId flows into paths, collection names, and shell/HTTP args** —
  sanitize in `paths.ts` (no `/`, no `..`, length cap), argv arrays only,
  never `sh -c` strings.
- Token estimation: chars/4 (same as pi-vcc `report.ts`). No new npm
  runtime deps (builtins + qmd only).

## Phase 0

Done 2026-07-10 on branch `phase0` → `feat/semantic-layer` (commit
`af96f82`); baseline tagged `base-v0.8.8` at `2cc5650`.

- Baseline: 391 unit + 27 regression green, typecheck + knip clean.
  Imports in the fork are already the modern names
  (`@earendil-works/…` + `typebox`); dev tooling (vitest 4.1.7, tsc,
  tsconfig, scripts) was present — no bootstrap needed.
- Probe: `scripts/qmd-probe.sh` (re-runnable, ~3–4 min). Findings + full
  contracts: `docs/qmd-contract.md`. Fixture:
  `tests/semantic/fixtures/vsearch-sample.json`.
- Measured (CPU, qmd 2.8.3):
  - named index → `~/.cache/qmd/<name>.sqlite`; ~3.3MB fixed + ~5KB/chunk
  - embed ≈ 0.2s/chunk (120 chunks → 28s)
  - CLI `vsearch`: 1–6s warm, ~24s cold, ~155 CPU-seconds/call
  - daemon: health ~2s after spawn; model load ~30–67s one-time;
    first query ~1.5s; **steady-state fresh query ~30ms** (`rerank:false`)
  - daemon `rerank:true` fresh query ~30s (rejected)
- Gotchas that cost time (all pinned in the contract doc):
  - daemon listens on **`[::1]`** — curl `localhost`, not `127.0.0.1`
  - `qmd mcp stop` **requires `--index`** (bare stop looks for the default
    index's PID file and says "Not running")
  - manually spawned (non-`--daemon`) `qmd mcp --http` writes **no PID
    file** — always spawn with `--daemon` or you can't stop it cleanly
  - `collection list --format json` is a **silent no-op** (text only) —
    idempotency must use exit codes: `add`→1 = exists, `remove`→1 = missing
  - `vsearch --format json`: JSON on stdout, expansion trace on **stderr** —
    keep streams separate
  - daemon MCP needs `Accept: application/json, text/event-stream`
    (else 406) and answers in **SSE** (`event: message\ndata: …`) — parse
    the `data:` line; use the 2025-era protocol (`2025-03-26`), the 2026-era
    `server/discover` path wants a `_meta` envelope
  - daemon `query` result: use `result.structuredContent.results[]`
    (`{docid, file: "<coll>/<path>", title, score, line, snippet}` —
    snippet is line-number-prefixed, score normalized with top = 1), not the
    human-facing `content[0].text`
- Open design points carried into later phases:
  - shared index name + daemon port: pick stable defaults
    (`pi-semantic`, port e.g. 8390) — decide in Phase 1 config
  - daemon stop policy: on last `session_shutdown`? or leave resident across
    pi restarts (health-check + reuse)? Decide in Phase 6 lifecycle
  - `paths.ts` must now yield the *collection* name (sanitized sessionId)
    rather than a per-session index dir/name — adjust Phase 1 test names
    accordingly (`chunkDir` stays; `indexName` becomes `collectionName` +
    constant shared index name)
