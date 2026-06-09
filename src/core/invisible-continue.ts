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

// Timestamp of the last completed triggerInvisibleContinue().
// Used by the continue() monkey-patch to detect when triggerInvisibleContinue
// just ran (so it shouldn't fall back to prompt([]) again — the agent
// already continued). This prevents double continuation when both
// pi-retry and pi-vcc are installed.
let _lastInvisibleContinueTime = 0;

// Monkey-patch Agent.prototype.subscribe to capture the live instance.
// Chain the previous patch (if pi-retry already patched it) so both
// extensions can coexist.
const _prevSubscribe = Agent.prototype.subscribe as (...args: unknown[]) => unknown;
Agent.prototype.subscribe = function (this: Agent, ...args: unknown[]) {
  _agent = this;
  return _prevSubscribe.apply(this, args);
};

// Monkey-patch continue() so that after compaction, when the rebuilt
// context ends with an assistant message, the agent loop can still
// continue. Without this patch, the session's continue() call throws
// "Cannot continue from message role: assistant" and the agent loop
// exits — leaving mid-task work unfinished.
//
// The fix: when continue() would throw because the last message is an
// assistant, fall back to prompt([]) instead. prompt([]) doesn't check
// the last message role — it starts a fresh agent loop with the current
// context. This is equivalent to the invisible-continue mechanism
// (same call the extension fires from session_compact), but triggered
// from the session's own continue() path so the while loop stays alive.
//
// Chains the previous patch (pi-retry, pi-invisible-continue) so all
// mutexes are respected.
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

      // After compaction, the rebuilt context often ends with an assistant
      // message. The original continue() throws "Cannot continue from
      // message role: assistant". Instead of swallowing the error and
      // letting the agent loop die (which leaves mid-task work unfinished),
      // fall back to prompt([]). This restarts the agent loop with the
      // compacted context — the LLM picks up where it left off.
      //
      // prompt([]) is safe regardless of last message role. The agent
      // processes the current context and continues.
      //
      // We only do this when the agent is NOT currently processing
      // (no other triggerInvisibleContinue in flight) to avoid races.
      if (msg.includes("Cannot continue from message role") ||
          msg.includes("Cannot continue from an assistant message")) {
        // Check stopReason of the last message — only continue if
        // the agent was mid-task (not a clean stop or user abort).
        const lastMsg = self.state.messages[self.state.messages.length - 1];
        if (lastMsg?.role === "assistant" &&
            lastMsg.stopReason !== "stop" &&
            lastMsg.stopReason !== "aborted") {
          // Agent was mid-task — fall through to prompt([])
          // (after the error-handling block)
        } else {
          // Agent finished cleanly or was aborted — don't continue.
          // The session loop should exit (task complete).
          return;
        }
        // Fall back to prompt([]) to actually continue the agent.
        // The while loop in _runAgentPrompt stays alive because prompt([])
        // runs the agent (which emits events, updates _lastAssistantMessage,
        // etc.).
        //
        // Guard: if triggerInvisibleContinue() just completed (within the
        // last 500ms), the agent already continued — skip the fallback to
        // avoid double continuation. This happens when both pi-retry and
        // pi-vcc are installed: pi-retry's triggerInvisibleContinue runs
        // first, then the session's continue() wrapper unblocks and would
        // fall back to prompt([]) again.
        if (!_continueInProgress && Date.now() - _lastInvisibleContinueTime > 500) {
          _continueInProgress = true;
          try {
            await self.prompt([]);
          } catch {
            // Agent already processing or other transient error
          } finally {
            _continueInProgress = false;
          }
        }
        return;
      }

      if (msg.includes("Agent is already processing")) {
        // Another extension is driving the agent — wait it out.
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
      // Record completion time so the continue() monkey-patch can
      // detect that an invisible continue just ran and avoid firing
      // a duplicate prompt([]) (RC7: double continuation guard).
      _lastInvisibleContinueTime = Date.now();
    }
  };

  void run();
}

/** Reset state on new session. */
export function resetInvisibleContinue(): void {
  _continueInProgress = false;
  _lastInvisibleContinueTime = 0;
}
