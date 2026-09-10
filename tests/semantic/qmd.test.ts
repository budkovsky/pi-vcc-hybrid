import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { QmdBackend } from "../../src/semantic/qmd";
import { DEFAULT_TIMEOUT_MS, EMBED_TIMEOUT_MS, execQmd } from "../../src/semantic/qmd-cli";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type ExecCall = { argv: string[]; env: Record<string, string>; timeoutMs: number };
type ExecFn = (argv: string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function makeExec(impl?: (call: ExecCall, n: number) => { exitCode?: number; stdout?: string; stderr?: string } | Promise<any>) {
  const calls: ExecCall[] = [];
  const fn: ExecFn = async (argv, opts) => {
    const call = { argv, env: opts.env, timeoutMs: opts.timeoutMs };
    calls.push(call);
    const r = (await impl?.(call, calls.length)) ?? {};
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { fn, calls };
}

type FetchCall = { url: string; body?: any };
function makeFetch(impl: (url: string, init: any, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = async (url: string | URL | Request, init?: any): Promise<Response> => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, body });
    return impl(u, init, calls.length);
  };
  return { fn, calls };
}

const okHealth = () => new Response(JSON.stringify({ status: "ok", uptime: 1 }), { status: 200 });
const rpcResults = (results: unknown) =>
  new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { results } },
    })}\n\n`,
    { status: 200 },
  );

const RAW_HIT = {
  docid: "#a7eeef",
  file: "s1/0001.md",
  title: "0001",
  score: 0.9,
  line: 5,
  snippet: "5: @@ -4,2 @@\n6: The backup cron runs at 03:15 UTC.",
};

// ---------------------------------------------------------------------------
// CLI side: argv, env, exit codes
// ---------------------------------------------------------------------------

describe("QmdBackend.ensureIndex", () => {
  it("adds the session collection with the exact argv + QMD_FORCE_CPU=1", async () => {
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ exec: fn });
    await b.ensureIndex("s1", "/tmp/vector/s1");
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([
      "qmd",
      "--index",
      "pi-semantic",
      "collection",
      "add",
      "/tmp/vector/s1",
      "--name",
      "s1",
    ]);
    expect(calls[0].env).toEqual({ QMD_FORCE_CPU: "1" });
    expect(calls[0].timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("is idempotent: exit 1 (collection already exists) resolves", async () => {
    const { fn } = makeExec(() => ({ exitCode: 1 }));
    const b = new QmdBackend({ exec: fn });
    await expect(b.ensureIndex("s1", "/tmp/vector/s1")).resolves.toBeUndefined();
  });

  it("other exit codes → QmdError('cli-failed') carrying stderr", async () => {
    const { fn } = makeExec(() => ({ exitCode: 2, stderr: "index locked" }));
    const b = new QmdBackend({ exec: fn });
    await expect(b.ensureIndex("s1", "/tmp/vector/s1")).rejects.toMatchObject({
      code: "cli-failed",
    });
    await expect(b.ensureIndex("s1", "/tmp/vector/s1")).rejects.toThrow(/index locked/);
  });

  it("sanitizes the sessionId into the collection name", async () => {
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ exec: fn });
    await b.ensureIndex("a/b..c", "/tmp/vector/a_b_c");
    expect(calls[0].argv).toContain("a_b_c");
  });

  it("gpu=force → no QMD_FORCE_CPU in env", async () => {
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ exec: fn, gpu: "force" });
    await b.ensureIndex("s1", "/tmp/vector/s1");
    expect(calls[0].env).toEqual({});
  });
});

describe("QmdBackend.embed", () => {
  it("embeds only the session collection, with the long embed timeout", async () => {
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ exec: fn });
    await b.embed("s1");
    expect(calls[0].argv).toEqual(["qmd", "--index", "pi-semantic", "embed", "-c", "s1"]);
    expect(calls[0].timeoutMs).toBe(EMBED_TIMEOUT_MS);
  });

  it("exit 1 → QmdError('cli-failed') (no idempotency case for embed)", async () => {
    const { fn } = makeExec(() => ({ exitCode: 1, stderr: "no documents" }));
    const b = new QmdBackend({ exec: fn });
    await expect(b.embed("s1")).rejects.toMatchObject({ code: "cli-failed" });
  });
});

describe("QmdBackend.remove", () => {
  it("removes the session collection with the exact argv", async () => {
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ exec: fn });
    await b.remove("s1");
    expect(calls[0].argv).toEqual(["qmd", "--index", "pi-semantic", "collection", "remove", "s1"]);
  });

  it("exit 1 (collection missing) resolves — cleanup is idempotent", async () => {
    const { fn } = makeExec(() => ({ exitCode: 1 }));
    const b = new QmdBackend({ exec: fn });
    await expect(b.remove("s1")).resolves.toBeUndefined();
  });

  it("other exit codes → QmdError('cli-failed')", async () => {
    const { fn } = makeExec(() => ({ exitCode: 3, stderr: "boom" }));
    const b = new QmdBackend({ exec: fn });
    await expect(b.remove("s1")).rejects.toMatchObject({ code: "cli-failed" });
  });
});

// ---------------------------------------------------------------------------
// daemon lifecycle
// ---------------------------------------------------------------------------

describe("QmdBackend.ensureDaemon", () => {
  it("healthy daemon → no spawn, no warmup (reuse across pi restarts)", async () => {
    const { fn: exec, calls: execCalls } = makeExec();
    const { fn: fetch, calls: fetchCalls } = makeFetch((url) =>
      url.endsWith("/health") ? okHealth() : rpcResults([]),
    );
    const b = new QmdBackend({ exec, fetch });
    await b.ensureDaemon();
    expect(execCalls).toHaveLength(0);
    // only the health probe — the warmup query belongs to spawn, not reuse
    expect(fetchCalls.map((c) => c.url)).toEqual(["http://localhost:8390/health"]);
  });

  it("down daemon → spawn with exact argv, poll health, fire warmup (not awaited)", async () => {
    const { fn: exec, calls: execCalls } = makeExec();
    let healths = 0;
    const { fn: fetch, calls: fetchCalls } = makeFetch((url, init) => {
      if (url.endsWith("/health")) return ++healths >= 2 ? okHealth() : new Response("no", { status: 503 });
      const body = JSON.parse(init.body);
      const q = body.params.arguments;
      // warmup: vec + rerank:false; the real search: our query text
      if (q.searches?.[0]?.query === "warmup") return new Promise(() => {}); // hangs forever
      return rpcResults([RAW_HIT]);
    });
    const b = new QmdBackend({ exec, fetch, healthPollMs: 5, healthTimeoutMs: 5000 });
    await b.ensureDaemon();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].argv).toEqual([
      "qmd",
      "--index",
      "pi-semantic",
      "mcp",
      "--http",
      "--daemon",
      "--port",
      "8390",
    ]);
    expect(healths).toBe(2);
    // warmup fired as a throwaway vec query with rerank:false
    const warmup = fetchCalls.find((c) => c.body?.params?.arguments?.searches?.[0]?.query === "warmup");
    expect(warmup?.body.params.arguments.rerank).toBe(false);
  });

  it("concurrent ensureDaemon → single spawn (in-flight guard)", async () => {
    const { fn: exec, calls: execCalls } = makeExec();
    let healths = 0;
    const { fn: fetch } = makeFetch((url, init) => {
      if (url.endsWith("/health")) return ++healths >= 2 ? okHealth() : new Response("no", { status: 503 });
      return new Promise(() => {}); // warmup hangs
    });
    const b = new QmdBackend({ exec, fetch, healthPollMs: 5, healthTimeoutMs: 5000 });
    await Promise.all([b.ensureDaemon(), b.ensureDaemon()]);
    expect(execCalls).toHaveLength(1);
  });

  it("daemon never becomes healthy → QmdError('daemon-unreachable')", async () => {
    const { fn: exec } = makeExec();
    const { fn: fetch } = makeFetch((url) =>
      url.endsWith("/health") ? new Response("no", { status: 503 }) : new Response("x", { status: 200 }),
    );
    const b = new QmdBackend({ exec, fetch, healthPollMs: 5, healthTimeoutMs: 50 });
    await expect(b.ensureDaemon()).rejects.toMatchObject({ code: "daemon-unreachable" });
  });

  it("warmup failure is logged, never thrown, never blocks", async () => {
    const logs: string[] = [];
    const { fn: exec } = makeExec();
    let healths = 0;
    const { fn: fetch } = makeFetch((url) => {
      // first health probe fails → spawn path; then healthy
      if (url.endsWith("/health")) return ++healths >= 2 ? okHealth() : new Response("no", { status: 503 });
      throw new Error("warmup blew up");
    });
    const b = new QmdBackend({ exec, fetch, healthPollMs: 5, log: (l) => logs.push(l) });
    await b.ensureDaemon(); // must resolve despite the warmup rejection
    expect(logs.some((l) => /warmup/i.test(l))).toBe(true);
  });
});

describe("QmdBackend.stopDaemon", () => {
  it("stops with --index (required by the contract)", async () => {
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ exec: fn });
    await b.stopDaemon();
    expect(calls[0].argv).toEqual(["qmd", "mcp", "stop", "--index", "pi-semantic"]);
  });

  it("'not running' (exit 1) resolves — stop is idempotent", async () => {
    const { fn } = makeExec(() => ({ exitCode: 1, stderr: "Not running" }));
    const b = new QmdBackend({ exec: fn });
    await expect(b.stopDaemon()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe("QmdBackend.search", () => {
  it("ensures the daemon, then queries with the session collection + defaults (limit 5, vec)", async () => {
    const { fn: exec } = makeExec();
    const { fn: fetch, calls } = makeFetch((url, init) => {
      if (url.endsWith("/health")) return okHealth();
      return rpcResults([RAW_HIT]);
    });
    const b = new QmdBackend({ exec, fetch });
    const hits = await b.search("s1", "when does the backup run");
    expect(hits).toEqual([RAW_HIT]);
    const q = calls.find((c) => c.body)?.body;
    expect(q.params.name).toBe("query");
    expect(q.params.arguments).toEqual({
      searches: [{ type: "vec", query: "when does the backup run" }],
      limit: 5,
      collections: ["s1"],
      rerank: false,
    });
  });

  it("opts override limit + mode ('query' → auto-expansion field)", async () => {
    const { fn: exec } = makeExec();
    const { fn: fetch, calls } = makeFetch((url, init) => {
      if (url.endsWith("/health")) return okHealth();
      return rpcResults([]);
    });
    const b = new QmdBackend({ exec, fetch });
    await b.search("s1", "vault password", { limit: 3, mode: "query" });
    const q = calls.find((c) => c.body)?.body;
    expect(q.params.arguments).toEqual({
      query: "vault password",
      limit: 3,
      collections: ["s1"],
      rerank: false,
    });
  });

  it("sanitizes the collection filter from the sessionId", async () => {
    const { fn: exec } = makeExec();
    const { fn: fetch, calls } = makeFetch((url, init) => {
      if (url.endsWith("/health")) return okHealth();
      return rpcResults([]);
    });
    const b = new QmdBackend({ exec, fetch });
    await b.search("a/b..c", "x");
    const q = calls.find((c) => c.body)?.body;
    expect(q.params.arguments.collections).toEqual(["a_b_c"]);
  });

  it("daemon query error → structured QmdError, never an unhandled rejection", async () => {
    const { fn: exec } = makeExec();
    const { fn: fetch } = makeFetch((url) => {
      if (url.endsWith("/health")) return okHealth();
      throw new Error("ECONNREFUSED");
    });
    const b = new QmdBackend({ exec, fetch });
    await expect(b.search("s1", "x")).rejects.toMatchObject({ code: "daemon-unreachable" });
  });

  it("returns [] for an empty result set (recall layer decides the friendly message)", async () => {
    const { fn: exec } = makeExec();
    const { fn: fetch } = makeFetch((url) =>
      url.endsWith("/health") ? okHealth() : rpcResults([]),
    );
    const b = new QmdBackend({ exec, fetch });
    expect(await b.search("s1", "x")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// real exec wrapper (fake qmd binary in a tmpdir — no qmd needed)
// ---------------------------------------------------------------------------

describe("execQmd (real spawn, fake qmd binary)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qmd-exec-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const writeBin = (name: string, body: string) => {
    const p = join(tmp, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  };

  it("captures stdout and stderr separately (contract: JSON on stdout, trace on stderr)", async () => {
    const bin = writeBin("qmd", 'echo "{\\"a\\":1}"\necho "expansion trace" >&2' );
    const r = await execQmd([bin, "collection", "list"], { env: {}, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"a":1');
    expect(r.stderr).toContain("expansion trace");
  });

  it("propagates non-zero exit codes without throwing (caller interprets exit codes)", async () => {
    const bin = writeBin("qmd", "exit 7");
    const r = await execQmd([bin, "collection", "list"], { env: {}, timeoutMs: 5000 });
    expect(r.exitCode).toBe(7);
  });

  it("timeout → QmdError('timeout') (never an unhandled rejection)", async () => {
    const bin = writeBin("qmd", "sleep 5");
    await expect(
      execQmd([bin, "collection", "list"], { env: {}, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("missing binary → QmdError('cli-failed')", async () => {
    await expect(
      execQmd([join(tmp, "no-such-qmd"), "collection", "list"], { env: {}, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "cli-failed" });
  });

  it("the backend's default exec is the real spawn (argv[0] = qmdBin)", async () => {
    const bin = writeBin("qmd", "exit 0");
    const { fn, calls } = makeExec();
    const b = new QmdBackend({ qmdBin: bin, exec: fn });
    await b.remove("s1");
    expect(calls[0].argv[0]).toBe(bin);
  });
});
