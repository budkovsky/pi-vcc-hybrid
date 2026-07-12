export const CODEX_OUTPUT_LIMIT_COMPACT_INSTRUCTION = "__pi_vcc_codex_output_limit__";

/** Identify the Codex provider error used when a response reaches its output cap. */
export const isCodexOutputLimitError = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;

  const candidate = message as {
    role?: unknown;
    provider?: unknown;
    api?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };

  const isCodexMessage =
    candidate.provider === "openai-codex" ||
    candidate.api === "openai-codex-responses";

  return (
    candidate.role === "assistant" &&
    isCodexMessage &&
    candidate.stopReason === "error" &&
    typeof candidate.errorMessage === "string" &&
    /maximum output token limit/i.test(candidate.errorMessage)
  );
};
