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

## Phase 3

Done 2026-09-10 on branch `feat/semantic-layer`.

- **Three files** (golden rules: <300 lines each — 124/133/230):
  - `qmd-cli.ts` — `QmdError` (codes: `cli-failed` / `timeout` /
    `daemon-unreachable` / `daemon-error` / `bad-response`); argv builders
    (exact Phase-0 shapes, asserted in tests); `qmdEnv` (`cpu`|`auto` →
    `QMD_FORCE_CPU=1`, `force` → none); `execQmd` real spawn — resolves with
    the exit code (the caller interprets it), rejects only on spawn failure or
    timeout; stdout/stderr kept separate (vsearch contract).
  - `qmd-daemon.ts` — `queryBody` (JSON-RPC `tools/call` `query`; mode
    `vsearch` → `searches:[{type:"vec"}]`, mode `query` → auto-expansion
    `query` field; **`rerank:false` mandatory**; `collections` omitted when
    empty — the warmup query); `checkHealth` (200 + `{status:ok}` → true,
    never throws); `queryDaemon` (SSE `data:` line parse, CRLF + keepalive
    tolerant, plain-JSON fallback; JSON-RPC error → `daemon-error`; missing
    `structuredContent.results` → `bad-response`; network/HTTP/timeout →
    `daemon-unreachable`; non-object / non-numeric-score entries skipped).
  - `qmd.ts` — `QmdBackend`: CLI indexing (`collection add`/`remove`
    idempotent via exit codes — 1 = exists/missing → ok; `embed`: any
    non-zero → error), daemon lifecycle, `search`.
- **Contract amendments (user decisions 2026-09-10, supersede plan §0c):**
  1. `search` returns **`QmdRawHit[]`** (raw daemon entries: docid/file/
     title/score/line/snippet), not `Hit[]`. Hit shaping (read the local
     chunk file → full text + header → provenance) moves to Phase 4
     `recall.ts`. Rationale: keep qmd.ts a pure qmd-interaction module.
  2. **Full daemon lifecycle lives in Phase 3** (`ensureDaemon` /
     `stopDaemon`), not Phase 6 — Phase 6 only decides *when* to start/stop.
- **Daemon lifecycle semantics:** `ensureDaemon` — in-flight guard is set
  *synchronously* (before the health await) so concurrent callers share one
  start; healthy → reuse with **no warmup** (warmup belongs to spawn);
  down → spawn (exact argv) → poll `/health` (`healthPollMs` until
  `healthTimeoutMs`) → fire warmup (throwaway vec query, `rerank:false`,
  **never awaited** — the one-time model load spans the first queries;
  failure → `log`, never thrown). `stopDaemon` exit 1 = not running → ok.
- **Timeouts:** `DEFAULT_TIMEOUT_MS` = 30s (collection ops, spawn/stop,
  search), `EMBED_TIMEOUT_MS` = 600s (≈0.2s/chunk CPU; 3000 chunks). Open
  point for Phase 6: `search` reuses `timeoutMs` as the daemon-query timeout —
  a query spanning the model load can exceed 30s; the wiring may want a
  dedicated (longer) search timeout.
- **Integration (`RUN_QMD=1`):** throwaway index `pi-sem-it-<ts>` on port
  8391, 3 filler+fact chunks; paraphrase "when does the nightly backup run"
  → top hit `itsess/0003.md` ✓ (the 03:15 UTC fact); collection isolation ✓.
  Cleanup best-effort: `stopDaemon` + `collection remove` + rm the index
  sqlite sidecars (no `qmd index remove` in the contract).
- **Gate:** 527 unit + 27 regression green (was 470+27), typecheck + knip
  clean.
- Carried into Phase 4: `QmdRawHit.file` = `"<collection>/<NNNN.md>"` → seq;
  provenance from the chunk-file header (`chunk.ts` `parseHeader`); `[]` →
  friendly "index catching up" message at the tool layer (degraded, not
  broken); backend defaults are neutral (limit 5 / mode vsearch) — config
  values are applied by the Phase-6 wiring.

## Phase 4

Done 2026-09-10 on branch `feat/semantic-layer`.

- **Two files** (golden rules — 160/107 lines):
  - `recall.ts` — pure shaping + formatting. `seqOf` (last path segment,
    strip `?query`, `^0*(\d+)\.md$` → seq; handles both daemon
    `"<coll>/NNNN.md"` and CLI `qmd://…` forms); `provenanceOf` (first line →
    `chunk.ts` `parseHeader` → `"turn <t>, <iso>"`, else `"unknown"`);
    `textOf` (chunk-file body after the header line, else snippet with
    `N: ` line prefixes + `@@ … @@` hunk headers stripped); `shapeHit` /
    `shapeHits` (pure, limit-sliced, daemon rank order preserved) /
    `shapeHitsFromDisk` (one `readFile` per distinct seq, `NNNN.md`
    zero-padded 4, missing → null → snippet fallback); `formatHits` /
    `emptyResult` / `unavailableResult` (pinned plan-§0c strings).
  - `recall-tool.ts` — `registerSemanticRecallTool(pi, {config, backend,
    vectorRoot?, readChunk?, log?})`. Gating: `semantic.enabled=false` →
    no `registerTool` call. Handler: trim query (empty → "query is
    required", backend untouched) → `ctx.sessionManager.getSessionId()` →
    `backend.search(id, q, {limit, mode})` → `shapeHitsFromDisk` →
    `formatHits` | `emptyResult`. `limit` clamped to 1–100, invalid →
    config default. Any thrown error → `log` + `unavailableResult` text —
    the turn is never blocked, no error object.
- **Plan deviations (both simplify the plan's design):**
  1. `parseVsearchJson` → `shapeHits(raw, contentBySeq, limit)`: the
     Phase-3 daemon client already returns typed `QmdRawHit[]` (JSON parse
     lives in `qmd-daemon.ts`), so the Phase-4 pure unit takes raw hits,
     not a JSON string. Malformed/empty-JSON robustness is covered by the
     Phase-3 `queryDaemon` tests + partial-field tests here.
  2. Session resolution: the tool `execute` receives the full
     `ExtensionContext`, so the sessionId comes from
     `ctx.sessionManager.getSessionId()` per call — no `session_start`
     module state, multi-session processes are safe by construction.
- **Query sanitization proof:** test runs a real `QmdBackend` (fake
  exec/fetch) with a shell-metachar query and asserts (a) the query arrives
  as a literal string in the JSON-RPC `arguments.searches[0].query` and
  (b) **zero** CLI/exec calls — recall never touches a shell.
- **`index.ts` wiring:** `loadSemanticConfig()` at extension load →
  `new QmdBackend({indexName, daemonPort, gpu})` (lazy — no I/O until first
  search/ensureDaemon) → `registerSemanticRecallTool`. Config is read once
  per pi process (restart to change — same as the rest of the extension).
- **Gate:** 568 unit + 27 regression green (was 531+27; +37 new),
  typecheck + knip clean. (Progress doc had recorded Phase 3 as 527 — the
  measured baseline at the Phase-3 HEAD is 531; delta is exactly the new
  file.)
- Carried into Phase 5/6: `shapeHitsFromDisk` reads `NNNN.md` exactly as
  the indexer will write it (`header + "\n\n" + text`); the tool's
  `readChunk`/`vectorRoot` injection points are what the Phase-6 wiring
  leaves at defaults. Phase 6 still owns: daemon start/stop timing
  (`session_start`/`session_shutdown`), the `keepOnShutdown` cleanup, and
  the open search-timeout question from Phase 3 (model-load-spanning query
  vs. 30s `timeoutMs`).

## Phase 5

Done 2026-09-10 on branch `feat/semantic-layer`.

- **`src/semantic/indexer.ts`** (200 lines) — `indexSpan({sessionId,
  messages, backend, chunkTokens?, vectorRoot?, log?})` returns
  **synchronously** (latency contract: <5ms, never awaits embed); all work
  runs in a per-session background pipeline:
  1. **prepare** (serialized per session via a promise chain, so the
     meta.json read-modify-write is race-free): read meta → `chunkSpan`
     (`startSeq = lastSeq + 1`) → write `NNNN.md` for new chunks → update
     meta.json. Sync fs in a microtask — fine at span sizes (few MB).
  2. **embed** (coalesced, *not* serialized): `ensureIndex` → `embed`;
     in-flight guard + pending flag (at most 1 queued). The follow-up
     embed covers files written during the in-flight one. Files are always
     written regardless of embed state.
- **Idempotency key = sha1 of the chunk `text`, not the file** (deviation
  from plan §0c's "sha1 of file"): the header embeds the seq, and seq
  continues across compactions, so a re-compacted span would get new seqs
  and file hashes would never collide. Text-hash dedup across *all* seqs
  means re-compaction of the same span writes nothing and triggers no
  embed. `meta.json` = `{ lastSeq, hashes: { "<seq>": sha1(text) } }`.
- **Failure semantics:** any stage failure (prepare / ensureIndex / embed)
  → line appended to `<chunkDir>/indexer.log` + injected `log` sink
  (default `console.error`); state stays consistent (files + meta already
  written before embed); the next span retries. `indexSpan` never throws,
  never rejects (the chain is poison-proof via `.catch` at each link).
- **`IndexerBackend`** is a minimal structural interface
  (`ensureIndex`/`embed`) — `QmdBackend` satisfies it; tests use fakes.
  `vectorRoot` injection mirrors `paths.chunkDir`/Phase-4 `recall-tool`
  (no full `fs` injection — tmpdir is enough, consistent with Phases 1/4).
- **Gate:** 584 unit + 27 regression green (was 568+27; +16 new),
  typecheck + knip clean.
- Carried into Phase 6: wiring calls `indexSpan` from `before-compact.ts`
  after the VCC summary with `chunkTokens` from config + the shared
  `QmdBackend`; `indexSpan`'s `log` should go to the same sink the rest
  of the extension uses. Module-level session state is keyed by
  *sanitized* sessionId — multi-session safe, but unbounded (one small
  state object per session per pi process; acceptable, noted for the
  Phase-6 `session_shutdown` cleanup to also drop the state entry).

## Phase 6a

Done 2026-09-10 on branch `feat/semantic-layer`.

- **Wiring shape:** the inherited `before-compact.ts` gets exactly one
  semantic import (`hook-bridge`) and one call site — after
  `compile(compileInput)`, before the `return`:
  `indexTrimmedSpan(opts?.semantic, sessionId, agentMessages)`.
  `registerBeforeCompactHook(pi)` gains an *optional* second arg
  `{ semantic?: SemanticHookOptions }` — back-compatible (all inherited
  tests call it with one arg and stay green unchanged).
- **`src/semantic/hook-bridge.ts`** (50 lines) — `indexTrimmedSpan(opts,
  sessionId, messages)`: the only bridge from VCC hook → indexer. Total
  function: no opts / `enabled=false` → no-op; wraps `indexSpan` in
  try/catch (indexSpan is non-throwing by contract; the guard covers
  unexpected sync errors) — compaction can never break because of the
  vector index.
- **`src/semantic/lifecycle.ts`** (95 lines) — `registerSemanticLifecycle(pi,
  {config, backend, vectorRoot?, log?})`:
  - `session_start` → `backend.ensureDaemon()` fire-and-forget (rejection
    logged, never thrown).
  - `session_shutdown` → cleanup **only when `reason === "quit"`**.
    `keepOnShutdown=false` → `backend.remove(sessionId)` + `rm -rf` the
    chunk dir; then `dropSessionState(sessionId)`; then `stopDaemon()`
    (always on quit — the daemon is a detached child, stopping it so
    quitting pi doesn't leak the process). `keepOnShutdown=true` skips
    *both* remove and rm (collection + dir kept together).
- **Plan deviations (all deliberate, recorded):**
  1. **Cleanup only on `quit`** (user decision 2026-09-10). The plan says
     "on `session_shutdown`", but pi fires that event on session
     replacement too (`reason: "new" | "resume" | "fork"`) and on reload —
     literal cleanup would destroy the vectors of *resumable* sessions
     (vectors only rebuild on the next compaction, which may never come).
     Quit-only preserves resumable-session vectors; quit still applies the
     spec §9 "vectors don't persist across restarts" default.
  2. **`session_start` → `ensureDaemon`, not `ensureIndex`** (plan text).
     At session start the chunk dir doesn't exist yet (first compaction
     creates it), so `qmd collection add` would fail; `ensureIndex` already
     runs per-span in the indexer. `ensureDaemon` warms the one-time model
     load (~30–67s cold) off the turn path, before the first
     compaction/recall needs it — matches the Phase-4 "daemon start/stop
     timing" carry-over.
  3. **`convertToLlm` doesn't exist** in this codebase (plan §6a wording).
     The chunker (`chunk.ts`) takes pi-native messages directly, so the
     trimmed span (`agentMessages`) is passed as-is to `indexSpan`.
- **`indexer.ts`** gains one export: `dropSessionState(sessionId)` — drops
  the per-session state entry (in-flight guard + promise chain) so it
  doesn't outlive the session. Called by the lifecycle on quit.
- **`index.ts`** now builds one shared `QmdBackend` and passes it to all
  three consumers (recall tool, compaction-hook indexer, lifecycle).
  `registerBeforeCompactHook` is called with the semantic opts.
- **Tests:** `tests/semantic/hook-wiring.test.ts` (5) +
  `tests/semantic/lifecycle.test.ts` (8) — mock-pi pattern inherited from
  `tests/before-compact-hook.test.ts`. Hook tests assert the *trimmed* span
  (not the kept tail) is what lands in `NNNN.md`, and that a throwing
  backend leaves the compaction result intact. Lifecycle tests cover
  quit-only cleanup, keepOnShutdown, remove-failure isolation, and the
  missing-`getSessionId` fallback.
- **Gate:** 597 unit + 27 regression green (was 584+27; +13 new),
  typecheck + knip clean.
- Carried into Phase 6b: real-shape pipeline test (chunker's first look at
  genuine pi message shapes — the expected rework point). The open
  search-timeout question from Phase 3 (model-load-spanning query vs. 30s
  `timeoutMs`) remains open — recall's `search` uses `DEFAULT_TIMEOUT_MS`.
