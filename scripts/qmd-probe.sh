#!/usr/bin/env bash
# Phase 0 — qmd contract probe (throwaway, measurement + contract verification).
#
# Answers, with measured timings:
#   A. where a named --index sqlite lands
#   B. collection add → embed → vsearch --format json end-to-end (3 dummy ~1500-token files)
#   C. vsearch JSON schema (→ tests/semantic/fixtures/vsearch-sample.json)
#   D. CPU timing per chunk (embed) and per call (vsearch); variance across calls
#   E. per-session --index overhead (file size, startup)
#   F. session-sized index (40 docs / ~120 chunks): embed + vsearch timings
#   G. daemon mode: spawn/health/warmup/search/stop lifecycle + warm latency
#
# Usage: bun run scripts/qmd-probe.sh   (or bash scripts/qmd-probe.sh)
# Requires: qmd on PATH, embedding models cached. Forces CPU (QMD_FORCE_CPU=1).
set -uo pipefail

export QMD_FORCE_CPU=1
QMD_BIN="${QMD_BIN:-qmd}"
WORK="$(mktemp -d /tmp/qmd-probe-XXXXXX)"
TS="$(date +%s)"
IDX="probe-$TS"
PORT="${PROBE_PORT:-8321}"
ACC='Accept: application/json, text/event-stream'
trap 'rm -rf "$WORK"' EXIT

now() { date +%s.%N; }
elapsed() { echo "$(echo "$1 $2" | awk '{printf "%.2f", $2 - $1}')s"; }

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# --- dummy corpus: 3 files, ~1500 tokens (~6KB) each, one unique fact per file ---
mkdir -p "$WORK/docs"
for i in 1 2 3; do
  python3 - "$WORK/docs/doc$i.md" "$i" <<'EOF'
import random, sys
path, seed = sys.argv[1], int(sys.argv[2])
random.seed(seed)
words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split()
text = '\n\n'.join(' '.join(random.choices(words, k=12)) for _ in range(80))
facts = {
    1: 'The secret password for the vault is blue zebra 42.',
    2: 'The deployment target is the osaka region.',
    3: 'The backup cron runs at 03:15 UTC.',
}
open(path, 'w').write(text + '\n\n' + facts[seed] + '\n')
EOF
done

say "A. named index location"
ls ~/.cache/qmd/ | grep "^$IDX" || true   # (none yet — created by next call)
"$QMD_BIN" --index "$IDX" collection list >/dev/null 2>&1
ls -la ~/.cache/qmd/"$IDX".sqlite 2>/dev/null || echo "no sqlite at ~/.cache/qmd/$IDX.sqlite"

say "B. end-to-end: collection add → embed → vsearch"
t=$(now); "$QMD_BIN" --index "$IDX" collection add "$WORK/docs" --name probe; rc=$?; say2=$(now)
echo "collection add: $(elapsed "$t" "$say2") (exit=$rc)"
t=$(now); "$QMD_BIN" --index "$IDX" embed 2>&1 | tail -1; say2=$(now)
echo "embed: $(elapsed "$t" "$say2")"
t=$(now); "$QMD_BIN" --index "$IDX" vsearch "what is the vault password" --format json > "$WORK/vsearch.json" 2>/dev/null; rc=$?; say2=$(now)
echo "vsearch: $(elapsed "$t" "$say2") (exit=$rc)"

say "C. vsearch JSON schema (fixture source)"
cat "$WORK/vsearch.json"
cp "$WORK/vsearch.json" ./tests/semantic/fixtures/vsearch-sample.json 2>/dev/null \
  && echo "(saved → tests/semantic/fixtures/vsearch-sample.json)"

say "D. vsearch latency variance (3 calls, fresh process each)"
for i in 1 2 3; do
  t=$(now); "$QMD_BIN" --index "$IDX" vsearch "where does the backup job run" --format json >/dev/null 2>&1; say2=$(now)
  echo "call $i: $(elapsed "$t" "$say2")"
done

say "E. per-index overhead"
ls -la ~/.cache/qmd/"$IDX".sqlite
t=$(now); "$QMD_BIN" --index "$IDX" collection list >/dev/null 2>&1; say2=$(now)
echo "startup (collection list, no model load): $(elapsed "$t" "$say2")"

say "F. session-sized index (40 docs / ~120 chunks)"
SIDX="probe-sess-$TS"
mkdir -p "$WORK/sess"
for i in $(seq 1 40); do
  python3 - "$WORK/sess/chunk$(printf %03d $i).md" "$i" <<'EOF'
import random, sys
path, seed = sys.argv[1], int(sys.argv[2])
random.seed(1000 + seed)
words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split()
open(path, 'w').write('\n\n'.join(' '.join(random.choices(words, k=12)) for _ in range(80)))
EOF
done
"$QMD_BIN" --index "$SIDX" collection add "$WORK/sess" --name sess >/dev/null 2>&1
t=$(now); "$QMD_BIN" --index "$SIDX" embed 2>&1 | tail -1; say2=$(now)
echo "embed 120 chunks: $(elapsed "$t" "$say2")"
ls -la ~/.cache/qmd/"$SIDX".sqlite
for i in 1 2 3; do
  t=$(now); "$QMD_BIN" --index "$SIDX" vsearch "which chunk mentions the osaka deployment" --format json >/dev/null 2>&1; say2=$(now)
  echo "vsearch $i: $(elapsed "$t" "$say2")"
done

say "G. daemon lifecycle (qmd mcp --http --daemon)"
"$QMD_BIN" mcp --http --daemon --index "$SIDX" --port "$PORT" 2>&1 | head -2
for i in $(seq 1 30); do
  H="$(curl -s -m 1 "http://localhost:$PORT/health" || true)"
  [ -n "$H" ] && break
  sleep 1
done
echo "health after ${i}s: $H"
mcpq() { # $1 = jsonrpc id, $2 = query text (rerank:false — the 1.7B LLM reranker
# takes ~30s/query on this CPU and is NOT part of the contract)
  curl -s -X POST "http://localhost:$PORT/mcp" \
    -H 'Content-Type: application/json' -H "$ACC" -H 'MCP-Protocol-Version: 2025-03-26' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":int(sys.argv[1]),"method":"tools/call","params":{"name":"query","arguments":{"searches":[{"type":"vec","query":sys.argv[2]}],"limit":3,"collections":["sess"],"rerank":False}}}))' "$1" "$2")"
}
t=$(now); mcpq 1 "warmup one" >/dev/null; say2=$(now)
echo "daemon first vec query (model load): $(elapsed "$t" "$say2")"
t=$(now); mcpq 2 "warmup two" >/dev/null; say2=$(now)
echo "daemon second vec query: $(elapsed "$t" "$say2")"
t=$(now); mcpq 3 "which chunk mentions the osaka deployment" > "$WORK/daemon-q.json"; say2=$(now)
echo "daemon third (warm) vec query: $(elapsed "$t" "$say2")"
head -c 400 "$WORK/daemon-q.json"; echo
"$QMD_BIN" mcp stop --index "$SIDX" 2>&1 | head -1

say "cleanup"
"$QMD_BIN" --index "$IDX" collection remove probe >/dev/null 2>&1
rm -f ~/.cache/qmd/"$IDX".sqlite* ~/.cache/qmd/"$SIDX".sqlite*
echo "done. (probe indexes removed)"
