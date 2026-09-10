import { describe, it, expect } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  SESSION_ID_MAX_LEN,
  SHARED_INDEX_NAME,
  chunkDir,
  collectionName,
  defaultVectorRoot,
  sanitizeSessionId,
} from "../../src/semantic/paths";

describe("sanitizeSessionId", () => {
  it("passes clean ids through unchanged", () => {
    expect(sanitizeSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(sanitizeSessionId("abc-123_xYZ")).toBe("abc-123_xYZ");
  });

  it("replaces path separators and unsafe chars with underscores", () => {
    expect(sanitizeSessionId("a/b/c")).toBe("a_b_c");
    expect(sanitizeSessionId("a b.c")).toBe("a_b_c");
  });

  it("never yields '..' (dot-dot traversal)", () => {
    for (const raw of ["..", "a..b", "../etc", "....", "a/../../b"]) {
      const out = sanitizeSessionId(raw);
      expect(out.includes("..")).toBe(false);
      expect(out.includes("/")).toBe(false);
    }
  });

  it("collapses runs of unsafe chars into a single underscore", () => {
    expect(sanitizeSessionId("a///b")).toBe("a_b");
    expect(sanitizeSessionId("...")).toBe("_");
  });

  it("falls back to 'default' for empty or whitespace-only ids", () => {
    expect(sanitizeSessionId("")).toBe("default");
    expect(sanitizeSessionId("   ")).toBe("default");
  });

  it("caps length at SESSION_ID_MAX_LEN without leaving trailing underscores", () => {
    const long = "a".repeat(SESSION_ID_MAX_LEN + 50);
    const out = sanitizeSessionId(long);
    expect(out.length).toBeLessThanOrEqual(SESSION_ID_MAX_LEN);
    expect(out.endsWith("_")).toBe(false);
  });

  it("only ever emits [A-Za-z0-9_-]", () => {
    const nasty = "s\u00e9ssion/..\\id\x01\x02 with spaces!@#$%^&*()";
    const out = sanitizeSessionId(nasty);
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("defaultVectorRoot", () => {
  it("is ~/.pi/vector", () => {
    expect(defaultVectorRoot()).toBe(join(homedir(), ".pi", "vector"));
  });
});

describe("chunkDir", () => {
  it("joins root + sanitized id", () => {
    expect(chunkDir("sess-1", "/tmp/root")).toBe(join("/tmp/root", "sess-1"));
  });

  it("sanitizes the id before building the path", () => {
    expect(chunkDir("../evil", "/tmp/root")).toBe(join("/tmp/root", "_evil"));
    expect(chunkDir("a/b", "/tmp/root")).toBe(join("/tmp/root", "a_b"));
  });

  it("defaults to ~/.pi/vector", () => {
    expect(chunkDir("sess-1")).toBe(join(homedir(), ".pi", "vector", "sess-1"));
  });
});

describe("collectionName", () => {
  it("is the sanitized session id (valid qmd collection name)", () => {
    expect(collectionName("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(collectionName("a/b..c")).toBe(collectionName("a_b_c"));
    expect(collectionName("anything")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("SHARED_INDEX_NAME", () => {
  it("is the stable shared-index default (one daemon = one index)", () => {
    expect(SHARED_INDEX_NAME).toBe("pi-semantic");
  });
});
