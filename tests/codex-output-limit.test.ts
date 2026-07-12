import { describe, test, expect } from "bun:test";
import { isCodexOutputLimitError } from "../src/core/codex-output-limit";
import { shouldResumeAfterCompaction } from "../src/hooks/before-compact";

const codexOutputLimitError = {
  role: "assistant",
  api: "openai-codex-responses",
  provider: "openai-codex",
  stopReason: "error",
  errorMessage: "Model stopped because it reached the maximum output token limit. The response may be incomplete.",
};

describe("Codex maximum output limit handling", () => {
  test("recognizes the built-in Codex output-limit error", () => {
    expect(isCodexOutputLimitError(codexOutputLimitError)).toBe(true);
  });

  test("does not classify an unrelated provider error", () => {
    expect(isCodexOutputLimitError({
      ...codexOutputLimitError,
      provider: "openai",
      api: "openai-responses",
    })).toBe(false);
  });

  test("resumes after compaction for the Codex output-limit error", () => {
    expect(shouldResumeAfterCompaction(codexOutputLimitError, true)).toBe(true);
  });

  test("does not resume after an ordinary manual compaction", () => {
    expect(shouldResumeAfterCompaction(codexOutputLimitError)).toBe(false);
  });

  test("does not resume after compaction for ordinary errors", () => {
    expect(shouldResumeAfterCompaction({
      ...codexOutputLimitError,
      errorMessage: "Codex request failed",
    }, true)).toBe(false);
  });
});
