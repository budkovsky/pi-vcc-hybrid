import { describe, it, expect } from "bun:test";
import {
  MCP_PROTOCOL_VERSION,
  QmdError,
  checkHealth,
  daemonUrl,
  queryBody,
  queryDaemon,
} from "../../src/semantic/qmd-daemon";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type Call = { url: string; init: any };

function makeFetch(impl: (url: string, init: any) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: any): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return impl(u, init);
  };
  return { fn, calls };
}

const sse = (payload: unknown): Response =>
  new Response(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const rpcResult = (results: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [{ type: "text", text: "3 results" }],
    structuredContent: { results },
  },
});

const sampleResults = [
  {
    docid: "#a7eeef",
    file: "s1/0007.md",
    title: "0007",
    score: 1,
    line: 77,
    snippet: "77: @@ -76,4 @@ (75 before, 83 after)\n78: \n79: The backup cron runs at 03:15 UTC.",
  },
  {
    docid: "#000001",
    file: "s1/0001.md",
    title: "0001",
    score: 0.42,
    line: 3,
    snippet: "3: @@ -2,2 @@\n4: The deployment target is the osaka region.",
  },
];

// ---------------------------------------------------------------------------
// queryBody — the exact HTTP request bodies (Phase 3 asserts these)
// ---------------------------------------------------------------------------

describe("queryBody (JSON-RPC tools/call 'query')", () => {
  it("mode vsearch → vec search, rerank:false MANDATORY, limit + collections passed", () => {
    expect(
      queryBody(7, {
        query: "when does the backup run",
        limit: 5,
        mode: "vsearch",
        collections: ["s1"],
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "query",
        arguments: {
          searches: [{ type: "vec", query: "when does the backup run" }],
          limit: 5,
          collections: ["s1"],
          rerank: false,
        },
      },
    });
  });

  it("mode query → auto-expansion 'query' field, still rerank:false", () => {
    const body: any = queryBody(8, {
      query: "vault password",
      limit: 3,
      mode: "query",
      collections: ["s1"],
    });
    expect(body.params.arguments).toEqual({
      query: "vault password",
      limit: 3,
      collections: ["s1"],
      rerank: false,
    });
    expect(body.params.arguments.searches).toBeUndefined();
  });

  it("protocol version is the 2025-era one (no _meta envelope)", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-03-26");
  });
});

describe("daemonUrl", () => {
  it("uses localhost (daemon listens on IPv6 [::1] — 127.0.0.1 fails)", () => {
    expect(daemonUrl(8390, "/health")).toBe("http://localhost:8390/health");
    expect(daemonUrl(8390, "/mcp")).toBe("http://localhost:8390/mcp");
  });
});

// ---------------------------------------------------------------------------
// queryDaemon — SSE parsing + error mapping
// ---------------------------------------------------------------------------

describe("queryDaemon", () => {
  it("parses the SSE data: line into structuredContent.results[]", async () => {
    const { fn, calls } = makeFetch(() => sse(rpcResult(sampleResults)));
    const hits = await queryDaemon(fn, 8390, {
      query: "backup schedule",
      limit: 5,
      mode: "vsearch",
      collections: ["s1"],
    });
    expect(hits).toEqual(sampleResults);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8390/mcp");
  });

  it("sends the required headers (missing Accept → 406 per contract)", async () => {
    const { fn, calls } = makeFetch(() => sse(rpcResult([])));
    await queryDaemon(fn, 8390, {
      query: "x",
      limit: 1,
      mode: "vsearch",
      collections: ["s1"],
    });
    const headers = calls[0].init.headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/json, text/event-stream");
    expect(headers["mcp-protocol-version"]).toBe("2025-03-26");
  });

  it("tolerates keepalive comments and CRLF line endings", async () => {
    const body = ": keepalive\r\n\r\nevent: message\r\ndata: " + JSON.stringify(rpcResult(sampleResults)) + "\r\n\r\n";
    const { fn } = makeFetch(() => new Response(body, { status: 200 }));
    const hits = await queryDaemon(fn, 8390, {
      query: "x",
      limit: 5,
      mode: "vsearch",
      collections: ["s1"],
    });
    expect(hits).toEqual(sampleResults);
  });

  it("accepts a plain-JSON (non-SSE) response body", async () => {
    const { fn } = makeFetch(
      () =>
        new Response(JSON.stringify(rpcResult(sampleResults)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const hits = await queryDaemon(fn, 8390, {
      query: "x",
      limit: 5,
      mode: "vsearch",
      collections: ["s1"],
    });
    expect(hits).toEqual(sampleResults);
  });

  it("empty results → [] (not an error)", async () => {
    const { fn } = makeFetch(() => sse(rpcResult([])));
    const hits = await queryDaemon(fn, 8390, {
      query: "nothing here",
      limit: 5,
      mode: "vsearch",
      collections: ["s1"],
    });
    expect(hits).toEqual([]);
  });

  it("skips malformed entries (non-object, non-numeric score)", async () => {
    const { fn } = makeFetch(() =>
      sse(rpcResult([null, "junk", { score: "high" }, sampleResults[0]])),
    );
    const hits = await queryDaemon(fn, 8390, {
      query: "x",
      limit: 5,
      mode: "vsearch",
      collections: ["s1"],
    });
    expect(hits).toEqual([sampleResults[0]]);
  });

  it("JSON-RPC error → QmdError('daemon-error') with the server message", async () => {
    const { fn } = makeFetch(
      () =>
        sse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "unknown collection 's1'" },
        }),
    );
    await expect(
      queryDaemon(fn, 8390, { query: "x", limit: 5, mode: "vsearch", collections: ["s1"] }),
    ).rejects.toMatchObject({ code: "daemon-error" });
    await expect(
      queryDaemon(fn, 8390, { query: "x", limit: 5, mode: "vsearch", collections: ["s1"] }),
    ).rejects.toThrow(/unknown collection 's1'/);
  });

  it("missing structuredContent.results → QmdError('bad-response')", async () => {
    const { fn } = makeFetch(
      () => sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "No results" }] } }),
    );
    await expect(
      queryDaemon(fn, 8390, { query: "x", limit: 5, mode: "vsearch", collections: ["s1"] }),
    ).rejects.toMatchObject({ code: "bad-response" });
  });

  it("network failure (fetch rejects) → QmdError('daemon-unreachable')", async () => {
    const { fn } = makeFetch(() => {
      throw new Error("fetch failed: connect ECONNREFUSED");
    });
    await expect(
      queryDaemon(fn, 8390, { query: "x", limit: 5, mode: "vsearch", collections: ["s1"] }),
    ).rejects.toMatchObject({ code: "daemon-unreachable" });
  });

  it("timeout (abort) → QmdError('daemon-unreachable') mentioning timeout", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    const { fn } = makeFetch(() => {
      throw err;
    });
    await expect(
      queryDaemon(fn, 8390, { query: "x", limit: 5, mode: "vsearch", collections: ["s1"] }),
    ).rejects.toMatchObject({ code: "daemon-unreachable" });
  });

  it("non-2xx HTTP status → QmdError('daemon-unreachable') with the status", async () => {
    const { fn } = makeFetch(() => new Response("nope", { status: 406 }));
    await expect(
      queryDaemon(fn, 8390, { query: "x", limit: 5, mode: "vsearch", collections: ["s1"] }),
    ).rejects.toMatchObject({ code: "daemon-unreachable" });
  });
});

// ---------------------------------------------------------------------------
// checkHealth
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
  it("200 {status:ok} → true", async () => {
    const { fn } = makeFetch(
      () => new Response(JSON.stringify({ status: "ok", uptime: 12 }), { status: 200 }),
    );
    expect(await checkHealth(fn, 8390)).toBe(true);
  });

  it("non-200 → false (never throws)", async () => {
    const { fn } = makeFetch(() => new Response("bad", { status: 500 }));
    expect(await checkHealth(fn, 8390)).toBe(false);
  });

  it("connection refused → false (never throws)", async () => {
    const { fn } = makeFetch(() => {
      throw new Error("fetch failed");
    });
    expect(await checkHealth(fn, 8390)).toBe(false);
  });
});
