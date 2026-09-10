/**
 * semantic_recall shaping + formatting (Phase 4).
 *
 * Turns raw daemon hits (QmdRawHit[]) into model-facing Hits:
 *   - seq from the hit's file name (NNNN.md, zero-padded 4)
 *   - full chunk text: read the local chunk file (header + text);
 *     fallback: the daemon snippet (line numbers + hunk header stripped)
 *   - provenance "turn <t>, <iso>" parsed from the chunk header
 *
 * Pure except `shapeHitsFromDisk` (one readFile per distinct seq; a missing
 * file degrades to the snippet fallback — degraded, never broken).
 *
 * Output format (plan §0c):
 *   success: "# N hit(s) for \"<query>\"\n\n## [1] turn 42, <iso> (score 0.81)\n<text>…"
 *   empty:   friendly "index catching up" message — never an error object.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { parseHeader } from "./chunk";
import type { QmdRawHit } from "./qmd-daemon";

export interface Hit {
  /** Chunk sequence (from NNNN.md); null when the file name is unparseable. */
  seq: number | null;
  /** Raw daemon file field ("<collection>/NNNN.md"). */
  file: string;
  /** 0..1, normalized by the daemon (top hit = 1). */
  score: number;
  /** Full chunk text (or snippet fallback). */
  text: string;
  /** "turn <t>, <iso>" from the chunk header (or "unknown"). */
  provenance: string;
}

/**
 * Extract the chunk sequence from a daemon file field.
 * "s1/0003.md" → 3; "qmd://s1/0003.md?index=x" → 3; anything else → null.
 */
export function seqOf(file: string): number | null {
  if (typeof file !== "string" || !file) return null;
  const seg = file.split("/").pop() ?? "";
  const name = seg.split("?")[0];
  const m = name.match(/^0*(\d+)\.md$/);
  return m ? Number(m[1]) : null;
}

/** "turn <t>, <iso>" from the chunk header; "unknown" when absent/malformed. */
export function provenanceOf(chunkContent: string | null): string {
  if (!chunkContent) return "unknown";
  const firstLine = chunkContent.split("\n", 1)[0];
  const p = parseHeader(firstLine);
  return p ? `turn ${p.turn}, ${p.ts}` : "unknown";
}

/** Strip "N: " line prefixes and "@@ … @@" hunk headers from a snippet. */
function snippetToText(snippet: string): string {
  const lines = snippet
    .split("\n")
    .map((l) => l.replace(/^\s*\d+:\s?/, ""))
    .filter((l) => !/^@@.*@@/.test(l));
  return lines.join("\n").trim();
}

/**
 * Hit text: the chunk file's body (after the header line) when available,
 * otherwise the daemon snippet (cleaned), otherwise "".
 */
export function textOf(chunkContent: string | null, snippet: string): string {
  if (chunkContent) {
    const body = chunkContent.slice(firstNewline(chunkContent));
    if (body.trim()) return body.trim();
  }
  return snippetToText(snippet ?? "");
}

const firstNewline = (s: string): number => {
  const i = s.indexOf("\n");
  return i === -1 ? s.length : i + 1;
};

/** Shape one raw hit; `chunkContent` = the local NNNN.md content or null. */
export function shapeHit(raw: QmdRawHit, chunkContent: string | null): Hit {
  return {
    seq: seqOf(raw.file),
    file: raw.file,
    score: raw.score,
    text: textOf(chunkContent, raw.snippet ?? ""),
    provenance: provenanceOf(chunkContent),
  };
}

/**
 * Shape raw hits into Hits, capped at `limit` (daemon order preserved —
 * already ranked). `contentBySeq` maps seq → chunk-file content (null =
 * missing → snippet fallback).
 */
export function shapeHits(
  raw: QmdRawHit[],
  contentBySeq: ReadonlyMap<number, string | null>,
  limit: number,
): Hit[] {
  const out: Hit[] = [];
  for (const r of raw) {
    if (out.length >= limit) break;
    const seq = seqOf(r.file);
    const content = seq === null ? null : contentBySeq.get(seq) ?? null;
    out.push(shapeHit(r, content));
  }
  return out;
}

/** readChunk: (dir, seq) → NNNN.md content, or null when unreadable. */
export type ReadChunkFn = (dir: string, seq: number) => Promise<string | null>;

const fsReadChunk: ReadChunkFn = async (dir, seq) => {
  try {
    return await readFile(join(dir, `${String(seq).padStart(4, "0")}.md`), "utf-8");
  } catch {
    return null;
  }
};

/**
 * Shape raw hits, reading each hit's chunk file from `dir` (the session's
 * chunk dir). One read per distinct seq; missing files → snippet fallback.
 */
export async function shapeHitsFromDisk(
  raw: QmdRawHit[],
  dir: string,
  limit: number,
  readChunk: ReadChunkFn = fsReadChunk,
): Promise<Hit[]> {
  const bySeq = new Map<number, string | null>();
  for (const r of raw) {
    const seq = seqOf(r.file);
    if (seq === null || bySeq.has(seq)) continue;
    bySeq.set(seq, await readChunk(dir, seq));
  }
  return shapeHits(raw, bySeq, limit);
}

/** Pinned success format (plan §0c). */
export function formatHits(hits: Hit[], query: string): string {
  if (hits.length === 0) return emptyResult(query);
  const parts: string[] = [`# ${hits.length} hit(s) for "${query}"`];
  hits.forEach((h, i) => {
    parts.push(`## [${i + 1}] ${h.provenance} (score ${h.score.toFixed(2)})\n${h.text}`);
  });
  return parts.join("\n\n");
}

/** Pinned empty-result message (degraded, not broken). */
export function emptyResult(query: string): string {
  return `No indexed content matched "${query}" (index may still be catching up; try vcc_recall for exact terms).`;
}

/** Friendly degradation when the search itself failed. */
export function unavailableResult(query: string, reason: string): string {
  return `semantic_recall unavailable for "${query}": ${reason}. Try vcc_recall for exact terms.`;
}
