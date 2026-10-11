import { describe, expect, it } from 'vitest';
import {
  PROCESS_VISIBILITY_OPTIONS,
  filterProactiveStreamEvent,
  normalizeProcessVisibility,
} from '../src/lib/process-visibility';
import { normalizeGroupInteractionMode } from '../src/lib/interaction-mode';
import type { GroupInfo } from '../src/types';
import type { StreamEvent } from '../src/stream-event.types';

const event = (
  over: Partial<StreamEvent> & { eventType: StreamEvent['eventType'] },
) => over as StreamEvent;

describe('normalizeProcessVisibility', () => {
  it('reads anything but a known level as hidden', () => {
    expect(normalizeProcessVisibility('activity')).toBe('activity');
    expect(normalizeProcessVisibility('full')).toBe('full');
    expect(normalizeProcessVisibility('hidden')).toBe('hidden');
    expect(normalizeProcessVisibility(undefined)).toBe('hidden');
    expect(normalizeProcessVisibility(null)).toBe('hidden');
    expect(normalizeProcessVisibility('everything')).toBe('hidden');
  });

  it('is applied to a workspace loaded from an older server', () => {
    const group = normalizeGroupInteractionMode({
      name: 'w',
      folder: 'w',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'proactive',
    } as GroupInfo);
    expect(group.process_visibility).toBe('hidden');
    expect(
      normalizeGroupInteractionMode({
        ...group,
        process_visibility: 'full',
      }).process_visibility,
    ).toBe('full');
  });

  it('offers the three levels with what they show', () => {
    expect(PROCESS_VISIBILITY_OPTIONS.map((o) => o.value)).toEqual([
      'hidden',
      'activity',
      'full',
    ]);
    expect(PROCESS_VISIBILITY_OPTIONS.map((o) => o.label)).toEqual([
      '隐藏',
      '仅活动',
      '活动 + 思考摘要',
    ]);
  });
});

describe('filterProactiveStreamEvent', () => {
  const lifecycle = ['requesting', 'idle', 'interrupted'];
  const activity = [
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
  ] as const;

  it('lets only the spinner lifecycle through when hidden', () => {
    for (const statusText of lifecycle) {
      const e = event({ eventType: 'status', statusText });
      expect(filterProactiveStreamEvent('hidden', e)).toBe(e);
    }
    expect(
      filterProactiveStreamEvent(
        'hidden',
        event({ eventType: 'status', statusText: '正在深入分析…' }),
      ),
    ).toBeNull();
    for (const eventType of [...activity, 'thinking_delta', 'text_delta']) {
      expect(
        filterProactiveStreamEvent('hidden', event({ eventType })),
      ).toBeNull();
    }
  });

  it('adds the activity, never the reasoning text, at the activity level', () => {
    for (const eventType of activity) {
      const e = event({ eventType });
      expect(filterProactiveStreamEvent('activity', e)).not.toBeNull();
    }
    expect(
      filterProactiveStreamEvent(
        'activity',
        event({ eventType: 'status', statusText: 'compacting' }),
      ),
    ).not.toBeNull();
    expect(
      filterProactiveStreamEvent(
        'activity',
        event({ eventType: 'thinking_delta', text: '想' }),
      ),
    ).toBeNull();
  });

  it('adds the reasoning text at the full level', () => {
    const e = event({ eventType: 'thinking_delta', text: '想' });
    expect(filterProactiveStreamEvent('full', e)).toBe(e);
  });

  it('never lets model text through, at any level', () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      expect(
        filterProactiveStreamEvent(
          level,
          event({ eventType: 'text_delta', text: '内部想法' }),
        ),
      ).toBeNull();
      expect(
        filterProactiveStreamEvent(
          level,
          event({
            eventType: 'text_delta',
            text: '子 Agent',
            parentToolUseId: 'task-1',
          }),
        ),
      ).toBeNull();
    }
  });

  it('strips what a tool returned and what it was given', () => {
    const result = filterProactiveStreamEvent(
      'full',
      event({
        eventType: 'tool_result',
        toolUseId: 't1',
        toolResult: '秘密',
        detail: '秘密',
      }),
    )!;
    expect(result.toolResult).toBeUndefined();
    expect(result.detail).toBeUndefined();
    expect(result.toolUseId).toBe('t1');

    const start = filterProactiveStreamEvent(
      'activity',
      event({
        eventType: 'tool_use_start',
        toolName: 'AskUserQuestion',
        toolInput: { question: '你好吗' },
      }),
    )!;
    expect(start.toolInput).toBeUndefined();
    expect(start.toolName).toBe('AskUserQuestion');
  });

  it('drops event types it does not know', () => {
    for (const eventType of [
      'raw_sdk_event',
      'memory_recall',
      'prompt_suggestion',
    ] as const) {
      expect(
        filterProactiveStreamEvent('full', event({ eventType })),
      ).toBeNull();
    }
  });
});
