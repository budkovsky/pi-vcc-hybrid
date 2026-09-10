/**
 * Pure message → chunk logic for the semantic layer.
 *
 * Input: the trimmed span as pi-native messages (the same shape
 * `normalize()` in the VCC core handles: user / assistant / toolResult,
 * plus the synthetic bashExecution role). Output: `Chunk[]` ready to be
 * written to disk by the indexer (Phase 5) as `NNNN.md` = header + text.
 *
 * Guarantees (pinned by tests/semantic/chunk.test.ts):
 *  - empty span → [] (no zero-byte files)
 *  - chunks stay ≤ chunkTokens (estimator: chars/4, same as VCC report.ts)
 *  - boundaries on message boundaries; an oversized message is split on
 *    paragraph → line → hard-cut (`…[truncated]` marker) and is never
 *    mixed with other messages inside a chunk
 *  - one line per role prefix (multi-line text collapses to spaces)
 *  - header: `<!-- pi-semantic session=<id> seq=<n> turn=<t> ts=<iso> files=<a,b,c> -->`
 *  - deterministic: same input → byte-identical output
 */
import type { Message } from "@earendil-works/pi-ai";
import { sanitizeSessionId } from "./paths";

/** Marker appended to hard-cut pieces of an oversized message. */
export const TRUNCATION_MARKER = "…[truncated]";

/** Max chars for a tool-call args line (path/cmd/query). */
const TOOL_ARGS_MAX = 200;
/** Max chars for a tool-result text line. */
const TOOL_RESULT_MAX = 2000;
/** Cap on filesTouched per chunk. */
const FILES_CAP = 10;

/**
 * A chunk of the trimmed span. Written to disk as `NNNN.md`
 * (NNNN = seq zero-padded 4) with content `header + "\n\n" + text`.
 */
export interface Chunk {
  /** 1-based; continues across compactions (indexer passes startSeq). */
  seq: number;
  /** Count of user messages up to (and including) the chunk's first message. */
  turn: number;
  /** ISO timestamp of the chunk's first message ("unknown" if absent). */
  timestamp: string;
  /** Union of file paths from tool calls in the chunk, capped at 10. */
  filesTouched: string[];
  /** Serialized messages: one line per role prefix. */
  text: string;
  /** `<!-- pi-semantic session=… seq=… turn=… ts=… files=… -->` */
  header: string;
}

export interface ChunkSpanInput {
  sessionId: string;
  messages: Message[];
  /** Target chunk size in estimated tokens (chars/4). */
  chunkTokens: number;
  /** seq of the first chunk in this span (continues across compactions). Default 1. */
  startSeq?: number;
}

/** Token estimate: chars/4, same convention as VCC `report.ts`. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Don't cut between the two code units of a surrogate pair. */
const safeCutPos = (text: string, pos: number): number => {
  if (pos <= 0 || pos >= text.length) return pos;
  const code = text.charCodeAt(pos);
  if (code >= 0xdc00 && code <= 0xdfff) return pos - 1; // low surrogate
  return pos;
};

const collapse = (text: string): string => text.replace(/\r?\n/g, " ").trim();

/**
 * Split text into pieces each ≤ `budgetChars` (code units), preferring
 * paragraph boundaries (\n\n), then line boundaries (\n), then hard cuts
 * (marker on every piece except the last). Pieces reassemble (minus
 * markers) to the original text.
 */
function splitToBudgetChars(text: string, budgetChars: number): string[] {
  if (!text) return [];
  if (text.length <= budgetChars) return [text];
  const cutLen = Math.max(budgetChars - TRUNCATION_MARKER.length, 1);
  const out: string[] = [];
  const hardCut = (line: string): void => {
    let rest = line;
    while (rest.length > cutLen) {
      const pos = safeCutPos(rest, cutLen);
      out.push(rest.slice(0, pos) + TRUNCATION_MARKER);
      rest = rest.slice(pos);
    }
    if (rest) out.push(rest);
  };
  for (const paragraph of text.split("\n\n")) {
    if (paragraph.length <= budgetChars) {
      out.push(paragraph);
    } else {
      for (const line of paragraph.split("\n")) {
        if (line.length <= budgetChars) out.push(line);
        else hardCut(line);
      }
    }
  }
  return out;
}

/** Public char-budget wrapper: tokens → chars (chars/4 convention). */
export function splitTextToBudget(text: string, chunkTokens: number): string[] {
  return splitToBudgetChars(text, Math.max(chunkTokens * 4, 1));
}

// ---------------------------------------------------------------------------
// serialization (message → one line per role prefix)
// ---------------------------------------------------------------------------

const FILE_ARG_KEYS = ["path", "file_path", "filePath", "file"] as const;

/** "file/path/cmd line" for a tool call: path=…, command=…, query=…, or key list. */
const summarizeToolArgs = (args: unknown): string => {
  if (typeof args === "string") return args.slice(0, TOOL_ARGS_MAX);
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const key of FILE_ARG_KEYS) {
    if (typeof rec[key] === "string" && (rec[key] as string).trim()) {
      return `path=${(rec[key] as string).slice(0, TOOL_ARGS_MAX)}`;
    }
  }
  if (typeof rec.command === "string") {
    return `command=${(rec.command as string).slice(0, TOOL_ARGS_MAX)}`;
  }
  if (typeof rec.query === "string") {
    return `query=${(rec.query as string).slice(0, TOOL_ARGS_MAX)}`;
  }
  return Object.keys(rec).join(", ");
};

/** File paths worth recording in filesTouched, from one tool call's args. */
const filePathsOfArgs = (args: unknown): string[] => {
  if (!args || typeof args !== "object") return [];
  const rec = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of FILE_ARG_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return out;
};

interface Part {
  prefix: string;
  /** Raw text (may contain newlines); collapsed at line-formation time. */
  text: string;
  /** Emit a line even when text is empty (the call itself is the fact). */
  always?: boolean;
}

const imagePlaceholder = (mimeType: unknown): string =>
  `[image:${typeof mimeType === "string" && mimeType ? mimeType : "image"}]`;

/**
 * One message → serialized parts (raw, uncollapsed). Thinking blocks are
 * omitted (noise for recall). Returns [] for messages with no recallable
 * content.
 */
function messageParts(msg: Message): Part[] {
  const m = msg as any;
  const parts: Part[] = [];
  const role = m?.role;

  if (role === "user") {
    const content = m.content;
    if (typeof content === "string") {
      parts.push({ prefix: "[user] ", text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          parts.push({ prefix: "[user] ", text: part.text });
        } else if (part?.type === "image") {
          parts.push({ prefix: "[user] ", text: imagePlaceholder(part.mimeType) });
        }
      }
    }
    return parts;
  }

  if (role === "assistant") {
    const content = m.content;
    if (typeof content === "string") {
      parts.push({ prefix: "[assistant] ", text: content });
      return parts;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          parts.push({ prefix: "[assistant] ", text: part.text });
        } else if (part?.type === "toolCall") {
          parts.push({
            prefix: `[tool: ${part.name ?? "unknown"}] `,
            text: summarizeToolArgs(part.arguments),
            always: true,
          });
        }
        // thinking: omitted by design
      }
    }
    return parts;
  }

  if (role === "toolResult") {
    const content = m.content;
    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((p: any) =>
          p?.type === "text" && typeof p.text === "string"
            ? p.text
            : p?.type === "image"
              ? imagePlaceholder(p.mimeType)
              : "",
        )
        .join(" ");
    } else {
      text = "";
    }
    if (m.isError) text = `[ERROR] ${text}`;
    parts.push({
      prefix: `[tool_result:${m.toolName ?? "unknown"}] `,
      text: text.slice(0, TOOL_RESULT_MAX),
    });
    return parts;
  }

  if (role === "bashExecution") {
    if (typeof m.command === "string" && m.command.trim()) {
      parts.push({ prefix: "[bash] ", text: m.command.slice(0, TOOL_ARGS_MAX) });
    }
    if (typeof m.output === "string" && m.output.trim()) {
      const exitCode = m.exitCode;
      const err = typeof exitCode === "number" && exitCode !== 0;
      parts.push({
        prefix: "[tool_result:bash] ",
        text: `${err ? "[ERROR] " : ""}${m.output}`.slice(0, TOOL_RESULT_MAX),
      });
    }
    return parts;
  }

  return [];
}

/**
 * Serialize messages to lines (one line per role prefix, newlines
 * collapsed). Exported for tests; chunkSpan uses the same parts with
 * oversized-part splitting.
 */
const lineOf = (part: Part): string | null => {
  const text = collapse(part.text);
  if (!text) return part.always ? part.prefix.trimEnd() : null;
  return part.prefix + text;
};

export function serializeMessages(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    for (const part of messageParts(msg)) {
      const line = lineOf(part);
      if (line !== null) lines.push(line);
    }
  }
  return lines;
}

/**
 * Lines for one message, with oversized parts split so every line is
 * ≤ chunkTokens (estimator). Splits on the raw text (paragraph → line →
 * hard-cut) before collapsing.
 */
function messageLines(msg: Message, chunkTokens: number): string[] {
  const lines: string[] = [];
  for (const part of messageParts(msg)) {
    const budgetChars = Math.max(chunkTokens * 4 - part.prefix.length, 1);
    if (part.text.length <= budgetChars) {
      const line = lineOf(part);
      if (line !== null) lines.push(line);
      continue;
    }
    for (const piece of splitToBudgetChars(part.text, budgetChars)) {
      const text = collapse(piece);
      if (text) lines.push(part.prefix + text);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

const HEADER_RE =
  /^<!-- pi-semantic session=(\S+) seq=(\d+) turn=(\d+) ts=(\S+) files=(.*?) -->$/;

/** Parse a chunk header back into its fields (inverse of buildHeader). */
export function parseHeader(
  header: string,
): { session: string; seq: number; turn: number; ts: string; files: string[] } | null {
  const m = header.match(HEADER_RE);
  if (!m) return null;
  return {
    session: m[1],
    seq: Number(m[2]),
    turn: Number(m[3]),
    ts: m[4],
    files: m[5] ? m[5].split(",").map((f) => f.replace(/;/g, ",")) : [],
  };
}

const isoOf = (msg: Message): string => {
  const t = (msg as any)?.timestamp;
  return typeof t === "number" && Number.isFinite(t)
    ? new Date(t).toISOString()
    : "unknown";
};

// ---------------------------------------------------------------------------
// chunkSpan
// ---------------------------------------------------------------------------

interface PackedItem {
  lines: string[];
  turn: number;
  timestamp: string;
  files: string[];
}

/** Token cost of a chunk's text (join newlines included). */
const chunkTokensOf = (lines: string[]): number =>
  estimateTokens(lines.join("\n"));

/**
 * Chunk a trimmed span. Pure + deterministic: same input → byte-identical
 * output. seq numbering starts at `startSeq` (indexer continues it across
 * compactions via meta.json).
 */
export function chunkSpan(input: ChunkSpanInput): Chunk[] {
  const { sessionId, messages, chunkTokens } = input;
  const startSeq = input.startSeq ?? 1;
  const session = sanitizeSessionId(sessionId);

  // 1. serialize + per-message metadata
  const items: PackedItem[] = [];
  let turn = 0;
  for (const msg of messages) {
    if ((msg as any)?.role === "user") turn++;
    const lines = messageLines(msg, chunkTokens);
    if (lines.length === 0) continue;
    items.push({
      lines,
      turn,
      timestamp: isoOf(msg),
      files: filesOfMessage(msg),
    });
  }

  if (items.length === 0) return [];

  // 2. pack (message boundaries; oversized items get their own chunks)
  const chunks: Chunk[] = [];
  const finish = (sub: PackedItem): Chunk => {
    const filesTouched = sub.files.slice(0, FILES_CAP);
    const text = sub.lines.join("\n");
    const seq = startSeq + chunks.length;
    return {
      seq,
      turn: sub.turn,
      timestamp: sub.timestamp,
      filesTouched,
      text,
      header: buildHeader(session, seq, sub.turn, sub.timestamp, filesTouched),
    };
  };

  let cur: PackedItem | null = null;
  const flush = (): void => {
    if (!cur) return;
    chunks.push(finish(cur));
    cur = null;
  };
  const fits = (lines: string[], more: string[]): boolean =>
    chunkTokensOf([...lines, ...more]) <= chunkTokens;
  const addFiles = (target: string[], src: string[]): void => {
    for (const f of src) if (!target.includes(f)) target.push(f);
  };

  for (const item of items) {
    if (chunkTokensOf(item.lines) > chunkTokens) {
      // oversized: own chunk(s), never mixed with other messages
      flush();
      const newSub = (): PackedItem => {
        const sub: PackedItem = {
          lines: [],
          turn: item.turn,
          timestamp: item.timestamp,
          files: [],
        };
        addFiles(sub.files, item.files);
        return sub;
      };
      let sub = newSub();
      for (const line of item.lines) {
        if (sub.lines.length > 0 && !fits(sub.lines, [line])) {
          chunks.push(finish(sub));
          sub = newSub();
        }
        sub.lines.push(line);
      }
      chunks.push(finish(sub));
      continue;
    }
    if (cur && !fits(cur.lines, item.lines)) flush();
    if (!cur) {
      cur = {
        lines: [],
        turn: item.turn,
        timestamp: item.timestamp,
        files: [],
      };
    }
    cur.lines.push(...item.lines);
    addFiles(cur.files, item.files);
  }
  flush();

  return chunks;
}

/** File paths from a message's tool calls (path=/file args only). */
function filesOfMessage(msg: Message): string[] {
  const out: string[] = [];
  for (const part of messageParts(msg)) {
    if (part.prefix.startsWith("[tool: ") && part.text.startsWith("path=")) {
      out.push(part.text.slice(5));
    }
  }
  return out;
}

function buildHeader(
  session: string,
  seq: number,
  turn: number,
  ts: string,
  filesTouched: string[],
): string {
  // commas in paths would break the comma-list → escape as ';' (reversed in parseHeader)
  const files = filesTouched.map((f) => f.replace(/,/g, ";")).join(",");
  return `<!-- pi-semantic session=${session} seq=${seq} turn=${turn} ts=${ts} files=${files} -->`;
}
