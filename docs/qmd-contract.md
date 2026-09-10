# qmd contract (Phase 0 findings)

Verified **2026-07-10** against **qmd 2.8.3 (facd35e)** on this box (CPU-only,
`QMD_FORCE_CPU=1`), via `scripts/qmd-probe.sh` (re-run anytime: `bash scripts/qmd-probe.sh`).
This is the contract Phases 3–4 assert against. Fixture:
`tests/semantic/fixtures/vsearch-sample.json`.

## Decision (recorded 2026-07-10, user-approved)

**Recall runs through a resident daemon**, not per-call CLI:

- `qmd mcp --http --daemon` on **one shared index** (e.g. `pi-semantic`),
  **per-session collections** named by sanitized sessionId (the spec's per-session
  named indexes are replaced — `--index` is a process-level flag, one daemon serves
  one index; the plan anticipated this swap behind `QmdBackend`).
- **`rerank: false` is mandatory** in every `query` call. Default `rerank: true`
  runs the 1.7B LLM reranker: **~30s per fresh query on this CPU** — unusable on
  the turn path. With `rerank: false`, fresh queries measure **~30ms warm**
  (first query after model load ~1.5s).
- The extension owns daemon lifecycle: spawn (background) → health poll →
  warmup query → serve → `qmd mcp stop --index <name>`.
- Indexing (collection add / embed / remove) still goes through the **CLI** in the
  background (fire-and-forget, never on the turn path).

Why not CLI `vsearch` per call: 1–6s warm, spikes to ~24s (cold page cache),
fresh process + model load every call, ~155 CPU-seconds/call (multithreaded
llama.cpp). Daemon: ~30ms. Why not GPU: box's GPU is saturated
(15.8/16.3GB used at probe time) with observed CUDA OOM contention —
`QMD_FORCE_CPU=1` stays the default. GPU timing therefore **not measured**
(measuring would risk OOM-killing other workloads).

## Index layout & sizes

- Named index lands at `~/.cache/qmd/<name>.sqlite` (+ `-shm`/`-wal` sidecars).
  Default index: `~/.cache/qmd/index.sqlite`.
- Fixed per-index overhead ≈ **3.3MB** sqlite (schema + empty vector tables);
  ≈ **5KB per chunk** (120 chunks → 4.1MB). Per-session indexes would have been
  cheap, but the daemon forces the shared-index design anyway.
- Models: `~/.cache/qmd/models/` (2.2GB on disk: embeddinggemma-300M-Q8_0 +
  1.7B expansion/rerank model).

## CLI contract (background indexing path)

All commands take `--index <name>` (global flag). Measured with `QMD_FORCE_CPU=1`.

| Command | Notes |
|---|---|
| `qmd --index I collection add <path> --name <coll>` | exit **0** success, **1** if collection already exists. Prints "✓ Collection '<coll>' created successfully". |
| `qmd --index I collection remove <coll>` | exit **0** success, **1** if missing. Deletes docs + orphaned hashes. |
| `qmd --index I collection list` | exit **0** always. **Plain text only** — `--format json` is silently ignored. Empty: "No collections found. …". |
| `qmd --index I embed [-c <coll>]` | Prints "✓ Done! Embedded N chunks from M documents in Xs". ≈ **0.2s/chunk** CPU incl. model load (120 chunks → 28s). |
| `qmd --index I vsearch <q> --format json` | JSON array on **stdout**; query-expansion trace on **stderr** (keep streams separate!). exit 0. |

`vsearch --format json` schema (fixture captured):

```json
[
  {
    "docid": "#3711d2",
    "score": 0.45,
    "file": "qmd://probe/doc3.md?index=probe-1789063027",
    "line": 161,
    "title": "doc3",
    "snippet": "@@ -160,3 @@ (159 before, 0 after)\n\nThe backup cron runs at 03:15 UTC.\n"
  }
]
```

- `file` = `qmd://<collection>/<relpath>?index=<indexName>` — parse the collection
  + path out of it (or rely on `title` = basename).
- `snippet` carries a diff-style header line `@@ -<line>,<count> @@ (<n> before,
  <m> after)` then the matched text (may be empty context + the fact line).
- `score` is a 0..1 similarity, not normalized across results.

CLI `vsearch` latency (fresh process per call, CPU): **1–6s warm, up to ~24s
cold** (page-cache dependent); ~155 CPU-seconds/call multithreaded. Not used on
the turn path per the decision above.

## Daemon contract (recall path)

### Lifecycle

| Step | Command / call | Observed |
|---|---|---|
| spawn | `qmd mcp --http --daemon --index I --port P` | Returns immediately. stdout: `Started on http://localhost:P/mcp (PID N)` + `Logs: ~/.cache/qmd/mcp-<I>.log`. Writes PID file `~/.cache/qmd/mcp-<I>.pid`. |
| health | `GET http://localhost:P/health` | `{"status":"ok","uptime":N}` within ~2s of spawn. **Listen is IPv6 `[::1]` — curl `localhost`, not `127.0.0.1`.** |
| stop | `qmd mcp stop --index I` | `Stopped QMD MCP server (PID N)`, removes PID file. **`--index` is required** — bare `qmd mcp stop` looks for the default index's PID file and reports "Not running". |
| one daemon = one index | `--index` is process-level | A second daemon for another index needs another port. |

### MCP API surface

- Endpoint: `POST http://localhost:P/mcp` — sessionless Streamable HTTP, no
  handshake needed with the **2025-era** protocol.
- Required headers: `Content-Type: application/json`,
  `Accept: application/json, text/event-stream` (missing Accept → 406),
  `MCP-Protocol-Version: 2025-03-26`.
- Body: plain JSON-RPC 2.0 (`{"jsonrpc":"2.0","id":N,"method":"tools/call",...}`).
  (The 2026-era `server/discover` path demands a `_meta` envelope — not needed.)
- Response is **SSE**: `event: message\ndata: {jsonrpc result}` — parse the
  `data:` line. Keepalive comments (`: keepalive`) may precede it.
- Tools: `query`, `get`, `multi_get`, `status` (see `tools/list`).

### `query` tool

Input (full schema pinned by `tools/list`):

```jsonc
{
  "searches": [{ "type": "lex|vec|hyde", "query": "…" }],  // or "query": "…" (auto-expand)
  "limit": 5,
  "minScore": 0.0,
  "candidateLimit": 40,
  "collections": ["<sessionId>"],   // OR-match filter — per-session isolation
  "intent": "optional disambiguation context",
  "rerank": false                  // MANDATORY (default true → ~30s/query on CPU)
}
```

Result shape (`result.structuredContent.results[]` — use this, not the
human-facing `result.content[0].text`):

```jsonc
{
  "docid": "#a7eeef",
  "file": "sess/chunk007.md",        // <collection>/<relpath>, no qmd:// prefix
  "title": "chunk007",
  "score": 0.75,                     // 0..1, normalized (top hit = 1)
  "context": null,
  "line": 77,
  "snippet": "77: @@ -76,4 @@ (75 before, 83 after)\n78: \n79: …"  // line-number-prefixed
}
```

Empty result: `structuredContent.results: []` + text "No results found for …".

### Latency (daemon, `rerank:false`, CPU)

| Phase | Measured |
|---|---|
| health after spawn | ~2s |
| model load (one-time, first real vec work) | ~30–67s, page-cache dependent (models 2.2GB on disk) |
| first query after load | ~1.5s |
| **steady-state fresh query** | **~30ms** |
| `rerank:true` fresh query (for the record) | ~30s — rejected |

**Warmup requirement:** after health OK, fire one throwaway `query`
(`searches:[{type:"vec",…}], rerank:false`) in the background and discard the
result, so the one-time model load happens off the turn path. (Observed: the
load can span the first ~2–3 queries — don't gate the session on it.)

### Gotchas observed

- `collection list --format json` is a no-op (text only) — idempotency detection
  for `ensureIndex` must use the **exit codes** above (add→1 = exists,
  remove→1 = missing), not JSON.
- Identical repeated query text returned in 33ms even with `rerank:true`
  (server-side result cache) — do not rely on this; it is not part of the
  contract.
- Daemon logs: `~/.cache/qmd/mcp-<index>.log`; PID file
  `~/.cache/qmd/mcp-<index>.pid`.
- A manually spawned (non-`--daemon`) `qmd mcp --http` has **no PID file** —
  `qmd mcp stop` cannot kill it; always spawn with `--daemon`.
