/**
 * Phase 7a — scripted manual validation (runbook: scripts/manual-validation.md).
 *
 * Drives a REAL pi session (SDK) with this extension loaded, past the
 * compaction threshold, then validates the semantic recall pipeline end-to-end:
 *   1. extension loads; semantic_recall + vcc_recall registered; context > threshold
 *   2. compaction instant (no LLM), 8-section summary in the session file
 *   3. ~/.pi/vector/<sessionId>/ populated; daemon healthy; indexer.log clean
 *   4. paraphrased query on a trimmed-only fact → semantic_recall hit
 *   5. same query via vcc_recall → keyword layer misses / ranks lower (value proof)
 *   6. follow-up question → assistant spontaneously calls semantic_recall
 *
 * Hermetic: temp agentDir (PI_CODING_AGENT_DIR) — the user's real ~/.pi/agent
 * config and session store are untouched. Vector dir uses the real
 * ~/.pi/vector/<sessionId> (that is what we are validating).
 *
 * Run: bun scripts/validate-phase7a.ts   (P7A_KEEP=1 keeps the temp dir)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

const RUN_DIR = mkdtempSync(join(tmpdir(), "p7a-"));
const AGENT_DIR = join(RUN_DIR, "agent");
const WORK_DIR = join(RUN_DIR, "work");
const EVIDENCE_PATH = resolve(process.cwd(), "docs/validation/phase7a-evidence.md");
const MODEL = process.env.P7A_MODEL ?? "homelab-vllm/qwen38";
const DAEMON_PORT = 8390;
const THRESHOLD_TOKENS = 11000;

mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// --- hermetic agentDir (env must be set BEFORE pi is imported) -------------
writeFileSync(
  join(AGENT_DIR, "settings.json"),
  JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 2000, reserveTokens: 4000 } }, null, 2),
);
writeFileSync(
  join(AGENT_DIR, "models.json"),
  JSON.stringify(
    {
      providers: {
        "homelab-vllm": {
          baseUrl: "http://192.168.1.182:8000/v1",
          api: "openai-completions",
          apiKey: "not-needed",
          models: [{ id: "qwen38", contextWindow: 131072 }],
        },
      },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(AGENT_DIR, "pi-vcc-config.json"),
  JSON.stringify(
    {
      overrideDefaultCompaction: true,
      debug: false,
      globalThreshold: { compactAtTokens: THRESHOLD_TOKENS },
      semantic: { enabled: true, chunkTokens: 1500, limit: 5, mode: "vsearch", gpu: "cpu" },
    },
    null,
    2,
  ),
);
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const {
  PARAPHRASE_QUERY,
  PROMPT1,
  PROMPT2,
  PROMPT3,
  FACT_TOKENS,
  PLANTED_FACT,
  waitForDaemonHits,
  vectorDirContents,
  readSessionJsonl,
  findCompactionEntries,
  sectionHeadersPresent,
  extractToolCalls,
} = await import("./validate-phase7a-helpers");
const { createAgentSession, SessionManager, ModelRuntime, DefaultResourceLoader } = await import(
  "@earendil-works/pi-coding-agent"
);

const logLines: string[] = [];
const t0 = Date.now();
const log = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  logLines.push(line);
  console.log(line);
};

const results: Array<{ item: string; pass: boolean; detail: string }> = [];
const check = (item: string, pass: boolean, detail: string) => {
  results.push({ item, pass, detail });
  log(`${pass ? "PASS" : "FAIL"} — ${item}${detail ? ` — ${detail}` : ""}`);
};

// --- 1. session with the extension -----------------------------------------
const modelRuntime = await ModelRuntime.create();
const [provider, modelId] = MODEL.split("/");
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`model ${MODEL} not found`);

const loader = new DefaultResourceLoader({
  cwd: WORK_DIR,
  agentDir: AGENT_DIR,
  additionalExtensionPaths: [resolve("index.ts")],
});
await loader.reload();

const sessionManager = SessionManager.create(WORK_DIR);
const { session } = await createAgentSession({
  model,
  cwd: WORK_DIR,
  agentDir: AGENT_DIR,
  sessionManager,
  resourceLoader: loader,
});

const toolNames = session.agent.state.tools.map((t: any) => t.name);
check(
  "1. extension loaded; semantic_recall + vcc_recall registered",
  toolNames.includes("semantic_recall") && toolNames.includes("vcc_recall"),
  `tools: ${toolNames.join(", ")}`,
);

// The SDK's createAgentSession does NOT call bindExtensions(), so session_start
// (daemon warmup) never fires without this — the TUI flow does it for us.
await session.bindExtensions({});

const sessionId = session.sessionId;
const sanitizedId = sessionId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64);
const vdir = join(homedir(), ".pi", "vector", sanitizedId);
log(`session ${sessionId} → vector dir ${vdir}`);

// --- drive past the threshold ----------------------------------------------
const compaction = { start: 0, end: 0, saw: false, inFlight: false, aborted: 0 };
const onCompaction = (ev: any) => {
  if (ev.type === "compaction_start") {
    compaction.inFlight = true;
    compaction.start = Date.now();
  }
  if (ev.type === "compaction_end") {
    compaction.inFlight = false;
    compaction.end = Date.now();
    if (ev.aborted) compaction.aborted++;
    else compaction.saw = true;
  }
};
session.subscribe(onCompaction);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The proactive hook fires ctx.compact() on agent_end (NOT awaited by prompt()).
// Quiesce: give it time to start, then wait for any in-flight compaction to end.
const quiesce = async (graceMs = 2500) => {
  await sleep(graceMs);
  for (let i = 0; i < 60 && compaction.inFlight; i++) await sleep(500);
};

const promptRetry = async (text: string) => {
  await quiesce();
  for (let attempt = 0; ; attempt++) {
    try {
      await session.prompt(text);
      return;
    } catch (e: any) {
      if (/compaction is in progress/i.test(e?.message ?? "") && attempt < 10) {
        log("prompt collided with compaction — waiting and retrying");
        await sleep(1000);
        continue;
      }
      throw e;
    }
  }
};

log("prompt 1: planted fact + filler (~7k tokens)");
await promptRetry(PROMPT1);
log("prompt 2: filler (~5k tokens) — should cross the threshold");
await promptRetry(PROMPT2);

const waitCompactionEvent = async () => {
  for (let i = 0; i < 60 && !compaction.saw; i++) await sleep(1000);
};
await waitCompactionEvent();
if (!compaction.saw) {
  log("no compaction event yet — calling session.compact() directly (manual fallback)");
  try {
    await session.compact();
  } catch (e: any) {
    log(`manual compact() threw (likely hook-cancelled): ${e?.message}`);
  }
  await waitCompactionEvent();
}

// --- 2. compaction quality ---------------------------------------------------
const sessionFile = session.sessionFile;
// The file can lag in-memory state — poll until the entry is flushed.
const waitForCompactionInFile = async (minCount: number, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let entries: any[] = [];
  while (Date.now() < deadline) {
    entries = sessionFile ? readSessionJsonl(sessionFile) : [];
    if (findCompactionEntries(entries).length >= minCount) break;
    await sleep(500);
  }
  return { entries, comps: findCompactionEntries(entries) };
};
const { entries, comps } = await waitForCompactionInFile(1);
const comp = comps[comps.length - 1];
const summary: string = comp?.summary ?? "";
const headers = sectionHeadersPresent(summary);
// Duration from session-file timestamps: preceding entry → compaction append.
let compDurationMs = -1;
if (comp?.timestamp) {
  const idx = entries.indexOf(comp);
  const prev = entries[idx - 1];
  if (prev?.timestamp) compDurationMs = new Date(comp.timestamp).getTime() - new Date(prev.timestamp).getTime();
}
const factInLiveContext = session.messages.some((m: any) =>
  JSON.stringify(m).includes("amber-otter"),
);
check(
  "2. compaction instant (no LLM), summary sections present",
  comp != null && headers.length >= 3 && compDurationMs >= 0 && compDurationMs < 10000 && !factInLiveContext,
  `duration ${compDurationMs}ms; sections [${headers.join(", ")}]; ` +
    `trimmed span keeps fact OUT of live context: ${!factInLiveContext}`,
);
if (factInLiveContext) log("WARNING: planted fact still in live context — items 4/6 weakened");

// --- 3. vector dir + daemon --------------------------------------------------
log("waiting for vector dir population (embed ~0.2s/chunk)");
let vstat = { files: [], log: "" };
for (let i = 0; i < 60; i++) {
  vstat = vectorDirContents(vdir);
  if (vstat.files.some((f) => /\.md$/.test(f)) && vstat.files.includes("meta.json")) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const daemonUp = await waitForDaemonHits(DAEMON_PORT, sanitizedId, PARAPHRASE_QUERY, 180_000, log);
check(
  "3. vector dir populated; daemon healthy; indexer.log clean",
  vstat.files.includes("meta.json") && vstat.files.some((f) => /\.md$/.test(f)) && daemonUp && vstat.log === "(no indexer.log — clean)",
  `files: ${vstat.files.join(", ")}; indexer.log: ${vstat.log.slice(0, 200)}`,
);

// --- 5. value proof vs vcc_recall (BEFORE the semantic hit — the model must
//      not have seen the fact yet, or its reply would keep it in the kept tail)
log("item 5: same query via vcc_recall (value proof first)");
await promptRetry(
  `Call the vcc_recall tool with exactly this query: "${PARAPHRASE_QUERY}". After it returns, quote the tool result verbatim in your reply.`,
);
const vccCalls = extractToolCalls(session.messages as any[], "vcc_recall");
const vccCall = vccCalls[vccCalls.length - 1];
const vccHasFact = vccCall ? FACT_TOKENS.filter((t) => vccCall.result.includes(t)).length : 0;
check(
  "5. value proof: vcc_recall (keyword) misses / ranks lower on the paraphrase",
  vccCall != null && vccHasFact < FACT_TOKENS.length,
  vccCall
    ? `vcc_recall fact tokens found: ${vccHasFact}/${FACT_TOKENS.length}`
    : "vcc_recall was not called",
);

// --- 4. paraphrase recall -----------------------------------------------------
log("item 4: semantic_recall with paraphrase");
await promptRetry(
  `Call the semantic_recall tool with exactly this query: "${PARAPHRASE_QUERY}". After it returns, quote the tool result verbatim in your reply.`,
);
const semCalls = extractToolCalls(session.messages as any[], "semantic_recall");
const semCall = semCalls[semCalls.length - 1];
const semHitFact = semCall?.result ? FACT_TOKENS.filter((t) => semCall.result.includes(t)) : [];
check(
  "4. paraphrased query → semantic_recall hit on the trimmed-only fact",
  !!semCall && semCall.result.includes("hit(s) for") && semHitFact.length === FACT_TOKENS.length,
  semCall
    ? `query="${semCall.args.query}"; fact tokens found: [${semHitFact.join(", ")}]`
    : "semantic_recall was not called",
);

// --- push the fact out of the kept tail ---------------------------------------
// The task-boundary cut always keeps the last turn, so item 4's turn (which now
// contains the fact) must be trimmed by one more filler turn + compaction.
log("prompt 3: filler — trims the semantic-hit turn on compaction");
await promptRetry(PROMPT3);
await waitCompactionEvent();
const { comps: compsAfter } = await waitForCompactionInFile(comps.length + 1);
log(`compactions in file: ${compsAfter.length}`);

// --- 6. spontaneous use --------------------------------------------------------
log("item 6: question requiring the forgotten fact");
// Wait until the fact is actually out of the live context (the compaction that
// trims item 4's turn may still be in flight / unflushed).
let factStillLive = true;
for (let i = 0; i < 60 && factStillLive; i++) {
  factStillLive = session.messages.some((m: any) => JSON.stringify(m).includes("amber-otter"));
  if (factStillLive) await sleep(500);
}
await promptRetry(
  "What is the exact schedule (day of week and time) for the credential rotation of the staging database replica, and which team performs it?",
);
// Count semantic_recall calls WITHIN the item-6 turn (messages after the last
// user prompt) — counts across the whole live context break when a compaction
// trims the baseline call out between the two measurements.
const msgs = session.messages as any[];
let lastUserIdx = -1;
msgs.forEach((m, i) => {
  if (m.role === "user") lastUserIdx = i;
});
const item6SemCalls = extractToolCalls(msgs.slice(lastUserIdx + 1), "semantic_recall");
const spontaneous = item6SemCalls.length > 0;
const lastAssistant = [...session.messages].reverse().find((m: any) => m.role === "assistant");
const answerText = Array.isArray(lastAssistant?.content)
  ? lastAssistant.content.map((p: any) => p.text ?? "").join("")
  : String(lastAssistant?.content ?? "");
const answerCorrect = answerText.includes("03:15") && (answerText.includes("Tuesday") || answerText.includes("tuesday"));
check(
  "6. assistant spontaneously calls semantic_recall and answers correctly",
  !factStillLive && spontaneous && answerCorrect,
  `fact out of live context pre-check: ${!factStillLive}; ` +
    `semantic_recall calls in item-6 turn: ${item6SemCalls.length}; ` +
    `answer mentions 03:15+Tuesday: ${answerCorrect}`,
);
if (factStillLive) log("WARNING: fact still in live context at item 6 — spontaneous-use test contaminated");

// --- evidence ------------------------------------------------------------------
const evidence = [
  `# Phase 7a validation evidence`,
  ``,
  `- Date: ${new Date().toISOString()}`,
  `- Model: ${MODEL}`,
  `- Session: ${sessionId}`,
  `- Session file: ${sessionFile}`,
  `- Vector dir: ${vdir}`,
  `- Threshold: ${THRESHOLD_TOKENS} tokens (pi-vcc globalThreshold.compactAtTokens)`,
  `- Planted fact: ${PLANTED_FACT}`,
  `- Paraphrase query: ${PARAPHRASE_QUERY}`,
  ``,
  `## Results`,
  ``,
  ...results.map((r) => `- [${r.pass ? "x" : " "}] **${r.item}** — ${r.detail}`),
  ``,
  `## Compaction summary (first 60 lines)`,
  ``,
  "```",
  summary.split("\n").slice(0, 60).join("\n"),
  "```",
  ``,
  `## Item 4 — semantic_recall result`,
  ``,
  "```",
  (semCall?.result ?? "(not called)").slice(0, 4000),
  "```",
  ``,
  `## Item 5 — vcc_recall result`,
  ``,
  "```",
  (vccCall?.result ?? "(not called)").slice(0, 4000),
  "```",
  ``,
  `## Item 6 — final assistant answer`,
  ``,
  "```",
  answerText.slice(0, 2000),
  "```",
  ``,
  `## Run log`,
  ``,
  "```",
  ...logLines,
  "```",
  ``,
].join("\n");

mkdirSync(join("docs", "validation"), { recursive: true });
writeFileSync(EVIDENCE_PATH, evidence);
log(`evidence → ${EVIDENCE_PATH}`);
log(`total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const failed = results.filter((r) => !r.pass);
if (process.env.P7A_KEEP) log(`P7A_KEEP=1 — temp dir kept at ${RUN_DIR}`);
process.exit(failed.length === 0 ? 0 : 1);
