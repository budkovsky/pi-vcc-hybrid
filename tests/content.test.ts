import { describe, it, expect } from "bun:test";
import { textOf, thinkingOf, clip, firstLine } from "../src/core/content";

describe("textOf", () => {
  it("returns empty string for undefined content", () => {
    expect(textOf(undefined as any)).toBe("");
  });

  it("returns empty string for null content", () => {
    expect(textOf(null as any)).toBe("");
  });

  it("returns string content as-is", () => {
    expect(textOf("hello")).toBe("hello");
  });

  it("extracts text parts from array content", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "toolCall" as const, name: "x", id: "1", arguments: {} },
      { type: "text" as const, text: "second" },
    ];
    expect(textOf(content)).toBe("first\nsecond");
  });

  it("ignores thinking parts", () => {
    const content = [
      { type: "thinking" as const, thinking: "let me think" },
      { type: "text" as const, text: "here is the answer" },
    ];
    expect(textOf(content)).toBe("here is the answer");
  });
});

describe("thinkingOf", () => {
  it("returns empty string for undefined content", () => {
    expect(thinkingOf(undefined as any)).toBe("");
  });

  it("returns empty string for string content", () => {
    expect(thinkingOf("hello")).toBe("");
  });

  it("extracts thinking parts from array content", () => {
    const content = [
      { type: "thinking" as const, thinking: "let me think" },
      { type: "text" as const, text: "here is the answer" },
    ];
    expect(thinkingOf(content)).toBe("let me think");
  });

  it("joins multiple thinking parts", () => {
    const content = [
      { type: "thinking" as const, thinking: "first thought" },
      { type: "text" as const, text: "answer" },
      { type: "thinking" as const, thinking: "second thought" },
    ];
    expect(thinkingOf(content)).toBe("first thought\nsecond thought");
  });
});

describe("textOf", () => {
  it("returns empty string for undefined content", () => {
    expect(textOf(undefined as any)).toBe("");
  });
});
