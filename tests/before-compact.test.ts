import { describe, test, expect } from "bun:test";
import { buildOwnCut } from "../src/hooks/before-compact";

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

const comp = (id: string, firstKeptEntryId?: string) => ({
  id,
  type: "compaction",
  firstKeptEntryId,
});

describe("buildOwnCut", () => {
  test("no prior compaction: cuts at last user message", () => {
    const r = buildOwnCut([
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
    expect(r.compactAll).toBe(false);
  });

  test("cancels with too_few_live_messages when liveMessages <= 2", () => {
    const r = buildOwnCut([
      comp("c1", "m1"),
      msg("m1", "user", "x"),
      msg("m2", "assistant", "y"),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_few_live_messages");
  });

  test("orphan firstKeptEntryId triggers recovery (collect after compaction)", () => {
    // Prev compaction set firstKeptEntryId to a non-existent id (e.g. "" sentinel
    // from a previous compact-all). Recovery should collect msgs after compaction.
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      msg("old2", "assistant", "old"),
      comp("c1", "ORPHAN_ID"),
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("resumes from firstKeptEntryId after prior compaction", () => {
    const r = buildOwnCut([
      msg("old1", "user", "old"),
      msg("old2", "assistant", "old"),
      comp("c1", "m1"),
      msg("m1", "user", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "user", "c"),
      msg("m4", "assistant", "d"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firstKeptEntryId).toBe("m3");
    expect(r.messages).toHaveLength(2);
  });

  test("single user prompt + autonomous tail: compact all", () => {
    // The Discord scenario: user types 1 prompt, agent runs autonomously
    // (assistant + toolResult interleaved). No user > idx 0.
    const r = buildOwnCut([
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "more"),
      msg("m5", "toolResult", "result2"),
      msg("m6", "assistant", "done"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(6);
  });

  test("no user message: compact-all instead of cancelling", () => {
    // When there are enough live messages but none are from the user
    // (e.g., long assistant/tool chain), compact all rather than
    // cancelling and leaving the session unrecoverable.
    const r = buildOwnCut([
      msg("m1", "assistant", "a"),
      msg("m2", "assistant", "b"),
      msg("m3", "assistant", "c"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.messages).toHaveLength(3);
  });

  test("compact-all then more chat: orphan recovery + normal cut", () => {
    // After a compact-all (firstKeptEntryId=""), user chats more turns,
    // next compaction should orphan-recover and find multiple users.
    const r = buildOwnCut([
      msg("o1", "user", "old"),
      msg("o2", "assistant", "old"),
      comp("c1", ""), // sentinel from prior compact-all
      msg("u1", "user", "new1"),
      msg("a1", "assistant", "reply1"),
      msg("u2", "user", "new2"),
      msg("a2", "assistant", "reply2"),
      msg("u3", "user", "new3"),
      msg("a3", "assistant", "reply3"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u3");
    expect(r.messages).toHaveLength(4); // u1, a1, u2, a2
  });

  test("compact-all then single user msg + autonomous: compact all again", () => {
    const r = buildOwnCut([
      msg("o1", "user", "old"),
      comp("c1", ""),
      msg("u1", "user", "okay"),
      msg("a1", "assistant", "x"),
      msg("t1", "toolResult", "y"),
      msg("a2", "assistant", "z"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
  });

  test("matched tool calls do NOT push cut back to previous user", () => {
    // Regression: toolResult messages carry toolCallId at the message level,
    // not as a content part. The old code looked for part.type==="toolResult"
    // in content (which never matches), causing every toolCall to appear
    // "unmatched" and pushing the cut back one user turn.
    const r = buildOwnCut([
      msg("u1", "user", "first prompt"),
      msg("a1", "assistant", [{ type: "text", text: "let me check" }, { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "foo.ts" } }]),
      { id: "t1", type: "message", message: { role: "toolResult", toolCallId: "tc_1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false } },
      msg("u2", "user", "second prompt"),
      msg("a2", "assistant", [{ type: "text", text: "done" }]),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Cut should be at u2 (second user) since tc_1 has a matching toolResult
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u2");
    expect(r.messages).toHaveLength(3); // u1, a1, t1
  });

  test("unmatched tool call still pushes cut back", () => {
    // When a toolCall genuinely has no toolResult, the cut should still
    // push back to keep the in-progress turn in the tail.
    const r = buildOwnCut([
      msg("u1", "user", "first prompt"),
      msg("a1", "assistant", "response 1"),
      msg("u2", "user", "second prompt"),
      msg("a2", "assistant", "response 2"),
      msg("u3", "user", "third prompt"),
      msg("a3", "assistant", [{ type: "text", text: "checking" }, { type: "toolCall", id: "tc_unmatched", name: "bash", arguments: { command: "ls" } }]),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // tc_unmatched has no toolResult → push cut back from u3 to u2
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u2");
  });

  test("Anthropic-style session: many matched toolCalls should not cause compact-all", () => {
    // Simulates the real Anthropic pattern: 2 user messages with many matched
    // toolCall/toolResult pairs between them. The bug caused all toolCalls to
    // appear "unmatched" → cut pushed back to first user → compact-all.
    const entries: any[] = [
      msg("u1", "user", "help me find bugs"),
    ];
    // Add 5 matched tool cycles (assistant with toolCall + toolResult)
    for (let i = 1; i <= 5; i++) {
      entries.push({ id: `a${i}`, type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: `thinking ${i}` },
        { type: "toolCall", id: `tc_${i}`, name: "read", arguments: { path: `file${i}.ts` } },
      ] } });
      entries.push({ id: `t${i}`, type: "message", message: { role: "toolResult", toolCallId: `tc_${i}`, toolName: "read", content: [{ type: "text", text: `file ${i} contents` }], isError: false } });
    }
    // Second user message
    entries.push(msg("u2", "user", "now fix the bug"));
    // More matched tool cycles after second user
    for (let i = 6; i <= 8; i++) {
      entries.push({ id: `a${i}`, type: "message", message: { role: "assistant", content: [
        { type: "toolCall", id: `tc_${i}`, name: "edit", arguments: { path: `file${i}.ts` } },
      ] } });
      entries.push({ id: `t${i}`, type: "message", message: { role: "toolResult", toolCallId: `tc_${i}`, toolName: "edit", content: [{ type: "text", text: `edited file ${i}` }], isError: false } });
    }
    entries.push(msg("a9", "assistant", "all done"));

    const r = buildOwnCut(entries);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Cut should be at u2 — all toolCalls after u1 have matching toolResults
    // and all toolCalls after u2 also have matching toolResults
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u2");
  });
});
