# Phase 7a validation evidence

- Date: 2026-09-10T23:56:07.256Z
- Model: homelab-vllm/qwen38
- Session: 01a08dbb-c5dc-7128-b7c6-e218f509728b
- Session file: /tmp/p7a-UN0BJ3/agent/sessions/--tmp-p7a-UN0BJ3-work--/2026-09-10T23-51-28-476Z_01a08dbb-c5dc-7128-b7c6-e218f509728b.jsonl
- Vector dir: /home/piotrek/.pi/vector/01a08dbb-c5dc-7128-b7c6-e218f509728b
- Threshold: 11000 tokens (pi-vcc globalThreshold.compactAtTokens)
- Planted fact: The backup passphrase for the staging database replica (host amber-otter) is rotated by the night-shift ops team every Tuesday at 03:15 UTC.
- Paraphrase query: which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time

## Results

- [x] **1. extension loaded; semantic_recall + vcc_recall registered** — tools: read, bash, edit, write, vcc_recall, semantic_recall
- [x] **2. compaction instant (no LLM), summary sections present** — duration 10ms; sections [Session Goal, Outstanding Context, Earlier Turns]; trimmed span keeps fact OUT of live context: true
- [x] **3. vector dir populated; daemon healthy; indexer.log clean** — files: 0001.md, 0002.md, 0003.md, 0004.md, 0005.md, 0006.md, 0007.md, 0008.md, meta.json; indexer.log: (no indexer.log — clean)
- [x] **5. value proof: vcc_recall (keyword) misses / ranks lower on the paraphrase** — vcc_recall fact tokens found: 0/3
- [x] **4. paraphrased query → semantic_recall hit on the trimmed-only fact** — query="which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time"; fact tokens found: [amber-otter, 03:15, Tuesday]
- [x] **6. assistant spontaneously calls semantic_recall and answers correctly** — fact out of live context pre-check: true; semantic_recall calls in item-6 turn: 1; answer mentions 03:15+Tuesday: true

## Compaction summary (first 60 lines)

```
This summary captures work done before the most recent messages in this session. Read it to pick up context — this is
work already in progress. Do not recap what was done, do not ask what to do next. Continue directly where you left off.
Use `vcc_recall` to search for prior work, decisions, and context from before this summary.

[Session Goal]
- Project context dump (do not analyze, just acknowledge):
- Note 0001: The billing service retries failed webhooks with exponential backoff (base 2s, cap 5m, 8 attempts) (owner:
  team-a, since 2024).
- Note 0002: The search service caches query facets for 60s in a local LRU (256 entries, per-tenant keys) (owner:
  team-b, since 2024).
- Note 0003: The auth service rotates session signing keys every 12h and validates clock skew under 90s (owner: team-c,
  since 2024).
- Note 0004: The ingest service batches sensor rows into 5k-line files before uploading to object storage (owner:
  team-d, since 2024).
- Note 0005: The reports service renders PDF invoices with a 2-page limit and falls back to CSV on overflow (owner:
  team-e, since 2024).

[Outstanding Context]
- [WARN] [user] Note 0001: The billing service retries failed webhooks with exponential backoff (base 2s, cap 5m, 8
  attempts) (owner: team-a, since 2024).

[Earlier Turns]
- Project context dump (do not analyze, just

---

[user]
Project context dump (do not analyze, just acknowledge): Note 0001: The billing service retries failed webhooks with
exponential backoff (base 2s, cap 5m, 8 attempts) (owner: team-a, since 2024). Note 0002: The search service caches
query facets for 60s in a local LRU (256 entries, per-tenant keys) (owner: team-b, since 2024). Note 0003: The auth
service rotates session signing keys every 12h and validates clock skew under 90s (owner: team-c, since 2024). Note
0004: The ingest service batches sensor rows into 5k-line files before uploading to object storage (owner: team-d, since
2024). Note 0005: The reports service renders PDF invoices with a 2-page limit and falls back to CSV on overflow (owner:
team-e, since 2024). Note 0006: The gateway service sheds load by dropping /metrics scrapers first when p99 exceeds
800ms (owner: team-f, since 2024). Note 0007: The mobile service syncs offline edits with last-write-wins and a 30-day
conflict window (owner: team-a, since 2024). Note 0008: The etl service dedupes events by (source_id, occurred_at)
keeping the highest revision (owner: team-b, since 2024). Note 0009: The scheduler service uses a 24-bucket cron with
jitter up to 30s to avoid thundering herds (owner: team-c, since 2024). Note 0010: The audit service hash-chains log
entries with SHA-256 and writes a daily root to the vault (owner: team-d, since 2024). Note 0011: The cdn service purges
by tag on publish and keeps stale-while-revalidate for 120s (owner: team-e, since 2024). Note 0012: The webhooks service
signs payloads with HMAC-SHA256 and requires a 300s timestamp window (owner: team-f, since 2024). Note 0013: The
search-api service highlights matched terms with <mark> and caps snippets at 160 chars (owner: team-a, since 2024). Note
0014: The billing-api service...(truncated)

[assistant]
OK (#1)
```

## Item 4 — semantic_recall result

```
# 5 hit(s) for "which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time"

## [1] turn 1, 2026-09-10T23:51:30.984Z (score 1.00)
[user] Note 0258: The rate-limit service applies token buckets per API key (100 rps burst 200) and returns Retry-After (owner: team-f, since 2024).
[user] Note 0259: The feature-flags service evaluates flags server-side with per-cohort overrides and a 5s TTL (owner: team-a, since 2024).
[user] Note 0260: The backups service takes incremental snapshots every 6h and verifies restore monthly (owner: team-b, since 2024).
[user] Reply with exactly: OK

## [2] turn 1, 2026-09-10T23:51:30.984Z (score 0.50)
[user] Note 0043: The auth service rotates session signing keys every 12h and validates clock skew under 90s (owner: team-a, since 2024).
[user] Note 0044: The ingest service batches sensor rows into 5k-line files before uploading to object storage (owner: team-b, since 2024).
[user] Note 0045: The reports service renders PDF invoices with a 2-page limit and falls back to CSV on overflow (owner: team-c, since 2024).
[user] Note 0046: The gateway service sheds load by dropping /metrics scrapers first when p99 exceeds 800ms (owner: team-d, since 2024).
[user] Note 0047: The mobile service syncs offline edits with last-write-wins and a 30-day conflict window (owner: team-e, since 2024).
[user] Note 0048: The etl service dedupes events by (source_id, occurred_at) keeping the highest revision (owner: team-f, since 2024).
[user] Note 0049: The scheduler service uses a 24-bucket cron with jitter up to 30s to avoid thundering herds (owner: team-a, since 2024).
[user] Note 0050: The audit service hash-chains log entries with SHA-256 and writes a daily root to the vault (owner: team-b, since 2024).
[user] Note 0051: The cdn service purges by tag on publish and keeps stale-while-revalidate for 120s (owner: team-c, since 2024).
[user] Note 0052: The webhooks service signs payloads with HMAC-SHA256 and requires a 300s timestamp window (owner: team-d, since 2024).
[user] Note 0053: The search-api service highlights matched terms with <mark> and caps snippets at 160 chars (owner: team-e, since 2024).
[user] Note 0054: The billing-api service prorates plan changes on the hour and refunds unused days as credit (owner: team-f, since 2024).
[user] Note 0055: The notifications service coalesces email digests per user per 15m and suppresses on mute (owner: team-a, since 2024).
[user] Note 0056: The storage service tiers objects hot/warm/cold at 30/90 days with per-bucket overrides (owner: team-b, since 2024).
[user] Note 0057: The telemetry service samples traces at 10% but keeps 100% for requests over 1s latency (owner: team-c, since 2024).
[user] Note 0058: The rate-limit service applies token buckets per API key (100 rps burst 200) and returns Retry-After (owner: team-d, since 2024).
[user] Note 0059: The feature-flags service evaluates flags server-side with per-cohort overrides and a 5s TTL (owner: team-e, since 2024).
[user] Note 0060: The backups service takes incremental snapshots every 6h and verifies restore monthly (owner: team-f, since 2024).
[user] Note 0061: The billing service retries failed webhooks with exponential backoff (base 2s, cap 5m, 8 attempts) (owner: team-a, since 2024).
[user] Note 0062: The search service caches query facets for 60s in a local LRU (256 entries, per-tenant keys) (owner: team-b, since 2024).
[user] Note 0063: The auth service rotates session signing keys every 12h and validates clock skew under 90s (owner: team-c, since 2024).
[user] Note 0064: The ingest service batches sensor rows into 5k-line files before uploading to object storage (owner: team-d, since 2024).
[user] Note 0065: The reports service renders PDF invoices with a 2-page limit and falls back to CSV on overflow (owner: team-e, since 2024).
[user] Note 0066: The gateway service sheds load by dropping /metrics scrapers first when p99 exceeds 800ms (owner: team-f, 
```

## Item 5 — vcc_recall result

```
3 matches for "which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time": — 3 matches across 2 segments

--- #0 ---
> #0 [user] ...(2 lines above)
Note 0001: The billing service retries failed webhooks with exponential backoff (base 2s, cap 5m, 8 attempts) (owner: team-a, since 2024).
Note 0002: The search service caches query facets for 60s in a local LRU (256 entries, per-tenant keys) (owner: team-b, since 2024).
Note 0003: The auth service rotates session signing keys every 12h and validates clock skew under 90s (owner: team-c, since 2024).
Note 0004: The ingest service batches sensor rows into 5k-line files before uploading to object storage (owner: team-d, since 2024).
Note 0005: The reports service renders PDF invoices with a 2-page limit and falls back to CSV on overflow (owner: team-e, since 2024).
...(257 lines below)

--- #2-#5 ---
> #2 [user] ...(2 lines above)
Note 0001: The billing service retries failed webhooks with exponential backoff (base 2s, cap 5m, 8 attempts) (owner: team-a, since 2024).
Note 0002: The search service caches query facets for 60s in a local LRU (256 entries, per-tenant keys) (owner: team-b, since 2024).
Note 0003: The auth service rotates session signing keys every 12h and validates clock skew under 90s (owner: team-c, since 2024).
Note 0004: The ingest service batches sensor rows into 5k-line files before uploading to object storage (owner: team-d, since 2024).
Note 0005: The reports service renders PDF invoices with a 2-page limit and falls back to CSV on overflow (owner: team-e, since 2024).
...(157 lines below)
> #5 [assistant] which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time
The user is asking to call vcc_recall with a specific query. Let me do that, and then quote the results verbatim.

...(1 lines below)
```

## Item 6 — final assistant answer

```


Found it — Note 0091 in the project context dump:

> The backup passphrase for the staging database replica (host **amber-otter**) is rotated by the **night-shift ops team** every **Tuesday at 03:15 UTC**.

So:
- **Day:** Tuesday (night shift)
- **Time:** 03:15 UTC
- **Team:** night-shift ops team

One caveat worth flagging: the currently visible context dump shows Note 0091 as a generic CDN note, but the original message in session history (and the compacted index) contains the staging-replica passphrase note above — the filler notes appear to have been renumbered, so the archived entry is the authoritative one.
```

## Run log

```
[23:51:28] PASS — 1. extension loaded; semantic_recall + vcc_recall registered — tools: read, bash, edit, write, vcc_recall, semantic_recall
[23:51:28] session 01a08dbb-c5dc-7128-b7c6-e218f509728b → vector dir /home/piotrek/.pi/vector/01a08dbb-c5dc-7128-b7c6-e218f509728b
[23:51:28] prompt 1: planted fact + filler (~7k tokens)
[23:51:40] prompt 2: filler (~5k tokens) — should cross the threshold
[23:51:51] PASS — 2. compaction instant (no LLM), summary sections present — duration 10ms; sections [Session Goal, Outstanding Context, Earlier Turns]; trimmed span keeps fact OUT of live context: true
[23:51:51] waiting for vector dir population (embed ~0.2s/chunk)
[23:51:52] daemon: 0 hits yet (indexing or model load), retrying in 5s
[23:51:57] daemon: 0 hits yet (indexing or model load), retrying in 5s
[23:52:02] PASS — 3. vector dir populated; daemon healthy; indexer.log clean — files: 0001.md, 0002.md, 0003.md, 0004.md, 0005.md, 0006.md, 0007.md, 0008.md, meta.json; indexer.log: (no indexer.log — clean)
[23:52:02] item 5: same query via vcc_recall (value proof first)
[23:52:23] PASS — 5. value proof: vcc_recall (keyword) misses / ranks lower on the paraphrase — vcc_recall fact tokens found: 0/3
[23:52:23] item 4: semantic_recall with paraphrase
[23:54:18] PASS — 4. paraphrased query → semantic_recall hit on the trimmed-only fact — query="which night of the week does the ops crew refresh the credentials for the secondary test database, and at what time"; fact tokens found: [amber-otter, 03:15, Tuesday]
[23:54:18] prompt 3: filler — trims the semantic-hit turn on compaction
[23:54:41] compactions in file: 3
[23:54:41] item 6: question requiring the forgotten fact
[23:56:07] PASS — 6. assistant spontaneously calls semantic_recall and answers correctly — fact out of live context pre-check: true; semantic_recall calls in item-6 turn: 1; answer mentions 03:15+Tuesday: true
```
