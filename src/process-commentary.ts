/**
 * The narration between a proactive Agent's tool calls, for the Web.
 *
 * A proactive Workspace never streams the model's `text_delta` to the Web: that
 * text is private model-loop state, and what the Agent wants the user to read
 * it sends with send_message. But a model that returns no reasoning summary
 * (the ChatGPT subscription models return one for about 1% of their reasoning)
 * explains what it is about to do in a sentence before it calls a tool, and
 * that sentence is most of the process there is to show. A Workspace at the
 * `full` process visibility therefore gets those sentences, and only those:
 *
 * - the text of a model message is held back until a tool call follows it;
 *   then it is the narration of that call and goes out as one `commentary`
 *   event, just ahead of the call;
 * - text that no tool follows (the end of a turn, an unsent reply) is dropped
 *   with the message that carried it, never sent;
 * - text before send_message is dropped too: it is the message itself, which
 *   the user receives as a chat message;
 * - a sub-Agent's text is never held (its stream is its own task's).
 *
 * The events are broadcast to the Web only. Nothing here reaches an IM channel
 * or the stored turn trace.
 */

import type { StreamEvent } from './stream-event.types.js';
import { isSubagentEvent } from './stream-trace.js';
import type { InteractionMode, ProcessVisibility } from './types.js';
import {
  isMessageDeliveryTool,
  projectSdkStreamEventForWeb,
} from './workspace-interaction-runtime.js';

/** Most of a held passage kept; its end wins, as in the Web's commentary row. */
export const MAX_COMMENTARY_CHARS = 4000;

/** Status texts after which no held text can belong to a later tool call. */
const BOUNDARY_STATUS_TEXTS: ReadonlySet<string> = new Set([
  'requesting',
  'idle',
  'interrupted',
]);

/**
 * Per-run holder of the text a model message has written so far. One per
 * Runner loop; events of one session arrive in order, so a single buffer is
 * enough, and a change of turn starts it afresh.
 */
export class ProactiveCommentaryRelay {
  private held = '';
  private turnKey: string | undefined;

  /**
   * Feed every Runner event of the run through here, before projecting it.
   * `turnKey` names the input turn the event belongs to (the key the trace
   * tracker uses): text held from one turn never reaches the next. Returns the
   * `commentary` events to broadcast ahead of `event` (none, or one). Outside a
   * proactive Workspace at `full` it holds nothing.
   */
  take(
    mode: InteractionMode,
    visibility: ProcessVisibility,
    event: StreamEvent,
    turnKey?: string,
  ): StreamEvent[] {
    if (mode !== 'proactive' || visibility !== 'full') {
      this.held = '';
      return [];
    }
    if (turnKey !== this.turnKey) {
      this.held = '';
      this.turnKey = turnKey;
    }
    if (isSubagentEvent(event)) return [];
    switch (event.eventType) {
      case 'text_delta':
        if (event.text) this.hold(event.text);
        return [];
      case 'tool_use_start': {
        const text = this.held.trim();
        this.held = '';
        if (!text || isMessageDeliveryTool(event.toolName)) return [];
        const note = projectSdkStreamEventForWeb(mode, visibility, {
          eventType: 'commentary',
          agentScope: 'main',
          text,
          turnId: event.turnId ?? turnKey,
          sessionId: event.sessionId,
        });
        return note ? [note] : [];
      }
      case 'status':
        if (event.statusText && BOUNDARY_STATUS_TEXTS.has(event.statusText)) {
          this.held = '';
        }
        return [];
      default:
        return [];
    }
  }

  private hold(delta: string): void {
    const text = this.held + delta;
    this.held =
      text.length > MAX_COMMENTARY_CHARS
        ? text.slice(-MAX_COMMENTARY_CHARS)
        : text;
  }
}
