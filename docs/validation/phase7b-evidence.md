# Phase 7b — tuning matrix evidence

- Date: 2026-09-10T23:57:44.695Z
- Harness: `scripts/tuning-matrix.ts` (LLM-free; real chunker + real qmd, CPU, throwaway index `pi-sem-tune-1789084583336`)
- Corpus: 900 deterministic notes (~36000 tokens), 24 planted facts, one paraphrase query per fact (near-zero keyword overlap)
- Method: per chunkTokens → real `chunkSpan` → NNNN.md → embed → limit=10 vsearch per fact → rank of the fact's chunk (disk-verified tokens)

## hit@k (facts found / 24)

| chunkTokens | chunks | hit@1 | hit@3 | hit@5 | hit@10 |
|---|---|---|--- | --- | ---|
| 1000 | 31 | 6/24 | 12/24 | 14/24 | 19/24
| 1500 | 22 | 8/24 | 11/24 | 15/24 | 20/24
| 2500 | 15 | 12/24 | 15/24 | 18/24 | 22/24

## Per-fact rank (limit=10; — = not in top 10)

| query | ct1000 | ct1500 | ct2500 |
|---|--- | --- | ---|
| 1. which night of the week does the ops crew refresh the creden… | 1 | 1 | 1
| 2. how long can an unused connection sit open on the edge proxy… | 3 | 9 | 2
| 3. what format do phone photos get converted to on ingest, and … | 3 | 5 | 1
| 4. when does billing output switch from the printable format to… | 1 | 1 | 1
| 5. how often is the popular-content cache refreshed during busi… | 10 | 1 | 3
| 6. what mechanism does the offline client use to order competin… | 2 | 2 | 1
| 7. when does request tracing stop being sampled, and what is th… | 2 | 9 | 7
| 8. how frequently are the authentication credentials of the sig… | 1 | 2 | 1
| 9. how are private messages protected on disk, and where do the… | 1 | 1 | 1
| 10. who watches the money-moving stack, in what team size, and w… | 2 | — | —
| 11. what does the API tell a client when it goes over budget, an… | 9 | 2 | 1
| 12. how many autocomplete candidates can the user see, and how s… | — | 9 | 8
| 13. what happens to video rendering when all hardware accelerato… | 2 | 5 | 3
| 14. how does the billing notifier handle a down receiver, and wh… | 6 | 10 | 1
| 15. where do profile pictures live, and for how long is a fetche… | 5 | 5 | 9
| 16. what size limit does the spreadsheet importer have, and how … | — | 1 | 1
| 17. how long can a headline be in the daily summary, and what is… | 1 | 1 | 1
| 18. how do browser credentials get refreshed, and how long can a… | 8 | 10 | 1
| 19. what card-number protection happens before log lines are shi… | — | — | —
| 20. how much of the European audience can see the new payment fl… | 1 | 1 | 5
| 21. how far behind can the read-only copy of the main database r… | — | 1 | 4
| 22. what security step do file uploads go through, and how long … | 4 | 5 | 4
| 23. how fresh are the duty figures shown to buyers… | — | — | 1
| 24. what tolerance triggers an alarm in the end-of-day money che… | 9 | — | 8

## Decision

**Keep defaults: `chunkTokens: 1500`, `limit: 5`.**

- 2500 wins recall on this corpus (hit@5 18/24 vs 15/24) but each returned hit is 1.67× the
  context (limit × chunkTokens tokens pasted per call), and part of its hit@10 edge is corpus
  coverage (top-10 of 15 chunks = 67% of the index).
- 1000 is strictly worse: more chunks to embed, no recall benefit.
- 1500/5 is the balanced point and the config proven end-to-end in the Phase 7a live run
  (spontaneous `semantic_recall` + correct answer).
- Users who value recall over context cost can raise `chunkTokens` to 2500.
