import type { StreamEvent } from '../stream-event.types';
import type { ProcessVisibility } from '../types';

export const DEFAULT_PROCESS_VISIBILITY: ProcessVisibility = 'hidden';

/** Anything but a known level reads as hidden: older servers send nothing. */
export function normalizeProcessVisibility(value: unknown): ProcessVisibility {
  return value === 'activity' || value === 'full' ? value : 'hidden';
}

export const PROCESS_VISIBILITY_OPTIONS: ReadonlyArray<{
  value: ProcessVisibility;
  label: string;
  description: string;
}> = [
  {
    value: 'hidden',
    label: '隐藏',
    description: '只显示“正在处理…”，不展示任何处理过程。',
  },
  {
    value: 'activity',
    label: '仅活动',
    description:
      '显示当前阶段、调用的工具、子 Agent 与计划，不显示模型的文字。',
  },
  {
    value: 'full',
    label: '活动 + 思考摘要',
    description: '在活动之外显示模型的思考摘要；仍不会显示未发送的回复文字。',
  },
];

/** Status texts the host sends at every level: they only start/stop the spinner. */
const LIFECYCLE_STATUS = new Set(['requesting', 'idle', 'interrupted']);

/** What a proactive workspace shows at `activity` and above. */
const ACTIVITY_EVENTS = new Set<string>([
  'status',
  'tool_use_start',
  'tool_use_end',
  'tool_progress',
  'tool_result',
  'task_start',
  'task_progress',
  'task_updated',
  'task_notification',
  'todo_update',
  'hook_started',
  'hook_progress',
  'hook_response',
  'permission_denied',
  'thinking_start',
  'thinking_end',
]);

/**
 * The part of a proactive turn's stream the Web may show. The host already
 * sends only this; the Web checks again, so a host that sends more (an older
 * or newer one, a bug) cannot put model text or reasoning on screen. Never
 * returns `text_delta`; reasoning text only at `full`; tool results arrive
 * without their text. `null` means the event is dropped.
 */
export function filterProactiveStreamEvent(
  visibility: ProcessVisibility,
  event: StreamEvent,
): StreamEvent | null {
  const type = event.eventType;
  if (visibility === 'hidden') {
    return type === 'status' &&
      !!event.statusText &&
      LIFECYCLE_STATUS.has(event.statusText)
      ? event
      : null;
  }
  if (type === 'thinking_delta') return visibility === 'full' ? event : null;
  if (!ACTIVITY_EVENTS.has(type)) return null;
  if (type === 'tool_result') {
    return { ...event, toolResult: undefined, detail: undefined };
  }
  if (event.toolInput) return { ...event, toolInput: undefined };
  return event;
}
