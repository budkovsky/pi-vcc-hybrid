import { Agent } from "@earendil-works/pi-agent-core";

/**
 * Invisible continue — resume the agent loop after compaction without
 * injecting any message into context.
 *
 * Same mechanism as pi-retry: capture the live Agent instance via
 * subscribe() monkey-patch, then call agent.prompt([]) to start a
 * fresh agent loop that picks up where the compacted transcript left off.
 * The LLM sees the exact same message list — no new user prompt.
 *
 * Used after threshold compaction when the agent would otherwise stall
 * (willRetry=false, no queued messages).
 */

let _agent: Agent | null = null;
let _continueInProgress = false;

// Monkey-patch Agent.prototype.subscribe to capture the live instance.
// Chain the previous patch (if pi-retry already patched it) so both
// extensions can coexist.
const _prevSubscribe = Agent.prototype.subscribe as (...args: unknown[]) => unknown;
Agent.prototype.subscribe = function (this: Agent, ...args: unknown[]) {
  _agent = this;
  return _prevSubscribe.apply(this, args);
};

// Monkey-patch continue() so the session's built-in loop cooperates with
// our mutex. Without this, the session's continue() could race our
// prompt([]) call and throw "Agent is already processing".
const _prevContinue = Agent.prototype.continue as (this: Agent) => Promise<unknown>;
Agent.prototype.continue = function (this: Agent) {
  const self = this;
  return (async () => {
    while (_continueInProgress) {
      await new Promise(r => setTimeout(r, 10));
    }
    try {
      return await _prevContinue.call(self);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // After our invisible continue finishes, the transcript ends with a
      // fresh assistant message.  The session's continue() sees this and
      // would throw.  Catch and swallow — the while-loop will poll
      // _handlePostAgentRun() again, find no error, and exit cleanly.
      if (
        msg.includes("Cannot continue from message role") ||
        msg.includes("Cannot continue from an assistant message") ||
        msg.includes("Agent is already processing")
      ) {
        return;
      }
      throw e;
    }
  })();
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fire an invisible continue after the agent becomes idle.
 *
 * MUST NOT be awaited — it schedules work that runs after the current
 * session loop iteration finishes.  Awaiting would deadlock inside the
 * session's _handlePostAgentRun → _runAutoCompaction call stack.
 */
export function triggerInvisibleContinue(): void {
  if (!_agent) return;
  if (_continueInProgress) return;
  _continueInProgress = true;

  const run = async () => {
    try {
      // Wait for the current run to finish (activeRun resolves in
      // finishRun() after agent_end listeners return).
      await _agent!.waitForIdle();

      // Small delay to ensure the session's while-loop has exited
      // after _handlePostAgentRun returns false.
      await sleep(50);

      try {
        // Await so _continueInProgress stays true for the full cycle.
        await _agent!.prompt([]);
      } catch {
        // Ignore — if prompt throws, something else is driving.
      }
    } finally {
      _continueInProgress = false;
    }
  };

  void run();
}

/** Reset state on new session. */
export function resetInvisibleContinue(): void {
  _continueInProgress = false;
}
