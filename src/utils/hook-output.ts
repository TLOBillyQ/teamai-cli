/**
 * Format Stop hook STDOUT for the given AI tool.
 *
 * Schema choice per tool:
 * - Cursor: `{ followup_message }`  (Cursor stop hook docs)
 * - Codex: `{ systemMessage }` (UI notice; model context is deferred to prompt-submit)
 * - Kimi Code CLI: `{ hookSpecificOutput: { hookEventName: 'Stop',
 *   permissionDecision: 'deny', permissionDecisionReason } }`. Kimi's Stop
 *   hook ignores non-blocking stdout; a deny decision appends the reason as a
 *   stop_hook user message and lets the model run one more turn (kimi guards
 *   the continuation to a single extra step), which is the closest match to
 *   Claude's additionalContext. hook-dispatch always exits 0, so the JSON
 *   decision is the only way to reach that path.
 * - Everyone else (Claude / CodeBuddy / WorkBuddy / unknown):
 *   `{ hookSpecificOutput: { hookEventName: 'Stop', additionalContext } }`
 *   (Claude Code stop hook docs — the "additional context that continues
 *   the conversation" branch, NOT top-level `stopReason`, which requires
 *   `continue:false` and aborts the run.)
 */
export function formatStopHookOutput(message: string, tool: string): string {
  const normalized = tool?.toLowerCase() ?? '';

  if (normalized === 'codex') {
    return JSON.stringify({ systemMessage: message });
  }

  if (normalized === 'cursor') {
    return JSON.stringify({ followup_message: message });
  }

  if (normalized === 'kimi') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        permissionDecision: 'deny',
        permissionDecisionReason: message,
      },
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: message,
    },
  });
}
