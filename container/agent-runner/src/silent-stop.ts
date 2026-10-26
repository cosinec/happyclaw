/**
 * Silent stop: a healthy Result whose last model response only thought.
 *
 * A model occasionally ends its turn (stop_reason end_turn) after a thinking
 * block without writing the reply, and an SSE stream cut short and closed as
 * a normal end looks the same. The user then gets an empty reply. Claude
 * Code 2.1.296 already answers one such response inside the turn with its
 * generic "no visible output" prompt; when that retry only thinks again, the
 * runner asks once more in the same SDK stream, naming the problem and
 * asking for the reply itself.
 */

import type { EmptyReplyReason } from './reply-shape.js';

/**
 * Continuations per input. One is enough: with the CLI's own retry inside
 * each turn, an input that keeps producing thinking-only responses costs at
 * most four model calls before its empty reply is published as before.
 */
export const MAX_SILENT_STOP_CONTINUES = 1;

export interface SilentStopCheck {
  emitOutput: boolean;
  /** SDK `is_error` on a success Result (an API error wrapped as success). */
  isError: boolean;
  /** Interrupt, close, drain or shutdown already ended this turn's stream. */
  stopping: boolean;
  /** A hook stopped the turn (prevent_continuation). */
  continuationPrevented: boolean;
  /** Proactive replies cross send_message; an injected prompt could repeat one. */
  proactive: boolean;
  blockingBackgroundWork: number;
  /** Later inputs already queued in this query or in Claude Code. */
  laterInputs: number;
  finalText: string | null | undefined;
  reason: EmptyReplyReason;
  attempts: number;
}

/**
 * `continue` when the runner should ask for the reply, `exhausted` when it
 * is a silent stop but the continuations are used up, otherwise null.
 */
export function decideSilentStop(
  check: SilentStopCheck,
): 'continue' | 'exhausted' | null {
  if (
    !check.emitOutput ||
    check.isError ||
    check.stopping ||
    check.continuationPrevented ||
    check.proactive ||
    check.blockingBackgroundWork > 0 ||
    check.laterInputs > 0 ||
    check.finalText?.trim() ||
    check.reason !== 'thinking_only'
  ) {
    return null;
  }
  return check.attempts < MAX_SILENT_STOP_CONTINUES ? 'continue' : 'exhausted';
}

export function buildSilentStopContinuationPrompt(): string {
  return [
    '<system-reminder>',
    'Your previous response ended after thinking, without any reply text, so the user has received nothing yet.',
    'Write your reply to the user now, continuing from where your reasoning stopped. Do not start over, and do not mention this reminder.',
    '</system-reminder>',
  ].join('\n');
}
