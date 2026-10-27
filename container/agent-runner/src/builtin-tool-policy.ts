import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

/**
 * Built-in tools removed from every session because they depend on a Claude
 * Code process that outlives the turn. The runner ends the CLI process a few
 * seconds after each result, so a session-scoped cron or ScheduleWakeup would
 * silently never fire (HappyClaw schedules through mcp__happyclaw__schedule_task),
 * and a worktree would move the session away from the workspace directory
 * whose transcript and IPC paths the runner resolves.
 *
 * Plan mode is removed for the same reason: leaving it waits for an
 * interactive approval that no one gives. The CLI registers EnterPlanMode and
 * ExitPlanMode only because the runner installs `canUseTool` for
 * AskUserQuestion; without the deny list they would appear with it.
 */
export const RUNNER_DISALLOWED_BUILTIN_TOOLS: readonly string[] = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
];

/**
 * Tool result of an AskUserQuestion call. The runner has no interactive
 * answer channel: the host shows the questions from the tool input (a Web
 * card, Feishu buttons) and the user's answer arrives as their next message.
 * Other channels show only the reply text, so the reply restates them.
 */
export const ASK_USER_QUESTION_DEFERRED_RESULT =
  'The question was not answered inside this turn. HappyClaw has shown it ' +
  'to the user where the channel supports it (a Web card, Feishu buttons), ' +
  "and the user's answer will arrive as their next message. Do not wait " +
  'for an answer and do not ask the same question again with this tool. ' +
  'End this turn now with a short reply that restates the question and ' +
  'its options, so the user can answer from any channel.';

/**
 * The CLI registers AskUserQuestion only when the host answers permission
 * requests. Everything else stays allowed exactly as bypassPermissions
 * allows it; AskUserQuestion is answered with the deferred result above.
 */
export const runnerCanUseTool: CanUseTool = async (toolName, input) =>
  toolName === 'AskUserQuestion'
    ? { behavior: 'deny', message: ASK_USER_QUESTION_DEFERRED_RESULT }
    : { behavior: 'allow', updatedInput: input };

/**
 * The SDK warns on every query that bypassPermissions shadows `canUseTool`.
 * That holds for ordinary tools, not for AskUserQuestion: asking the user is
 * never auto-approved, so it still reaches the handler. Drop only this
 * warning; every other one keeps Node's default output.
 */
export function silenceShadowedCanUseToolWarning(): void {
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (
      (warning as NodeJS.ErrnoException).code ===
      'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'
    )
      return;
    for (const listener of listeners) listener(warning);
  });
}
