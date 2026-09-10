# Hybrid Recall — Implementation Plan (TDD)

Implementation plan for `hybrid-recall-spec.md`: deterministic VCC compaction (forked,
proven) + **background qmd semantic indexing** + a `semantic_recall` tool the assistant
knows about and uses.

**Decisions (confirmed):**
- **Option A** — fork `monotykamary/pi-vcc`, single owner of `session_before_compact`.
- The semantic layer is built as a **self-contained module** (`src/semantic/`) with no
  imports from pi-vcc internals except the trimmed-span hand-off — so it can be ported to
  Option B (companion extension) if the fork fights us.

---

## 0. Environment audit (verified 2026-07-10)

| Item | Status |
|---|---|
| qmd | ✅ installed, **v2.8.3** (`~/.nvm/.../bin/qmd`) |
| Embedding model | ✅ `hf_ggml-org_embeddinggemma-300M-Q8_0.gguf` cached in `~/.cache/qmd/models/` |
| Query-expansion model (for `query` mode) | ✅ `hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf` cached |
| pi-vcc reference source | ✅ `/tmp/pvv` (full checkout, 30+ test files) — **`@sting8k/pi-vcc` 0.7.2, NOT the monotykamary fork**; note: has `tests/` but no devDeps/scripts/tsconfig |
| pi-vcc published pkg | `/tmp/pi-vcc/package` (0.4.1, buihongduc132 line, 7 sections, no Type Catalog/Anchors) |
| Base fork to clone | ⬜ `monotykamary/pi-vcc` (8 sections: + Type Catalog, Anchors, Earlier Turns) — **Phase 0** |
| Node / npm | v24.13.0 / 11.6.2 |

### qmd CLI contract (verified against v2.8.3 help — differs slightly from spec §6)

- Per-session isolation: **global flag `qmd --index <name>`** (named sqlite index, default
  `index` → likely `~/.cache/qmd/index-<name>.sqlite`). This matches the spec's
  `--index <sessionId>` intent.
- Collection: `qmd --index <id> collection add <name> <dir>` registers the chunk dir.
- Index: `qmd --index <id> embed -c <name>` (embedding work, separate process).
- Search: `qmd --index <id> vsearch "<q>" -c <name> -n <k> --format json` (also `search`
  = BM25, `query` = hybrid+rerank).
- Cleanup: `qmd --index <id> collection remove <name>` + delete `~/.pi/vector/<id>/` +
  delete the named index file.

### ⚠️ Known hazard: GPU contention

A probe `qmd vsearch "test"` produced **CUDA out-of-memory** (another process held the
GPU). Mitigation, baked into the design:
- All qmd subprocess calls run with **`QMD_FORCE_CPU=1`** (or `--no-gpu`) by default;
  config knob `semantic.gpu: "auto" | "cpu" | "force"` lets the user opt in to GPU.
- CPU embedding of a 300M Q8 model for ~1500-token chunks is well within "background,
  never blocks" budget (order of tens of ms per chunk); verify in Phase 0 probe.

---

## 0b. Tools & dependencies

### Host tools (all present on this machine; install recipe for a fresh env)

| Tool | Version here | Install | Needed for |
|---|---|---|---|
| Node.js | v24.13.0 | nvm/fnm | everything |
| npm | 11.6.2 | with Node | deps, test runner |
| git | system | system | fork/clone/push |
| **qmd** (`@tobilu/qmd`) | 2.8.3 | `npm i -g @tobilu/qmd` | embeddings + vector search backend |
| qmd embedding model | `embeddinggemma-300M-Q8_0` | `qmd pull` (auto on first embed) | `vsearch`/`search` modes |
| qmd expansion model (optional) | `qmd-query-expansion-1.7B-q4_k_m` | `qmd pull` | only `query` (hybrid+rerank) mode |
| **pi** (`@earendil-works/pi-coding-agent`) | 0.85.1 | `npm i -g @earendil-works/pi-coding-agent` | host runtime; extension loads into it |
| gh CLI (optional) | — | system | GitHub fork/PR workflow |

### npm dependencies

| Dep | Type | From | Notes |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | peer | pi-vcc | installed: 0.85.1 ✓ (older 0.4.1 line used the stale `@mariozechner/…` name; the 0.7.2 sting8k line already uses `@earendil-works/…` — Phase 0 confirms the monotykamary fork matches). Do not add a second copy. |
| `typebox` | peer | pi-vcc | tool input schemas (older line: `@sinclair/typebox`) |
| **new runtime deps** | — | — | **none** (spec §10): only `child_process`, `fs/promises`, `path`, `os` builtins |

### Dev-only requirements (test/build tooling)

| Item | Version | Notes |
|---|---|---|
| **vitest** | ^4.1.8 | test framework (inherited from pi-vcc); plain unit tests, no custom harness |
| **typescript** | ^6.0.3 | `tsc --noEmit` typecheck only — pi loads extensions as raw TS (jiti), **no build/emit step** |
| tsconfig | — | needed for `tsc --noEmit`; **may be missing in the fork** (see below) |
| `RUN_QMD=1` env | — | opt-in flag enabling real-qmd integration tests (default: skipped) |

⚠️ **Dev-setup gap (verified on the local 0.7.2 sting8k checkout):** `tests/` exists but
`package.json` has **no devDependencies, no scripts, no tsconfig, no vitest config**.
Phase 0 must verify the monotykamary fork's dev setup and, if absent, bootstrap it:
add `vitest` + `typescript` devDeps, `test`/`typecheck` scripts, a tsconfig, and a
minimal vitest config (test dir, node env). Dev-only — does not violate spec §10.

Other dev-only facts: no Docker, no test database, no GPU (tests force CPU), no
network at test time (models pre-cached; real-qmd tests opt-in).

Rule: if any phase tempts us into adding an npm package (tokenizers! JSON parsers!), stop —
chars/4 estimation and `JSON.parse` are the spec-blessed answers.

### GitHub fork setup (Phase 0, step 0)

Fork source (verified via npm metadata for `@monotykamary/pi-vcc`, latest 0.8.8):
**`https://github.com/monotykamary/pi-vcc`** — NOT the pi.dev package page
(`https://pi.dev/packages/@monotykamary/pi-vcc` is the install/registry page, not the repo).

1. On GitHub: **Fork** `monotykamary/pi-vcc` → own account (e.g. `<me>/pi-vcc`).
2. Rename/fork-as `pi-vcc-semantic` (or keep name; decide at fork time) so the
   semantic layer is visibly our line.
3. Local: `git clone git@github.com:<me>/pi-vcc-semantic.git ~/dev/pi-vcc-semantic`;
   `git remote add upstream git@github.com:monotykamary/pi-vcc.git` (for future
   rebases — the semantic layer is designed to be rebase-friendly, §1).
4. `npm i` → `npm test` green → **first commit: baseline green** (tag `base-v0.x.y`
   matching the upstream version we forked).
5. Branch model: `main` = fork baseline; work on `feat/semantic-layer`; one PR per
   phase (6a/6b and 7a/7b included) so each green gate is reviewable.

## 0c. Data contracts (the ONLY cross-phase shapes — pinned now, everything else stays test-driven)

Deliberately small: these are the shapes that cross phase boundaries (and the qmd
process boundary). Anything internal to one module is defined by that phase's red
tests, not here. No separate design doc — TDD is the design step for the rest.

```ts
// Phase 2 (chunk.ts) — written by Phase 5, embedded by qmd, returned by Phase 4
interface Chunk {
  seq: number;            // 1-based, continues across compactions (meta.json)
  turn: number;           // pi turn index of the chunk's first message
  timestamp: string;      // ISO, first message of chunk
  filesTouched: string[]; // union of file paths from tool calls in chunk, capped at 10
  text: string;           // serialized messages (format below)
  header: string;         // "<!-- pi-semantic session=<id> seq=<n> turn=<t> ts=<iso> files=<a,b,c> -->"
}

// On-disk file: ~/.pi/vector/<sessionId>/NNNN.md  (NNNN = seq, zero-padded 4)
//   = header + "\n\n" + text

// Serialization (message → text) — the recall-quality-critical choice:
//   [user]            <text content>
//   [assistant]       <text content>            (thinking blocks: OMIT — noise for recall)
//   [tool: <name>]    <args: file/path/cmd line only, truncated 200ch>
//   [tool_result:<name>]  <text, truncated 2000ch; isError → prefix "[ERROR] ">
// One line-per-role-prefix keeps qmd's regex chunking sane and makes hits greppable.

// Phase 3 (qmd.ts) — crosses into Phase 4
interface Hit {
  text: string;           // chunk content (or qmd snippet, per Phase-0 JSON schema)
  file: string;           // NNNN.md → seq
  score: number;
  provenance: string;     // "turn <t>, <iso>" parsed from the header
}

interface QmdBackend {  // (as in Phase 3)
  ensureIndex(sessionId: string, dir: string): Promise<void>;
  embed(sessionId: string): Promise<void>;
  search(sessionId: string, query: string, opts?: { limit?: number; mode?: string }): Promise<Hit[]>;
  remove(sessionId: string): Promise<void>;
}

// Phase 5 (indexer.ts)
// meta.json in chunk dir: { "lastSeq": number, "hashes": { "<seq>": "<sha1 of file>" } }

// Phase 4 (semantic_recall tool) — result shape returned to the model:
//   success:  "# 3 hit(s) for \"<query>\"\n\n## [1] turn 42, 2026-07-10T12:00:00Z (score 0.81)\n<chunk text>\n\n## [2] ..."
//   empty:    "No indexed content matched \"<query>\" (index may still be catching up;
//              try vcc_recall for exact terms)."
```

## 1. Target architecture

```
pi-vcc fork (monotykamary base)
├── src/                      # untouched VCC pipeline (compile(), 8 sections, vcc_recall)
├── src/hooks/before-compact.ts   # +3 lines: after VCC compile → semantic.indexSpan(span)
├── src/semantic/             # NEW, self-contained module (no pi-vcc imports)
│   ├── config.ts            # semantic.* settings, defaults, env overrides
│   ├── paths.ts             # ~/.pi/vector/<sessionId>/ layout, named-index names
│   ├── chunk.ts             # messages → ~1500-token chunks + metadata header
│   ├── qmd.ts               # QmdBackend: spawn wrappers (embed/vsearch/cleanup)
│   ├── indexer.ts           # fire-and-forget orchestration (serialize→chunk→write→embed)
│   └── recall.ts            # semantic_recall tool: run vsearch, parse, provenance
├── index.ts                  # +registerTool(semantic_recall), +session_start/shutdown
└── tests/
    ├── semantic/*.test.ts   # unit tests (pure, no qmd needed)
    └── semantic/qmd.integration.test.ts  # real qmd in temp index (skippable)
```

Data flow (unchanged from spec §4): threshold → `session_before_compact` →
foreground `compile()` → CompactionEntry; **same hook, after the summary is built**,
`semantic.indexSpan({ sessionId, messagesToSummarize, turnPrefixMessages })` —
fire-and-forget, errors logged to a debug file, never thrown into the turn path.

---

## 2. Phases (TDD: every phase = red → green → refactor)

**Green gate (applies to Phases 1–6b):** a phase is done only when the **entire** suite
(inherited pi-vcc tests + all new `tests/semantic/` tests) passes via `npm test` — not
just the phase's own tests. Phases are cumulative; no phase may leave the suite red.

### Phase 0 — Base fork + qmd contract probe (explicitly NOT a TDD phase)

1. Fork + clone per **§0b “GitHub fork setup”** (fork `monotykamary/pi-vcc` on
   GitHub → own repo `pi-vcc-semantic` → clone → `npm i`); **run its existing vitest
   suite green** (this is the "proven mechanism" baseline — do not modify `src/` core).
   Also verify: (a) peer-dep/import names resolve against the installed pi
   (`@earendil-works/…` + `typebox` expected; older `@mariozechner/…`/`@sinclair/…`
   names would need fixing), and (b) **dev tooling** — if the fork lacks
   devDependencies/scripts/tsconfig (as the local 0.7.2 checkout does), bootstrap
   vitest + typescript + test/typecheck scripts + tsconfig first, and get the
   existing `tests/` suite running green before any of our code lands.
2. Write a throwaway probe script (`scripts/qmd-probe.sh`) answering, with measured
   timings:
   - `qmd --index probe-<ts>`: where does the sqlite land? Does `collection add` +
     `embed` + `vsearch --format json` work end-to-end on 3 dummy 1500-token files?
   - Exact **JSON schema** of `vsearch --format json` results (fields: path? score?
     chunk text? docid?) → this becomes the fixture for Phase 4 tests.
   - CPU vs GPU timing per chunk (`QMD_FORCE_CPU=1` vs default).
   - Cost of `--index` per session (file size, startup) vs one shared index +
     per-session collection. **Decision point:** if per-session indexes are heavy
     (model reload per process is the main cost either way), keep per-session per spec;
     the `QmdBackend` interface makes this swappable.
   - **⚠️ Recall-latency decision gate (measured 2026-07-10 on the tiny default
     index: `QMD_FORCE_CPU=1 qmd vsearch` = 5.4s wall / 19s CPU, mostly model load).**
     Re-measure with a session-sized index (dozens of chunks). Recall is on the
     assistant's turn path, so decide explicitly:
     1. **Accept ~5s/call** (default plan; `vcc_recall` stays the fast path), or
     2. **`qmd mcp --http --daemon`** — resident process, 300M model loaded ONCE
        (~300MB RAM), searches over HTTP → sub-second. The extension must own
        daemon lifecycle (spawn/health-check/kill in session_start/shutdown).
        Only if (1) measures unacceptable. (A custom resident embedder, e.g.
        node-llama-cpp worker, is rejected: new npm dep + reinvents qmd.)
     GPU mode is not an option (observed CUDA OOM contention on this box).
   - **Daemon ↔ isolation interaction (probe, don't assume):** `--index` is a
     process-level flag, so one daemon likely serves ONE index. If choosing (2),
     the spec's per-session named indexes must become **one shared index +
     per-session collections** (`-c <sessionId>` filter) — cheaper to manage
     anyway, and swappable behind `QmdBackend`. Probe: does `qmd mcp --http`
     accept `--index`? per-request index/collection selection? What's the HTTP
     API surface (endpoint for vsearch-equivalent, JSON shape)?
3. Record findings in `docs/qmd-contract.md` + save the JSON sample as
   `tests/semantic/fixtures/vsearch-sample.json`.

**Exit criteria (gate, not red→green):** probe answers documented; base suite green;
fixture captured. This phase has no tests by design — it de-risks the CLI contract that
Phases 3–4 assert against.

### Phase 1 — `paths.ts` + `config.ts` (pure, trivial TDD)

Unit tests first (`tests/semantic/paths.test.ts`, `config.test.ts`):
- `chunkDir(sessionId)` → `~/.pi/vector/<sessionId>`; rejects/escapes unsafe sessionIds
  (no `/`, no `..`, length cap) — **security: sessionId flows into shell paths**.
- `indexName(sessionId)` → sanitized name valid for `--index`.
- Config: defaults (`enabled:true, chunkTokens:1500, limit:5, mode:"vsearch"`),
  merge of user settings, env override (`PI_SEMANTIC_ENABLED=0`), invalid values →
  defaults + warning, not throw.

### Phase 2 — `chunk.ts` (core pure logic, heavy TDD)

Input: the trimmed span as LLM messages (already `convertToLlm`-ed — do the conversion
at the call site, keep `chunk.ts` pure). Output: `Chunk[] = { seq, turn, timestamp,
filesTouched, text, header }`.

Test cases (`tests/semantic/chunk.test.ts`), written red first:
- empty span → `[]` (no crash, no zero-byte files).
- short span → exactly 1 chunk.
- long span → chunks ≤ `chunkTokens` (estimator: chars/4, same as pi-vcc `report.ts`);
  boundaries on **message boundaries** (never split a message; oversized single message
  → split on paragraph/line, last resort hard-cut with `…[truncated]` marker).
- metadata header format is stable & parseable:
  `<!-- pi-semantic session=<id> seq=<n> turn=<t> ts=<iso> files=<comma,list> -->`
  (files = union of file paths from tool calls in the chunk, capped).
- determinism: same input → byte-identical output (property: run twice, diff).
- token estimator edge cases (0 chars, unicode, very long single line).

### Phase 3 — `qmd.ts` backend (thin spawn wrapper, TDD with fake exec)

Interface:
```ts
interface QmdBackend {
  ensureIndex(sessionId, dir): Promise<void>   // collection add if missing
  embed(sessionId): Promise<void>             // background-able
  search(sessionId, query, opts): Promise<Hit[]>
  remove(sessionId): Promise<void>
}
```
Tests (`tests/semantic/qmd.test.ts`) with an **injected fake exec** (no real qmd):
- `ensureIndex` is idempotent (collection already present → no add; detect via
  `collection list --format json` or exit-code contract from Phase 0).
- args are built exactly per the Phase-0 contract (assert on the argv array — this is
  where spec-vs-reality drift lives).
- `QMD_FORCE_CPU=1` in env unless `gpu: "force"`.
- non-zero exit / timeout / stderr → structured error, never an unhandled rejection.
- one integration test (tagged `qmd-integration`, skipped unless `RUN_QMD=1`): real
  qmd in a temp `--index`, 3 chunks, assert a paraphrased query returns the right chunk.

### Phase 4 — `recall.ts` + `semantic_recall` tool (TDD with fixture JSON)

Parse + shape logic is pure: `parseVsearchJson(raw, {limit}) → Hit[]` using the
Phase-0 fixture. Tests (`tests/semantic/recall.test.ts`):
- fixture → hits with `{ text, file (seq), score, provenance: "turn <t>, <iso>" }`.
- malformed/empty JSON, partial fields, more results than `limit` → robust.
- tool handler: `semantic.enabled=false` → tool not registered (test registration
  gating, not the handler).
- "index not ready yet" (vsearch returns 0 hits or index missing) → returns a
  friendly "index is still catching up / nothing indexed yet" result, **not** an
  error object (spec: conversation never blocked, degraded not broken).
- query sanitization: no shell interpolation (always argv array, never `sh -c` string).

Tool registration (`index.ts`):
- **Session resolution:** the tool input has no sessionId — the extension captures
  the active sessionId from `session_start` (and hook context) into module state;
  the handler resolves it there. Multi-session edge: if several sessions run under
  one pi process, key the state by session and resolve from the tool-call context
  (verify what pi passes to tool handlers in Phase 0/6; fallback = single active
  session, documented limitation).
```
name: "semantic_recall"
input: { query: string, limit?: number }   // default limit = config (5)
promptSnippet: "semantic_recall — vector search over compacted history"
promptGuidelines: "When live context or vcc_recall (keyword) lacks a detail that was
  discussed earlier — especially for conceptual/paraphrased lookups — call
  semantic_recall(query). Exact terms, file paths, commit hashes → vcc_recall."
```

### Phase 5 — `indexer.ts` (orchestration, TDD with fakes)

`indexSpan({ sessionId, messages, backend, fs })` — fire-and-forget:
- writes `NNNN.md` files **only for the new span** (idempotent: skip if a file with
  same seq+hash exists → re-compaction of same span doesn't duplicate).
- sequencing continues across compactions (track last seq in a small `meta.json` in
  the chunk dir).
- calls `backend.ensureIndex` then `backend.embed` **without awaiting on the turn
  path**; a module-level in-flight guard prevents overlapping embeds for one session
  (embed is a no-op if one is running; queue at most 1).
- all failures → append to `~/.pi/vector/<id>/indexer.log`, never throw.

Tests (`tests/semantic/indexer.test.ts`) with fake backend + tmpdir fs:
- happy path: span → N files with headers → ensureIndex + embed called once, in order.
- re-call with same span → no duplicate writes, no second embed (or only if new files).
- embed failure → logged, state stays consistent, next span retries.
- concurrent `indexSpan` calls → single embed in flight.
- **latency contract test:** `indexSpan` returns in <5ms (it must not await embed).

### Phase 6 — Wiring + lifecycle (integration)

#### 6a — Hook wiring + lifecycle tests (~0.5d)

- `before-compact.ts` (forked hook): after VCC summary produced, extract
  `messagesToSummarize` + `turnPrefixMessages` → `convertToLlm` → `indexSpan(...)`.
  3–5 lines; guarded by `semantic.enabled`.
- `session_start`: `ensureIndex` (lazy, cheap).
- `session_shutdown`: `backend.remove(sessionId)` + `rm -rf ~/.pi/vector/<id>/`
  (config `semantic.keepOnShutdown: false` default — vectors are rebuildable per
  spec §9; raw JSONL persists).
- Tests: hook-level test in the existing pi-vcc style (`before-compact-hook.test.ts`
  pattern) asserting `indexSpan` is called with the trimmed span and its failure
  cannot break compaction (mock throw → compaction result unchanged).

#### 6b — Real-shape pipeline test (~0.5d, expect chunker rework)

- **Real-shape pipeline test (closes the fixture-vs-reality gap):** take a real
  session JSONL fixture (reuse pi-vcc's `real-sessions.test.ts` fixtures) →
  `convertToLlm` → chunker → indexer (fake backend) → assert chunks are sane
  (message boundaries respected, tool_call/tool_result/thinking content arrays
  serialized, no empty chunks). This is the first place the chunker sees genuine
  pi message shapes; without it, Phases 2–5 green ≠ pipeline works.
- **Expectation:** this test is the most likely to fail meaningfully — real message
  shapes will probably expose chunker bugs (Phase 2 code, debugged here). Budget the
  rework; it is the point of the split.
- **Honesty note:** Phase 6's green is *mock-level*. That the hook actually fires in
  a live pi session and `semantic_recall` appears in a real assistant's tool list is
  proven only in Phase 7 — that's expected, not a defect.

### Phase 7 — Manual validation (spec §12, scripted checklist)

#### 7a — Validation checklist (~0.5d)

`scripts/manual-validation.md` runbook, items 1–6:
1. Install fork as pi extension; start a session; drive it past the compaction
   threshold (small threshold via pi-vcc config for the test).
2. Assert: compaction instant (no LLM), 8-section summary present in context.
3. Assert: `~/.pi/vector/<sessionId>/` populated; `qmd --index <id> status` healthy;
   indexer.log empty.
4. **The semantic test:** pick a fact *only* in the trimmed span; query
   `semantic_recall` with a **paraphrase** (different words) → hit expected.
5. Same query via `vcc_recall` → demonstrate keyword layer misses / ranks lower
   (this is the value proof).
6. Turn 2: ask the assistant a question requiring the forgotten fact; observe it
   *spontaneously* calling `semantic_recall` (prompt-guideline effectiveness).

**Exit:** items 1–6 checked with evidence. This is the real definition-of-done gate.

#### 7b — Tuning matrix (1–2d, polish — can be deferred)

- chunkTokens 1000/1500/2500 × limit 3/5/10, each on a fresh session past the
  threshold (the slow, manual part — every config needs its own long session +
  embed wait). Record hit@1 in a table; pick defaults; document in README.
- Not a blocker for a usable extension — run after 7a passes, iteratively.

---

## 3. Test strategy summary

| Layer | Tool | Real qmd? | Runs in |
|---|---|---|---|
| Unit (chunk, paths, config, parse, indexer) | vitest | ❌ fakes/fixtures | always, CI-fast |
| Backend integration | vitest + `RUN_QMD=1` | ✅ temp `--index` | local opt-in |
| Hook integration | vitest (pi-vcc patterns) | ❌ | always |
| E2E | manual runbook (Phase 7) | ✅ real session | local |

Rules:
- **Red-first:** write each phase's tests before its implementation (pi-vcc's suite is
  the style reference — plain vitest, no framework).
- No test may hit the real `~/.cache/qmd` default index or the GPU without `RUN_QMD=1`.
- Determinism: chunker and parser are pure; fs/spawn injected.

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| qmd JSON/CLI drift vs spec §6 | Phase 0 probe + argv-assertion tests; `QmdBackend` isolates it |
| GPU OOM (observed!) | `QMD_FORCE_CPU=1` default; `gpu` config knob |
| **Recall latency ~5.4s/call** (measured, CPU, model load dominates) | Phase 0 gate: accept vs `qmd mcp --http --daemon` (resident model, sub-second, +lifecycle complexity) |
| Per-session `--index` overhead | Phase 0 measurement; backend interface allows shared-index+collection switch |
| Fork divergence from upstream monotykamary | semantic layer touches only `before-compact.ts` (few lines) + `index.ts` → rebase-friendly |
| Embedding lag → empty recall | degraded-friendly tool message (Phase 4 test); never blocks |
| sessionId path injection | sanitize in `paths.ts` (Phase 1 tests) |

## 5. Effort estimate

| Phase | Est. |
|---|---|
| 0 — fork setup + qmd probe | 0.5 d |
| 1 — paths/config | 0.5 d |
| 2 — chunker | 1 d |
| 3 — qmd backend | 1 d |
| 4 — semantic_recall tool | 1 d |
| 5 — indexer | 1 d |
| 6a — wiring + lifecycle | 0.5 d |
| 6b — real-shape pipeline test (+ expected chunker rework) | 0.5 d |
| 7a — manual validation checklist | 0.5 d |
| 7b — tuning matrix (deferrable polish) | 1–2 d |
| **Total** | **~7.5–8.5 days** (core done at ~6.5d, through 7a) |

## 6. Definition of done

- Fork's original test suite green **unchanged** + new `tests/semantic/` green.
- Spec §12 items 1–6 all checked off in the runbook with evidence (timings, sample
  outputs, paraphrase-hit example). (Spec item 7 — tuning — is deliberately deferred
  to Phase 7b as post-DoD polish; defaults ship from Phase 7a observations.)
- `README` section: install, config table (§8), how recall works, CPU/GPU note,
  cleanup behavior.
- No new npm dependencies (spec §10) — only `child_process` + fs.
