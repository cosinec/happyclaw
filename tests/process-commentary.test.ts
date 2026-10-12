import { describe, expect, test } from 'vitest';

import {
  MAX_COMMENTARY_CHARS,
  ProactiveCommentaryRelay,
} from '../src/process-commentary.js';
import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';
import { projectSdkStreamEventForWeb } from '../src/workspace-interaction-runtime.js';

function ev(eventType: StreamEventType, extra: Partial<StreamEvent> = {}) {
  return { eventType, agentScope: 'main', ...extra } as StreamEvent;
}

const text = (t: string, extra: Partial<StreamEvent> = {}) =>
  ev('text_delta', { text: t, turnId: 'turn-1', ...extra });
const tool = (toolName: string, extra: Partial<StreamEvent> = {}) =>
  ev('tool_use_start', {
    toolName,
    toolUseId: `use-${toolName}`,
    turnId: 'turn-1',
    sessionId: 'sess-1',
    ...extra,
  });

/** Feed events through a relay as the host does and collect what it adds. */
function run(
  events: StreamEvent[],
  mode: InteractionMode = 'proactive',
  visibility: ProcessVisibility = 'full',
  relay = new ProactiveCommentaryRelay(),
): StreamEvent[] {
  return events.flatMap((event) => relay.take(mode, visibility, event));
}

describe('narration before a tool call (proactive, full)', () => {
  test('text a tool call followed goes out whole, ahead of the call', () => {
    const notes = run([
      text('先看'),
      text('一下记忆。'),
      tool('mcp__happyclaw__memory_search'),
    ]);
    expect(notes).toEqual([
      {
        eventType: 'commentary',
        agentScope: 'main',
        text: '先看一下记忆。',
        turnId: 'turn-1',
        sessionId: 'sess-1',
      },
    ]);
  });

  test('every call gets its own narration, none repeats', () => {
    const relay = new ProactiveCommentaryRelay();
    const notes = [
      ...run([text('A'), tool('Read')], 'proactive', 'full', relay),
      ...run([text('B'), tool('Bash')], 'proactive', 'full', relay),
      ...run([tool('Grep')], 'proactive', 'full', relay),
    ];
    expect(notes.map((note) => note.text)).toEqual(['A', 'B']);
  });

  test('text no tool follows is never sent: the end of a turn, an unsent reply', () => {
    const relay = new ProactiveCommentaryRelay();
    expect(
      run(
        [text('我决定不回复。'), ev('status', { statusText: 'idle' })],
        'proactive',
        'full',
        relay,
      ),
    ).toEqual([]);
    // Nothing is left to attach to the next turn's first tool call.
    expect(run([tool('Read')], 'proactive', 'full', relay)).toEqual([]);
  });

  test('a new model request drops the text of the one before it', () => {
    const relay = new ProactiveCommentaryRelay();
    const notes = run(
      [
        text('最后一句，没有工具跟着。'),
        ev('status', { statusText: 'requesting' }),
        tool('Read'),
      ],
      'proactive',
      'full',
      relay,
    );
    expect(notes).toEqual([]);
  });

  test('an interrupted run drops what it held', () => {
    const notes = run([
      text('写到一半'),
      ev('status', { statusText: 'interrupted' }),
      tool('Read'),
    ]);
    expect(notes).toEqual([]);
  });

  test('text before send_message is the message itself, not narration', () => {
    const notes = run([
      text('这是我要发给用户的回复。'),
      tool('mcp__happyclaw__send_message'),
    ]);
    expect(notes).toEqual([]);
  });

  test('a sub-Agent never feeds it, and its tools do not release the main text', () => {
    const notes = run([
      text('主 Agent 的话'),
      text('子 Agent 的话', {
        agentScope: 'subagent',
        parentToolUseId: 'task-1',
      }),
      tool('Read', { parentToolUseId: 'task-1', agentScope: 'subagent' }),
    ]);
    expect(notes).toEqual([]);
    const later = run([text('A'), tool('Bash')]);
    expect(later.map((note) => note.text)).toEqual(['A']);
  });

  test('blank text is not narration', () => {
    expect(run([text('  \n'), tool('Read')])).toEqual([]);
  });

  test('a long passage keeps its end', () => {
    const long = `${'x'.repeat(MAX_COMMENTARY_CHARS)}END`;
    const [note] = run([text(long), tool('Read')]);
    expect(note.text).toHaveLength(MAX_COMMENTARY_CHARS);
    expect(note.text!.endsWith('END')).toBe(true);
  });

  test('a new turn starts with an empty buffer, even if no event announced it', () => {
    const relay = new ProactiveCommentaryRelay();
    const take = (event: StreamEvent, turnKey: string) =>
      relay.take('proactive', 'full', event, turnKey);
    // Text the first turn ended on, with nothing after it.
    expect(take(text('上一轮的话'), 'turn-1')).toEqual([]);
    // The next turn's first tool call must not pick it up.
    expect(take(tool('Read'), 'turn-2')).toEqual([]);
    const [note] = [
      ...take(text('这一轮'), 'turn-2'),
      ...take(tool('Bash'), 'turn-2'),
    ];
    expect(note.text).toBe('这一轮');
  });

  test('the event carries the turn of the call it introduces, else the turn key', () => {
    const relay = new ProactiveCommentaryRelay();
    relay.take('proactive', 'full', text('A'), 'k1');
    const [withId] = relay.take(
      'proactive',
      'full',
      tool('Read', { turnId: 'turn-9' }),
      'k1',
    );
    expect(withId.turnId).toBe('turn-9');
    relay.take('proactive', 'full', text('B'), 'k1');
    const [withoutId] = relay.take(
      'proactive',
      'full',
      tool('Read', { turnId: undefined }),
      'k1',
    );
    expect(withoutId.turnId).toBe('k1');
  });
});

describe('where it sends nothing', () => {
  const events = [text('先看一下。'), tool('Read')];

  test.each<[InteractionMode, ProcessVisibility]>([
    ['proactive', 'hidden'],
    ['proactive', 'activity'],
    ['assistant', 'full'],
    ['assistant', 'activity'],
  ])('%s at %s', (mode, visibility) => {
    expect(run(events, mode, visibility)).toEqual([]);
  });

  test('lowering the level mid-turn drops what was held', () => {
    const relay = new ProactiveCommentaryRelay();
    run([text('先看一下。')], 'proactive', 'full', relay);
    expect(
      run(
        [ev('status', { statusText: 'requesting' })],
        'proactive',
        'activity',
        relay,
      ),
    ).toEqual([]);
    // Raised again, the old text is gone.
    expect(run([tool('Read')], 'proactive', 'full', relay)).toEqual([]);
  });
});

describe('the projection still refuses the model text itself', () => {
  test('text_delta never reaches the Web at any level; commentary only at full', () => {
    const delta = text('一句话');
    const note = ev('commentary', { text: '一句话' });
    for (const level of ['hidden', 'activity', 'full'] as const) {
      expect(projectSdkStreamEventForWeb('proactive', level, delta)).toBeNull();
      expect(
        projectSdkStreamEventForWeb('proactive', level, note) !== null,
        level,
      ).toBe(level === 'full');
    }
  });
});
