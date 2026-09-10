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

## Phase 1

Done 2026-09-10 on branch `feat/semantic-layer`.

- **`src/semantic/paths.ts`** — `sanitizeSessionId` is the single choke point
  for every sessionId that touches paths/collections/args: trim → collapse
  runs of `[^A-Za-z0-9_-]` to one `_` (dots are not in the safe set, so `..`
  can never survive) → 64-char cap (trailing `_` trimmed) → `"default"`
  fallback. `chunkDir(id, root?)` → `~/.pi/vector/<id>` (root injectable for
  tests); `collectionName(id)` = sanitized id; `SHARED_INDEX_NAME =
  "pi-semantic"`.
- **`src/semantic/config.ts`** — `resolveSemanticConfig({file, env, warn})` is
  pure (all three injectable); `loadSemanticConfig()` wraps it with disk +
  `process.env`. Precedence: env > file > defaults. Invalid value → default +
  warning via injected `warn` (default `console.warn`), **never throws**.
- **Config lives in the `semantic` key of the pi-vcc config file**
  (`PI_VCC_CONFIG_PATH ?? <agentDir>/pi-vcc-config.json`) — one config file
  for the user; the module only uses the public `getAgentDir` peer-dep API,
  no pi-vcc internal imports. Mirrors the `PI_VCC_CONFIG_PATH` test pattern
  already used by the inherited suite.
- **Defaults pinned** (closes Phase-0 open points): shared index
  `pi-semantic`, daemon port **8390**, `gpu: "cpu"` (→ `QMD_FORCE_CPU=1`),
  `mode: "vsearch"` (daemon `vec` query; `"query"` = hybrid+expansion,
  slower), `keepOnShutdown: false` (Phase 6 will consume it).
- **Env overrides:** `PI_SEMANTIC_ENABLED` (0/1/true/false),
  `PI_SEMANTIC_CHUNK_TOKENS`, `PI_SEMANTIC_LIMIT`, `PI_SEMANTIC_MODE`,
  `PI_SEMANTIC_GPU`. (indexName/daemonPort/keepOnShutdown are file-only —
  add env vars only if a later phase needs them.)
- Validation ranges: chunkTokens 100–50000 int, limit 1–100 int, daemonPort
  1–65535 int, indexName sanitized (warn if changed).
- Gate: 434 unit + 27 regression green (baseline was 391+27), typecheck +
  knip clean.

## Phase 2

Done 2026-09-10 on branch `feat/semantic-layer`.

- **Input shape deviation from plan (expected, plan §6b anticipated it):**
  this fork eliminated `convertToLlm()` (see README) — the trimmed span is
  pi-native `Message[]` (user / assistant / toolResult, plus the synthetic
  `bashExecution` role the VCC `normalize()` handles). `chunk.ts` consumes
  that shape directly; no conversion layer.
- **API:** `chunkSpan({ sessionId, messages, chunkTokens, startSeq? }) →
  Chunk[]` (contract §0c), plus exported `estimateTokens`,
  `serializeMessages`, `splitTextToBudget`, `parseHeader`,
  `TRUNCATION_MARKER`. Pure + deterministic; no I/O, no deps beyond
  `paths.sanitizeSessionId`.
- **Packing:** greedy at message boundaries; a chunk's token cost is
  `estimateTokens(lines.join("\n"))` (join newlines counted — a per-line sum
  would undercount by 1 token per join). An item whose lines exceed the
  budget gets its own chunk(s) and is never mixed with other messages.
- **Oversized-message split order:** paragraph (`\n\n`) → line (`\n`) →
  hard cut. Hard cuts: cutLen = budget − marker, marker `…[truncated]` on
  every piece except the last; cut position is surrogate-pair-safe
  (never between the two code units of an astral char). Budgets are in
  code units (chars/4 convention), and the prefix length is reserved so
  `estimateTokens(prefix + piece) ≤ chunkTokens` holds exactly.
- **Serialization:** one line per role prefix; newlines collapse to spaces;
  thinking blocks omitted; tool args line = `path=` / `command=` /
  `query=` / key-list with the *value* truncated to 200ch (not the whole
  line); tool results truncated to 2000ch with `[ERROR] ` prefix on
  isError; a toolCall with empty args still emits `[tool: <name>]` (the
  call itself is a recallable fact).
- **Header:** `<!-- pi-semantic session=<sanitized> seq=<n> turn=<t>
  ts=<iso|unknown> files=<a,b,c> -->`; commas inside file paths are escaped
  as `;` (reversed by `parseHeader`); files capped at 10, first-seen order,
  from `path`/`file_path`/`filePath`/`file` args only (commands are not
  files). `turn` = count of user messages up to the chunk's first message
  (resets per compaction span — `ts` disambiguates across spans). Missing
  timestamp → `"unknown"` (keeps determinism).
- **Gate:** 470 unit + 27 regression green (was 434+27), typecheck +
  knip clean.
- **Style exception (see AGENTS.md golden rules):** chunk.ts is 460 lines
  with two ~93-line functions (`messageParts`, `chunkSpan`) — accepted
  as-is on review 2026-09-10; rules bind new code from Phase 3 on,
  and a Phase 6b rework of the chunker must split it.
- Carried into Phase 5: indexer writes `NNNN.md` = `header + "\n\n" + text`,
  passes `startSeq = meta.lastSeq + 1`; `parseHeader` is the Phase-4
  provenance parser's source (header → turn/ts/files).
