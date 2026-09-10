import { describe, it, expect } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  TRUNCATION_MARKER,
  chunkSpan,
  estimateTokens,
  parseHeader,
  serializeMessages,
  splitTextToBudget,
  type Chunk,
} from "../../src/semantic/chunk";

// ---------------------------------------------------------------------------
// helpers — minimal pi-native message fixtures (only the fields chunk.ts reads)
// ---------------------------------------------------------------------------

let ts = 1_700_000_000_000; // fixed base → deterministic timestamps
const nextTs = () => (ts += 1000);

const user = (text: string): Message =>
  ({ role: "user", content: text, timestamp: nextTs() }) as Message;

const assistantText = (text: string): Message =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: nextTs() }) as Message;

const assistantToolCall = (name: string, args: Record<string, unknown>): Message =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
    timestamp: nextTs(),
  }) as Message;

const toolResult = (
  name: string,
  text: string,
  opts: { isError?: boolean } = {},
): Message =>
  ({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: name,
    content: [{ type: "text", text }],
    isError: opts.isError ?? false,
    timestamp: nextTs(),
  }) as Message;

const bashExecution = (command: string, output: string, exitCode = 0): Message =>
  ({ role: "bashExecution", command, output, exitCode, timestamp: nextTs() }) as any;

const span = (
  messages: Message[],
  opts: { chunkTokens?: number; startSeq?: number } = {},
): Chunk[] =>
  chunkSpan({
    sessionId: "sess-1",
    messages,
    chunkTokens: opts.chunkTokens ?? 1500,
    startSeq: opts.startSeq,
  });

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("0 chars → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is ceil(chars/4)", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });

  it("unicode counts by code units (chars/4, same as report.ts)", () => {
    // "é" is 1 code unit; emoji surrogate pair is 2
    expect(estimateTokens("éééé")).toBe(1);
    expect(estimateTokens("😀".repeat(4))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// chunkSpan — empty / short / long spans
// ---------------------------------------------------------------------------

describe("chunkSpan: empty span", () => {
  it("no messages → []", () => {
    expect(span([])).toEqual([]);
  });

  it("only empty/noise messages → [] (no zero-byte chunks)", () => {
    const msgs: Message[] = [
      user("   "),
      ({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: nextTs() }) as Message,
      toolResult("read", ""),
    ];
    expect(span(msgs)).toEqual([]);
  });
});

describe("chunkSpan: short span", () => {
  it("exactly 1 chunk for a small span", () => {
    const chunks = span([
      user("fix the bug in main.ts"),
      assistantText("Let me look."),
      assistantToolCall("read", { path: "/repo/main.ts" }),
      toolResult("read", "const x = 1;"),
      assistantText("Fixed."),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].seq).toBe(1);
    expect(chunks[0].text).toContain("[user] fix the bug in main.ts");
  });
});

describe("chunkSpan: long span / message-boundary packing", () => {
  it("chunks stay ≤ chunkTokens (estimator)", () => {
    const big = "word ".repeat(400); // ~2000 chars ≈ 500 tokens per message
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) msgs.push(assistantText(big));
    const chunks = span(msgs, { chunkTokens: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(1000);
    }
  });

  it("never splits a message across chunks", () => {
    const body = "line ".repeat(199) + "line"; // 995 chars ≈ 249 tokens, trim-safe
    const msgs: Message[] = [
      user("start"),
      assistantText(body),
      assistantText(body),
      assistantText(body),
      assistantText(body),
    ];
    const chunks = span(msgs, { chunkTokens: 400 });
    // each message appears whole in exactly one chunk
    for (const c of chunks) {
      expect(c.text.split(body).length - 1).toBeLessThanOrEqual(1);
    }
    const all = chunks.map((c) => c.text).join("\n");
    expect(all.split(body).length - 1).toBe(4);
  });

  it("oversized single message is split, with …[truncated] marker on hard cuts", () => {
    const huge = "x".repeat(20_000); // 5000 tokens, one line, no paragraph breaks
    const chunks = span([user(huge)], { chunkTokens: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(500);
    }
    expect(chunks.some((c) => c.text.includes(TRUNCATION_MARKER))).toBe(true);
    // every sub-line keeps the role prefix
    for (const line of chunks.flatMap((c) => c.text.split("\n"))) {
      expect(line).toMatch(/^\[user\] /);
    }
  });

  it("oversized message prefers paragraph boundaries (no marker needed)", () => {
    const para = "p ".repeat(400); // 800 chars = 200 tokens per paragraph
    const text = [para, para, para, para].join("\n\n");
    const chunks = span([user(text)], { chunkTokens: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(500);
      expect(c.text).not.toContain(TRUNCATION_MARKER);
    }
  });

  it("oversized message prefers line boundaries before hard cut", () => {
    const line = "l".repeat(1500); // 375 tokens per line
    const text = [line, line, line].join("\n");
    const chunks = span([user(text)], { chunkTokens: 500 });
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(500);
    }
    expect(chunks.flatMap((c) => c.text).join("\n")).not.toContain(TRUNCATION_MARKER);
  });

  it("sub-lines of one oversized message are not mixed with other messages", () => {
    const huge = "y".repeat(20_000);
    const chunks = span([user("hello"), user(huge), user("bye")], { chunkTokens: 500 });
    // "hello" alone in chunk 1, huge fills the middle, "bye" last
    expect(chunks[0].text).toBe("[user] hello");
    expect(chunks[chunks.length - 1].text).toBe("[user] bye");
  });
});

// ---------------------------------------------------------------------------
// serialization format
// ---------------------------------------------------------------------------

describe("serializeMessages", () => {
  it("user string content → [user] line", () => {
    expect(serializeMessages([user("hello world")])).toEqual(["[user] hello world"]);
  });

  it("user content array: text parts + image placeholders", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: nextTs(),
    } as Message;
    expect(serializeMessages([msg])).toEqual([
      "[user] look",
      "[user] [image:image/png]",
    ]);
  });

  it("assistant text → [assistant] line; thinking blocks omitted", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "the answer" },
      ],
      timestamp: nextTs(),
    } as Message;
    expect(serializeMessages([msg])).toEqual(["[assistant] the answer"]);
  });

  it("assistant toolCall → [tool: <name>] with file/path/cmd line, truncated 200ch", () => {
    const msgs: Message[] = [
      assistantToolCall("read", { path: "/repo/src/a.ts" }),
      assistantToolCall("bash", { command: "ls -la /very/long/path/".repeat(20) }),
      assistantToolCall("search", { query: "compaction" }),
      assistantToolCall("noop", {}),
    ];
    const longCmd = "ls -la /very/long/path/".repeat(20); // 210 chars
    const lines = serializeMessages(msgs);
    expect(lines[0]).toBe("[tool: read] path=/repo/src/a.ts");
    expect(lines[1]).toBe(`[tool: bash] command=${longCmd.slice(0, 200)}`);
    expect(lines[2]).toBe("[tool: search] query=compaction");
    expect(lines[3]).toBe("[tool: noop]");
  });

  it("toolResult → [tool_result:<name>] truncated 2000ch; isError → [ERROR] prefix", () => {
    const big = "r".repeat(5000);
    const lines = serializeMessages([
      toolResult("read", big),
      toolResult("bash", "boom", { isError: true }),
    ]);
    expect(lines[0].startsWith("[tool_result:read] ")).toBe(true);
    expect(lines[0].length).toBeLessThanOrEqual("[tool_result:read] ".length + 2000);
    expect(lines[1]).toBe("[tool_result:bash] [ERROR] boom");
  });

  it("multi-line text collapses to a single line per part", () => {
    const lines = serializeMessages([user("a\nb\r\nc")]);
    expect(lines).toEqual(["[user] a b c"]);
  });

  it("bashExecution → [bash] command line + [tool_result:bash] output", () => {
    const lines = serializeMessages([bashExecution("make test", "ok\n1 passed", 0)]);
    expect(lines[0]).toBe("[bash] make test");
    expect(lines[1]).toBe("[tool_result:bash] ok 1 passed");
  });

  it("bashExecution with non-zero exit → [ERROR] prefix on output", () => {
    const lines = serializeMessages([bashExecution("make test", "FAIL: 1", 1)]);
    expect(lines[1]).toBe("[tool_result:bash] [ERROR] FAIL: 1");
  });

  it("empty parts produce no lines", () => {
    expect(serializeMessages([user(""), toolResult("read", "")])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// header format + metadata
// ---------------------------------------------------------------------------

describe("chunk header", () => {
  it("is stable and parseable: <!-- pi-semantic session=.. seq=.. turn=.. ts=.. files=.. -->", () => {
    const chunks = span([
      user("read the file"),
      assistantToolCall("read", { path: "/repo/a.ts" }),
      toolResult("read", "content"),
    ]);
    expect(chunks).toHaveLength(1);
    const h = chunks[0].header;
    expect(h).toMatch(
      /^<!-- pi-semantic session=sess-1 seq=1 turn=1 ts=\S+ files=\/repo\/a\.ts -->$/,
    );
    const parsed = parseHeader(h);
    expect(parsed).toEqual({
      session: "sess-1",
      seq: 1,
      turn: 1,
      ts: chunks[0].timestamp,
      files: ["/repo/a.ts"],
    });
  });

  it("sanitizes the session id in the header", () => {
    const chunks = chunkSpan({
      sessionId: "a/b..c",
      messages: [user("hi")],
      chunkTokens: 1500,
    });
    expect(chunks[0].header).toContain("session=a_b_c ");
  });

  it("files= is the union of tool-call file paths, first-seen order, capped at 10", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `/repo/f${i}.ts`);
    const msgs: Message[] = paths.map((p) => assistantToolCall("read", { path: p }));
    // duplicate of an earlier path must not reappear
    msgs.push(assistantToolCall("read", { path: paths[0] }));
    const chunks = span(msgs);
    expect(chunks[0].filesTouched.length).toBe(10);
    expect(chunks[0].filesTouched).toEqual(paths.slice(0, 10));
    expect(chunks[0].header).toContain(`files=${paths.slice(0, 10).join(",")}`);
  });

  it("empty files list → files= (parseable, no trailing junk)", () => {
    const chunks = span([user("just talking")]);
    expect(chunks[0].filesTouched).toEqual([]);
    expect(chunks[0].header).toMatch(/files= -->$/);
  });

  it("commas inside file paths are escaped in the header", () => {
    const chunks = span([
      assistantToolCall("read", { path: "/repo/a,b.ts" }),
      toolResult("read", "ok"),
    ]);
    const parsed = parseHeader(chunks[0].header);
    expect(parsed.files).toEqual(["/repo/a,b.ts"]);
  });
});

describe("chunk metadata", () => {
  it("seq continues from startSeq across compactions", () => {
    const big = "w ".repeat(400);
    const msgs: Message[] = [];
    for (let i = 0; i < 8; i++) msgs.push(assistantText(big));
    const chunks = span(msgs, { chunkTokens: 500, startSeq: 42 });
    expect(chunks.map((c) => c.seq)).toEqual([42, 43, 44, 45]);
  });

  it("turn = count of user messages up to the chunk's first message", () => {
    // 1986 chars → line = 1998 chars = exactly 500 tokens → one assistant per chunk
    const big = "w ".repeat(993);
    const msgs: Message[] = [
      user("question one"),
      assistantText(big),
      user("question two"),
      assistantText(big),
      assistantText(big),
      assistantText(big),
    ];
    const chunks = span(msgs, { chunkTokens: 500 });
    expect(chunks.map((c) => c.turn)).toEqual([1, 1, 2, 2, 2, 2]);
  });

  it("timestamp is the ISO of the chunk's first message", () => {
    const t = 1_700_000_000_000;
    const msgs: Message[] = [
      ({ role: "user", content: "hi", timestamp: t }) as Message,
    ];
    const chunks = span(msgs);
    expect(chunks[0].timestamp).toBe(new Date(t).toISOString());
  });

  it("missing/invalid timestamp → 'unknown' (deterministic)", () => {
    const msgs: Message[] = [{ role: "user", content: "hi" } as any];
    const chunks = span(msgs);
    expect(chunks[0].timestamp).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same input → byte-identical output (run twice, diff)", () => {
    const big = "payload ".repeat(300);
    const make = (): Message[] => {
      // fixed timestamps (independent of the shared nextTs() counter)
      const t = (i: number) => 1_700_000_000_000 + i * 1000;
      const mk = (m: Message, i: number) => ({ ...m, timestamp: t(i) });
      return [
        mk({ role: "user", content: "task: " + "z".repeat(100) } as any, 0),
        mk({ role: "assistant", content: [{ type: "text", text: big }] } as any, 1),
        mk({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/repo/one.ts" } }] } as any, 2),
        mk({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "data " + "d".repeat(3000) }], isError: false } as any, 3),
        mk({ role: "user", content: "second question" } as any, 4),
        mk({ role: "assistant", content: [{ type: "text", text: big }] } as any, 5),
        mk({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] } as any, 6),
        mk({ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "passed" }], isError: false } as any, 7),
      ];
    };
    const a = span(make(), { chunkTokens: 800, startSeq: 7 });
    const b = span(make(), { chunkTokens: 800, startSeq: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (let i = 0; i < a.length; i++) {
      expect(a[i].text).toBe(b[i].text);
      expect(a[i].header).toBe(b[i].header);
    }
  });
});

// ---------------------------------------------------------------------------
// splitTextToBudget (estimator edge cases)
// ---------------------------------------------------------------------------

describe("splitTextToBudget", () => {
  it("empty text → []", () => {
    expect(splitTextToBudget("", 100)).toEqual([]);
  });

  it("text within budget → single piece, unmodified", () => {
    expect(splitTextToBudget("hello\nworld", 100)).toEqual(["hello\nworld"]);
  });

  it("splits on paragraphs first, preserving order", () => {
    const para = "a".repeat(400); // 100 tokens
    const text = [para, para, para].join("\n\n");
    const pieces = splitTextToBudget(text, 150);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toBe(para);
  });

  it("very long single line → hard cuts with marker on all but the last piece", () => {
    const line = "b".repeat(4000); // 1000 tokens
    const pieces = splitTextToBudget(line, 100); // 400 chars budget
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces.slice(0, -1)) {
      expect(p.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(Math.ceil(p.length / 4)).toBeLessThanOrEqual(100);
    }
    // last piece has no marker and the pieces reassemble to the original
    expect(pieces[pieces.length - 1].endsWith(TRUNCATION_MARKER)).toBe(false);
    expect(pieces.map((p) => p.replace(TRUNCATION_MARKER, "")).join("")).toBe(line);
  });

  it("hard cuts never split a surrogate pair", () => {
    // first cut (388 code units) lands inside the emoji unless adjusted
    const text = "a".repeat(387) + "😀" + "b".repeat(2000);
    const pieces = splitTextToBudget(text, 100);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((p) => p.replace(TRUNCATION_MARKER, "")).join("")).toBe(text);
    for (const p of pieces) {
      expect(Math.ceil(p.length / 4)).toBeLessThanOrEqual(100);
    }
  });
});
