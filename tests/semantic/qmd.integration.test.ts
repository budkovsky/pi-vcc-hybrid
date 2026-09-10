/**
 * Phase 3 — real-qmd integration test (tag: qmd-integration).
 *
 * Skipped unless RUN_QMD=1 (no network / no model load in the default suite).
 * Real qmd in a throwaway index: 3 chunks → embed → daemon → paraphrased
 * search returns the right chunk. Cleanup is best-effort in `finally`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { QmdBackend } from "../../src/semantic/qmd";

const RUN = process.env.RUN_QMD === "1";

const INDEX = `pi-sem-it-${Date.now()}`;
const PORT = 8391; // away from the default 8390
const COLL = "itsess";

// ~1500-token filler + one unique fact per chunk (same facts as the Phase-0 probe).
const FILLER = Array.from({ length: 80 }, () =>
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor".split(" ")
    .sort(() => Math.random() - 0.5)
    .join(" "),
).join("\n\n");

const FACTS: Record<string, string> = {
  "0001.md": "The secret password for the vault is blue zebra 42.",
  "0002.md": "The deployment target is the osaka region.",
  "0003.md": "The backup cron runs at 03:15 UTC.",
};

let tmp: string;
let backend: QmdBackend;

describe.skipIf(!RUN)("qmd-integration: real qmd end-to-end", () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "qmd-it-"));
    for (const [name, fact] of Object.entries(FACTS)) {
      writeFileSync(join(tmp, name), FILLER + "\n\n" + fact + "\n");
    }
    backend = new QmdBackend({
      indexName: INDEX,
      daemonPort: PORT,
      healthTimeoutMs: 60_000,
      timeoutMs: 120_000, // first query can span the one-time model load
    });
    await backend.ensureIndex(COLL, tmp);
    await backend.embed(COLL);
    await backend.ensureDaemon();
  }, 300_000);

  afterAll(async () => {
    await backend?.stopDaemon().catch(() => {});
    await backend?.remove(COLL).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
    // best-effort: drop the throwaway index sqlite (no `qmd index remove` in the contract)
    for (const suffix of ["", "-shm", "-wal"]) {
      rmSync(join(homedir(), ".cache", "qmd", `${INDEX}.sqlite${suffix}`), { force: true });
    }
  });

  it("a paraphrased query returns the chunk with the fact (top hit)", async () => {
    // The one-time model load (~30–67s cold) can span the first queries —
    // retry a few times; steady state is ~30ms.
    let hits: any[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        hits = await backend.search(COLL, "when does the nightly backup run", { limit: 3 });
        if (hits.length > 0) break;
      } catch {
        /* daemon still warming — retry */
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe(`${COLL}/0003.md`);
    expect(hits[0].score).toBeGreaterThan(0);
    // raw-shape contract: file = "<collection>/<relpath>", snippet line-prefixed
    expect(hits[0].snippet).toMatch(/^\d+:/);
  }, 300_000);

  it("search is isolated to the session collection", async () => {
    const hits = await backend.search("other-session", "when does the nightly backup run", {
      limit: 3,
    });
    for (const h of hits) expect(h.file.startsWith("other-session/")).toBe(true);
  }, 120_000);
});
