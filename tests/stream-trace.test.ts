import { describe, expect, test } from 'vitest';

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import {
  appendTraceEvent,
  capTailAtParagraph,
  capTailByBytes,
  isInternalLifecycleStatus,
  ThinkingClock,
  ThinkingTextBuffer,
  traceEventFor,
  traceKindFor,
  traceTitleFor,
} from '../src/stream-trace.js';

function ev(eventType: StreamEventType, extra: Partial<StreamEvent> = {}) {
  return { eventType, ...extra } as StreamEvent;
}

describe('trace rows mirror the Web', () => {
  // web/src/stores/chat.ts: traceTitle / traceKind. The collapsed "已使用 N 个工具"
  // summary counts rows whose title starts with "工具 " or "技能 ".
  test('titles and kinds', () => {
    const cases: Array<[StreamEvent, string, string]> = [
      [ev('tool_use_start', { toolName: 'Bash' }), '工具 Bash', 'tool'],
      [ev('tool_use_start'), '工具 unknown', 'tool'],
      [
        ev('tool_use_start', { toolName: 'Skill', skillName: 'pdf' }),
        '技能 pdf',
        'skill',
      ],
      [ev('tool_use_end', { toolName: 'Bash' }), '工具完成 Bash', 'tool'],
      [ev('tool_use_end', { toolUseId: 't1' }), '工具完成 t1', 'tool'],
      [ev('tool_result'), '工具结果', 'tool'],
      [ev('tool_progress', { toolName: 'Bash' }), '工具进度 Bash', 'tool'],
      [ev('task_start'), 'Task 启动', 'task'],
      [ev('task_progress'), 'Task 进度', 'task'],
      [ev('task_updated'), 'Task 更新', 'task'],
      [
        ev('task_notification', { taskStatus: 'failed' }),
        'Task failed',
        'task',
      ],
      [ev('task_notification'), 'Task 完成', 'task'],
      [
        ev('status', { statusText: '正在深入分析…' }),
        '正在深入分析…',
        'status',
      ],
      [ev('status', { statusText: null }), '状态更新', 'status'],
      [
        ev('permission_denied', { toolName: 'Write' }),
        '权限拒绝 Write',
        'permission',
      ],
      [ev('memory_recall'), '记忆召回', 'memory'],
      [ev('compact_boundary'), '上下文压缩', 'memory'],
      [ev('notification'), '通知', 'status'],
      [ev('hook_started', { hookName: 'h' }), 'hook_started', 'hook'],
      [ev('todo_update'), 'todo_update', 'status'],
    ];
    for (const [event, title, kind] of cases) {
      expect(traceTitleFor(event), event.eventType).toBe(title);
      expect(traceKindFor(event), event.eventType).toBe(kind);
    }
    expect(traceTitleFor(ev('notification', { title: 'Claude Code' }))).toBe(
      'Claude Code',
    );
  });

  test('a row carries the same fields the Web renders', () => {
    const row = traceEventFor(
      ev('tool_use_start', {
        agentScope: 'main',
        toolName: 'Bash',
        toolUseId: 't1',
        toolInputSummary: 'command: ls',
        parentToolUseId: 'k1',
        displayLevel: 'primary',
      }),
      1234,
    )!;
    expect(row).toMatchObject({
      timestamp: 1234,
      kind: 'tool',
      scope: 'main',
      title: '工具 Bash',
      summary: 'command: ls',
      toolUseId: 't1',
      parentToolUseId: 'k1',
      displayLevel: 'primary',
    });
    expect(row.id).toMatch(/^1234-/);
    // summary falls back through summary, taskSummary, statusText, input summary
    expect(
      traceEventFor(ev('task_progress', { taskSummary: '进行中' })),
    ).toMatchObject({ summary: '进行中' });
    expect(
      traceEventFor(ev('status', { statusText: 'API 重试中' })),
    ).toMatchObject({ summary: 'API 重试中' });
  });

  test('what never becomes a row', () => {
    for (const type of [
      'text_delta',
      'thinking_delta',
      'thinking_start',
      'thinking_end',
      'usage',
      'init',
      'context_audit',
    ] as StreamEventType[]) {
      expect(traceEventFor(ev(type, { text: 'x' })), type).toBeNull();
    }
    for (const statusText of [
      'requesting',
      'compacting',
      'idle',
      'interrupted',
    ]) {
      expect(isInternalLifecycleStatus(statusText)).toBe(true);
      expect(traceEventFor(ev('status', { statusText }))).toBeNull();
    }
    expect(isInternalLifecycleStatus('正在深入分析…')).toBe(false);
    // debug rows are filtered by the Web when rendering; keeping them would
    // only push real rows out of the bounded trace
    expect(
      traceEventFor(ev('raw_sdk_event', { displayLevel: 'debug' })),
    ).toBeNull();
    expect(
      traceEventFor(ev('raw_sdk_event', { displayLevel: 'primary' })),
    ).not.toBeNull();
  });

  test('the SDK heartbeat of a running tool is not a row, real progress is', () => {
    const beat = ev('tool_progress', {
      toolName: 'Bash',
      toolUseId: 't1',
      elapsedSeconds: 7,
    });
    expect(traceEventFor(beat)).toBeNull();
    expect(
      traceEventFor(
        ev('tool_progress', {
          toolUseId: 't1',
          toolInputSummary: 'command: ls',
        }),
      ),
    ).not.toBeNull();
    expect(
      traceEventFor(ev('tool_progress', { toolUseId: 't1', skillName: 'pdf' })),
    ).not.toBeNull();
    expect(
      traceEventFor(
        ev('tool_progress', { toolUseId: 't1', toolInput: { q: 1 } }),
      ),
    ).not.toBeNull();
  });

  test('appendTraceEvent keeps the newest rows', () => {
    let rows = [] as ReturnType<typeof appendTraceEvent>;
    for (let i = 0; i < 12; i += 1) {
      rows = appendTraceEvent(
        rows,
        ev('tool_use_start', { toolName: `T${i}`, toolUseId: `t${i}` }),
        5,
        i,
      );
    }
    expect(rows.map((row) => row.title)).toEqual([
      '工具 T7',
      '工具 T8',
      '工具 T9',
      '工具 T10',
      '工具 T11',
    ]);
    expect(appendTraceEvent(rows, ev('text_delta', { text: 'x' }), 5)).toBe(
      rows,
    );
  });
});

describe('bounded text', () => {
  test('capTailAtParagraph keeps the tail, starting on a paragraph', () => {
    const text = [
      '第一段'.repeat(10),
      '第二段'.repeat(10),
      '第三段'.repeat(10),
    ].join('\n\n');
    expect(capTailAtParagraph(text, text.length)).toBe(text);
    // 94 characters, 70 allowed: the first paragraph is the part given up
    const capped = capTailAtParagraph(text, 70);
    expect(capped).toBe(`${'第二段'.repeat(10)}\n\n${'第三段'.repeat(10)}`);
    // 40 allowed: only the last paragraph fits
    expect(capTailAtParagraph(text, 40)).toBe('第三段'.repeat(10));
  });

  test('capTailAtParagraph falls back to a hard cut when paragraphs are huge', () => {
    const text = `${'a'.repeat(1000)}\n\n${'b'.repeat(100)}`;
    // the only boundary would give up almost the whole budget
    expect(capTailAtParagraph(text, 800)).toHaveLength(800);
    expect(capTailAtParagraph('x'.repeat(50), 20)).toBe('x'.repeat(20));
    // never starts on half a surrogate pair
    const emoji = '😀'.repeat(20);
    const cut = capTailAtParagraph(emoji, 9);
    expect(cut.codePointAt(0)).toBe(0x1f600);
  });

  test('capTailByBytes stays inside the byte budget and says it cut', () => {
    const paragraph = '思考内容'.repeat(40);
    const text = Array.from({ length: 6 }, () => paragraph).join('\n\n');
    const capped = capTailByBytes(text, 1000);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(1000);
    expect(capped.startsWith('…\n\n')).toBe(true);
    expect(text.endsWith(capped.slice(3))).toBe(true);
    // a cut that lands on a paragraph start keeps whole paragraphs
    expect(capped.slice(3).startsWith('思考内容')).toBe(true);
    expect(capTailByBytes('short', 1000)).toBe('short');
  });
});

describe('ThinkingTextBuffer', () => {
  const buffer = () => new ThinkingTextBuffer((text) => text);
  const delta = (text: string, extra: Partial<StreamEvent> = {}) =>
    ev('thinking_delta', { text, ...extra });

  test('consecutive deltas of one block join without a break', () => {
    const b = buffer();
    b.observe(delta('先'));
    b.observe(delta('想想'));
    expect(b.text).toBe('先想想');
  });

  test('a new block is separated by a blank line however it is announced', () => {
    const viaStart = buffer();
    viaStart.observe(ev('thinking_start'));
    viaStart.observe(delta('甲'));
    viaStart.observe(ev('thinking_end'));
    viaStart.observe(ev('thinking_start'));
    viaStart.observe(delta('乙'));
    expect(viaStart.text).toBe('甲\n\n乙');

    // an old Runner sends neither start nor end: the tool call in between does
    const viaTool = buffer();
    viaTool.observe(delta('甲'));
    viaTool.observe(ev('tool_use_start', { toolName: 'Bash' }));
    viaTool.observe(delta('乙'));
    expect(viaTool.text).toBe('甲\n\n乙');

    const viaRequest = buffer();
    viaRequest.observe(delta('甲'));
    viaRequest.observe(ev('status', { statusText: 'requesting' }));
    viaRequest.observe(delta('乙'));
    expect(viaRequest.text).toBe('甲\n\n乙');
  });

  test('no second break after text that already ends with one', () => {
    const b = buffer();
    b.observe(delta('第一部分\n\n'));
    b.observe(ev('thinking_end'));
    b.observe(delta('第二部分'));
    expect(b.text).toBe('第一部分\n\n第二部分');
  });

  test('sub-agent reasoning and empty deltas are not part of it', () => {
    const b = buffer();
    b.observe(delta('子', { parentToolUseId: 'k1' }));
    b.observe(delta(''));
    expect(b.text).toBe('');
  });

  test('the cap is applied after every append', () => {
    const b = new ThinkingTextBuffer((text) => text.slice(-5));
    b.observe(delta('123456789'));
    expect(b.text).toBe('56789');
  });
});

describe('ThinkingClock', () => {
  test('a burst that arrives whole is timed from the model request', () => {
    const clock = new ThinkingClock(0);
    clock.observe(ev('status', { statusText: 'requesting' }), 1_000);
    clock.observe(ev('thinking_delta', { text: '想' }), 14_600);
    expect(clock.isThinking).toBe(true);
    expect(clock.startedAt).toBe(1_000);
    expect(clock.totalMs(15_000)).toBe(14_000);
    clock.observe(ev('text_delta', { text: '答' }), 15_000);
    expect(clock.isThinking).toBe(false);
    expect(clock.durationMs).toBe(14_000);
    expect(clock.phaseStartedAt).toBeUndefined();
  });

  test('the first burst of a run starts at the run when nothing is known', () => {
    const clock = new ThinkingClock(500);
    clock.observe(ev('thinking_start'), 2_500);
    clock.observe(ev('thinking_end'), 3_000);
    expect(clock.durationMs).toBe(2_500);
    expect(clock.sawThinking).toBe(true);
  });

  test('the length the Runner measured wins when it is longer', () => {
    const clock = new ThinkingClock();
    clock.observe(ev('thinking_start'), 10_000);
    clock.observe(ev('thinking_end', { thinkingDurationMs: 4_000 }), 10_500);
    expect(clock.durationMs).toBe(4_000);
  });

  test('after a tool returns, the next burst starts when the model took over', () => {
    const clock = new ThinkingClock(0);
    clock.observe(ev('thinking_start'), 1_000);
    clock.observe(ev('tool_use_start', { toolName: 'Bash' }), 2_000);
    expect(clock.durationMs).toBe(2_000);
    clock.observe(ev('tool_use_end', { toolUseId: 't1' }), 5_000);
    expect(clock.awaitingModel).toBe(true);
    expect(clock.phaseStartedAt).toBe(5_000);
    clock.observe(ev('thinking_delta', { text: '再想' }), 8_000);
    expect(clock.startedAt).toBe(5_000);
    expect(clock.awaitingModel).toBe(false);
    clock.observe(ev('text_delta', { text: '好' }), 9_000);
    expect(clock.durationMs).toBe(2_000 + 4_000);
  });

  test('sub-agent events, empty deltas and idle runs do not move it', () => {
    const clock = new ThinkingClock(0);
    clock.observe(
      ev('thinking_delta', { text: '子', parentToolUseId: 'k1' }),
      1,
    );
    clock.observe(ev('thinking_delta', { text: '' }), 2);
    clock.observe(ev('text_delta', { text: '子答', parentToolUseId: 'k1' }), 3);
    expect(clock.isThinking).toBe(false);
    expect(clock.sawThinking).toBe(false);
    clock.observe(ev('thinking_start'), 10);
    clock.observe(ev('status', { statusText: 'interrupted' }), 40);
    expect(clock.isThinking).toBe(false);
    expect(clock.durationMs).toBe(40);
  });

  test('totalMs counts a burst that is still open', () => {
    const clock = new ThinkingClock(0);
    clock.observe(ev('thinking_start'), 100);
    expect(clock.totalMs(350)).toBe(350);
  });
});
