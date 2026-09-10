import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  seqOf,
  provenanceOf,
  textOf,
  shapeHit,
  shapeHits,
  shapeHitsFromDisk,
  formatHits,
  emptyResult,
  unavailableResult,
  type Hit,
} from "../../src/semantic/recall";
import { registerSemanticRecallTool } from "../../src/semantic/recall-tool";
import { DEFAULT_SEMANTIC_CONFIG } from "../../src/semantic/config";
import { QmdBackend } from "../../src/semantic/qmd";
import { QmdError } from "../../src/semantic/qmd-cli";
import type { QmdRawHit } from "../../src/semantic/qmd-daemon";

// ---------------------------------------------------------------------------
// fixtures (daemon raw-hit shape per docs/qmd-contract.md)
// ---------------------------------------------------------------------------

const HEADER =
  "<!-- pi-semantic session=s1 seq=3 turn=42 ts=2026-07-10T12:00:00Z files=src/a.ts,src/b.ts -->";
const CHUNK_TEXT = [
  "[user] when does the backup run?",
  "[assistant] The backup cron runs at 03:15 UTC.",
].join("\n");
const CHUNK_FILE = `${HEADER}\n\n${CHUNK_TEXT}`;

const RAW_HIT: QmdRawHit = {
  docid: "#a7eeef",
  file: "s1/0003.md",
  title: "0003",
  score: 0.9,
  line: 5,
  snippet: "5: @@ -4,2 @@\n6: The backup cron runs at 03:15 UTC.",
};

const RAW_HIT2: QmdRawHit = {
  docid: "#b8ff00",
  file: "s1/0007.md",
  title: "0007",
  score: 0.5,
  line: 1,
  snippet: "1: @@ -0,1 @@\n2: The deploy key lives in 1Password.",
};

// ---------------------------------------------------------------------------
// seqOf
// ---------------------------------------------------------------------------

describe("seqOf", () => {
  it("parses a collection-prefixed path", () => {
    expect(seqOf("s1/0003.md")).toBe(3);
  });

  it("parses a qmd:// URI (Phase-0 CLI fixture form)", () => {
    expect(seqOf("qmd://s1/0003.md?index=pi-semantic")).toBe(3);
  });

  it("parses a bare filename", () => {
    expect(seqOf("0007.md")).toBe(7);
  });

  it("returns null for non-numeric names (fixture doc1.md)", () => {
    expect(seqOf("qmd://probe/doc1.md?index=probe-1789063789")).toBeNull();
  });

  it("returns null for non-md files", () => {
    expect(seqOf("s1/notes.txt")).toBeNull();
  });

  it("returns null for trailing junk", () => {
    expect(seqOf("s1/0003.md.bak")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(seqOf("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// provenanceOf / textOf
// ---------------------------------------------------------------------------

describe("provenanceOf", () => {
  it("parses 'turn <t>, <iso>' from the chunk header", () => {
    expect(provenanceOf(CHUNK_FILE)).toBe("turn 42, 2026-07-10T12:00:00Z");
  });

  it("returns 'unknown' for null content", () => {
    expect(provenanceOf(null)).toBe("unknown");
  });

  it("returns 'unknown' for a malformed header", () => {
    expect(provenanceOf("<!-- nope -->\n\nbody")).toBe("unknown");
  });
});

describe("textOf", () => {
  it("returns the text after the header for a chunk file", () => {
    expect(textOf(CHUNK_FILE, RAW_HIT.snippet)).toBe(CHUNK_TEXT);
  });

  it("falls back to the snippet (line numbers + hunk header stripped)", () => {
    expect(textOf(null, RAW_HIT.snippet)).toBe("The backup cron runs at 03:15 UTC.");
  });

  it("handles CLI-style snippets (Phase-0 fixture form)", () => {
    const cliSnippet =
      "@@ -160,3 @@ (159 before, 0 after)\n\nThe secret password for the vault is blue zebra 42.\n";
    expect(textOf(null, cliSnippet)).toBe(
      "The secret password for the vault is blue zebra 42.",
    );
  });

  it("returns '' when there is no content and no snippet", () => {
    expect(textOf(null, "")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// shapeHit / shapeHits
// ---------------------------------------------------------------------------

describe("shapeHit", () => {
  it("shapes a raw hit with chunk content", () => {
    const hit = shapeHit(RAW_HIT, CHUNK_FILE);
    expect(hit).toEqual({
      seq: 3,
      file: "s1/0003.md",
      score: 0.9,
      text: CHUNK_TEXT,
      provenance: "turn 42, 2026-07-10T12:00:00Z",
    });
  });

  it("falls back to the snippet when the chunk file is missing", () => {
    const hit = shapeHit(RAW_HIT, null);
    expect(hit.seq).toBe(3);
    expect(hit.text).toBe("The backup cron runs at 03:15 UTC.");
    expect(hit.provenance).toBe("unknown");
  });

  it("keeps a hit whose file name is unparseable (seq null)", () => {
    const hit = shapeHit({ ...RAW_HIT, file: "s1/notes.md" }, null);
    expect(hit.seq).toBeNull();
    expect(hit.text).toBe("The backup cron runs at 03:15 UTC.");
  });
});

describe("shapeHits", () => {
  const contents = new Map<number, string | null>([
    [3, CHUNK_FILE],
    [7, null],
  ]);

  it("shapes all raw hits in order", () => {
    const hits = shapeHits([RAW_HIT, RAW_HIT2], contents, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].seq).toBe(3);
    expect(hits[0].provenance).toBe("turn 42, 2026-07-10T12:00:00Z");
    expect(hits[1].seq).toBe(7);
    expect(hits[1].text).toBe("The deploy key lives in 1Password.");
  });

  it("slices to the limit", () => {
    expect(shapeHits([RAW_HIT, RAW_HIT2], contents, 1)).toHaveLength(1);
    expect(shapeHits([RAW_HIT, RAW_HIT2], contents, 0)).toHaveLength(0);
  });

  it("handles an empty raw list", () => {
    expect(shapeHits([], contents, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shapeHitsFromDisk (real fs, tmpdir)
// ---------------------------------------------------------------------------

describe("shapeHitsFromDisk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-semantic-recall-"));
    writeFileSync(join(dir, "0003.md"), CHUNK_FILE);
    // 0007.md intentionally missing → snippet fallback
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads NNNN.md files and shapes hits", async () => {
    const hits = await shapeHitsFromDisk([RAW_HIT, RAW_HIT2], dir, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].text).toBe(CHUNK_TEXT);
    expect(hits[0].provenance).toBe("turn 42, 2026-07-10T12:00:00Z");
    expect(hits[1].text).toBe("The deploy key lives in 1Password.");
    expect(hits[1].provenance).toBe("unknown");
  });

  it("does not throw for a missing file (fallback, degraded not broken)", async () => {
    const hits = await shapeHitsFromDisk([{ ...RAW_HIT, file: "s1/0099.md" }], dir, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("The backup cron runs at 03:15 UTC.");
  });

  it("accepts an injectable readChunk", async () => {
    const readChunk = async (_dir: string, seq: number): Promise<string | null> =>
      seq === 3 ? CHUNK_FILE : null;
    const hits = await shapeHitsFromDisk([RAW_HIT], dir, 5, readChunk);
    expect(hits[0].text).toBe(CHUNK_TEXT);
  });
});

// ---------------------------------------------------------------------------
// formatHits / emptyResult / unavailableResult (plan §0c strings)
// ---------------------------------------------------------------------------

describe("formatHits", () => {
  const hits: Hit[] = [
    { seq: 3, file: "s1/0003.md", score: 0.9, text: CHUNK_TEXT, provenance: "turn 42, 2026-07-10T12:00:00Z" },
    { seq: 7, file: "s1/0007.md", score: 0.5, text: "fallback line", provenance: "unknown" },
  ];

  it("renders the pinned success format", () => {
    expect(formatHits(hits, "backup schedule")).toBe(
      [
        '# 2 hit(s) for "backup schedule"',
        "",
        "## [1] turn 42, 2026-07-10T12:00:00Z (score 0.90)",
        CHUNK_TEXT,
        "",
        "## [2] unknown (score 0.50)",
        "fallback line",
      ].join("\n"),
    );
  });

  it("delegates to emptyResult for no hits", () => {
    expect(formatHits([], "backup schedule")).toBe(emptyResult("backup schedule"));
  });
});

describe("emptyResult / unavailableResult", () => {
  it("empty: friendly catching-up message", () => {
    expect(emptyResult("vault password")).toBe(
      'No indexed content matched "vault password" (index may still be catching up; try vcc_recall for exact terms).',
    );
  });

  it("unavailable: friendly degraded message with reason", () => {
    expect(unavailableResult("vault password", "daemon down")).toBe(
      'semantic_recall unavailable for "vault password": daemon down. Try vcc_recall for exact terms.',
    );
  });
});

// ---------------------------------------------------------------------------
// registration gating
// ---------------------------------------------------------------------------

function makePi() {
  const tools: any[] = [];
  const pi = { registerTool: (t: any) => tools.push(t) };
  return { pi, tools };
}

const fakeBackend = (raw: QmdRawHit[] = [], fail?: Error) => {
  const calls: { sessionId: string; query: string; opts: any }[] = [];
  return {
    calls,
    backend: {
      search: async (sessionId: string, query: string, opts: any) => {
        calls.push({ sessionId, query, opts });
        if (fail) throw fail;
        return raw;
      },
    },
  };
};

const ctxFor = (sessionId: string) =>
  ({ sessionManager: { getSessionId: () => sessionId } } as any);

describe("registerSemanticRecallTool", () => {
  it("does not register when semantic.enabled=false", () => {
    const { pi, tools } = makePi();
    registerSemanticRecallTool(pi as any, {
      config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: false },
      backend: fakeBackend().backend as any,
    });
    expect(tools).toHaveLength(0);
  });

  it("registers semantic_recall with snippet + guidelines when enabled", () => {
    const { pi, tools } = makePi();
    registerSemanticRecallTool(pi as any, {
      config: DEFAULT_SEMANTIC_CONFIG,
      backend: fakeBackend().backend as any,
    });
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.name).toBe("semantic_recall");
    expect(t.promptSnippet).toContain("semantic_recall");
    expect(Array.isArray(t.promptGuidelines)).toBe(true);
    expect(t.promptGuidelines.join(" ")).toContain("vcc_recall");
    expect(t.parameters?.properties?.query).toBeDefined();
    expect(t.parameters?.properties?.limit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// tool handler
// ---------------------------------------------------------------------------

describe("semantic_recall handler", () => {
  it("returns formatted hits for a successful search", async () => {
    const { pi, tools } = makePi();
    const { backend, calls } = fakeBackend([RAW_HIT]);
    registerSemanticRecallTool(pi as any, {
      config: DEFAULT_SEMANTIC_CONFIG,
      backend: backend as any,
      readChunk: async () => CHUNK_FILE,
    });

    const res = await tools[0].execute("c1", { query: "backup schedule" }, undefined, undefined, ctxFor("sess-1"));
    const text = res.content[0].text;
    expect(text).toBe(
      [
        '# 1 hit(s) for "backup schedule"',
        "",
        "## [1] turn 42, 2026-07-10T12:00:00Z (score 0.90)",
        CHUNK_TEXT,
      ].join("\n"),
    );
    expect(calls).toEqual([{ sessionId: "sess-1", query: "backup schedule", opts: { limit: 5, mode: "vsearch" } }]);
  });

  it("resolves the sessionId from the tool context", async () => {
    const { pi, tools } = makePi();
    const { backend, calls } = fakeBackend([]);
    registerSemanticRecallTool(pi as any, { config: DEFAULT_SEMANTIC_CONFIG, backend: backend as any });
    await tools[0].execute("c1", { query: "x" }, undefined, undefined, ctxFor("sess-42"));
    expect(calls[0].sessionId).toBe("sess-42");
  });

  it("passes the requested limit and config mode", async () => {
    const { pi, tools } = makePi();
    const { backend, calls } = fakeBackend([]);
    registerSemanticRecallTool(pi as any, {
      config: { ...DEFAULT_SEMANTIC_CONFIG, mode: "query" },
      backend: backend as any,
    });
    await tools[0].execute("c1", { query: "x", limit: 3 }, undefined, undefined, ctxFor("s"));
    expect(calls[0].opts).toEqual({ limit: 3, mode: "query" });
  });

  it("clamps out-of-range limits to the config default", async () => {
    const { pi, tools } = makePi();
    const { backend, calls } = fakeBackend([]);
    registerSemanticRecallTool(pi as any, { config: DEFAULT_SEMANTIC_CONFIG, backend: backend as any });
    await tools[0].execute("c1", { query: "x", limit: 0 }, undefined, undefined, ctxFor("s"));
    expect(calls[0].opts.limit).toBe(5);
    await tools[0].execute("c2", { query: "x", limit: 500 }, undefined, undefined, ctxFor("s"));
    expect(calls[1].opts.limit).toBe(5);
  });

  it("returns the friendly empty message (not an error) for zero hits", async () => {
    const { pi, tools } = makePi();
    const { backend } = fakeBackend([]);
    registerSemanticRecallTool(pi as any, { config: DEFAULT_SEMANTIC_CONFIG, backend: backend as any });
    const res = await tools[0].execute("c1", { query: "vault password" }, undefined, undefined, ctxFor("s"));
    expect(res.content[0].text).toBe(emptyResult("vault password"));
  });

  it("degrades to a friendly message + log when the backend fails", async () => {
    const { pi, tools } = makePi();
    const { backend } = fakeBackend([], new QmdError("daemon-unreachable", "daemon down"));
    const lines: string[] = [];
    registerSemanticRecallTool(pi as any, {
      config: DEFAULT_SEMANTIC_CONFIG,
      backend: backend as any,
      log: (l: string) => lines.push(l),
    });
    const res = await tools[0].execute("c1", { query: "vault password" }, undefined, undefined, ctxFor("s"));
    expect(res.content[0].text).toBe(unavailableResult("vault password", "daemon down"));
    expect(lines.join(" ")).toContain("daemon down");
  });

  it("rejects an empty query without touching the backend", async () => {
    const { pi, tools } = makePi();
    const { backend, calls } = fakeBackend([RAW_HIT]);
    registerSemanticRecallTool(pi as any, { config: DEFAULT_SEMANTIC_CONFIG, backend: backend as any });
    const res = await tools[0].execute("c1", { query: "   " }, undefined, undefined, ctxFor("s"));
    expect(res.content[0].text).toContain("query");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// query sanitization: the query must reach the daemon as a literal JSON
// string (never a shell string); no CLI/shell path is involved in recall.
// ---------------------------------------------------------------------------

describe("query sanitization (real QmdBackend, fake exec/fetch)", () => {
  const okHealth = () =>
    new Response(JSON.stringify({ status: "ok", uptime: 1 }), { status: 200 });
  const rpcResults = (results: unknown) =>
    new Response(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { results } },
      })}\n\n`,
      { status: 200 },
    );

  it("passes a shell-metachar query through as a literal JSON string", async () => {
    const malicious = 'a"; rm -rf /; echo "$(pwned)"';
    const execCalls: string[][] = [];
    const fetchBodies: any[] = [];
    const b = new QmdBackend({
      daemonPort: 8391,
      exec: async (argv) => {
        execCalls.push(argv);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      fetch: async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("/health")) return okHealth();
        fetchBodies.push(JSON.parse(init.body));
        return rpcResults([RAW_HIT]);
      },
    });

    const hits = await b.search("s1", malicious, { limit: 3, mode: "vsearch" });
    expect(hits).toHaveLength(1);
    // the query is a literal string inside the JSON-RPC body
    expect(fetchBodies[0].params.arguments.searches[0].query).toBe(malicious);
    // recall never touches the CLI/shell
    expect(execCalls).toHaveLength(0);
  });
});
