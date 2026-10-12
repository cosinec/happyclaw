import { describe, expect, test } from 'vitest';

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import { MAX_STEPS, type StreamingStep } from '../src/stream-steps.js';
import {
  capStepsThinkingBytes,
  parseStoredSteps,
  TurnStepRecorder,
  viewSteps,
} from '../src/turn-steps.js';

function ev(
  eventType: StreamEventType,
  extra: Partial<StreamEvent> = {},
): StreamEvent {
  return { eventType, ...extra } as StreamEvent;
}

/** Feed `[time, event]` pairs and settle at `end`. */
function record(
  script: Array<[number, StreamEvent]>,
  end: number,
  options: { proactive?: boolean; runStartedAt?: number } = {},
): StreamingStep[] {
  const recorder = new TurnStepRecorder(options.runStartedAt ?? 0, {
    proactive: options.proactive,
  });
  for (const [at, event] of script) recorder.observe(event, at);
  return recorder.settled(end).steps;
}

/** A turn of the shape the product is about: reasoning, a note, tools, answer. */
const FULL_TURN: Array<[number, StreamEvent]> = [
  [0, ev('status', { statusText: 'requesting' })],
  [50, ev('thinking_start')],
  [100, ev('thinking_delta', { text: '**读取配置**\n\n先看一下目录结构。' })],
  [900, ev('thinking_end', { thinkingDurationMs: 800 })],
  [950, ev('text_delta', { text: '我先列出文件。' })],
  [
    1000,
    ev('tool_use_start', {
      toolName: 'Bash',
      toolUseId: 'bash-1',
      toolInputSummary: 'ls -la',
    }),
  ],
  [
    1200,
    ev('tool_result', { toolUseId: 'bash-1', toolResult: 'a.txt\nb.txt' }),
  ],
  [1210, ev('tool_use_end', { toolUseId: 'bash-1' })],
  [1220, ev('status', { statusText: 'requesting' })],
  [1300, ev('thinking_start')],
  [1400, ev('thinking_delta', { text: '**比较方案**\n\n两个入口。' })],
  [2000, ev('thinking_end', { thinkingDurationMs: 900 })],
  [
    2050,
    ev('tool_use_start', {
      toolName: 'Read',
      toolUseId: 'read-1',
      toolInputSummary: 'file: a.txt',
    }),
  ],
  [2100, ev('tool_use_end', { toolUseId: 'read-1' })],
  [2120, ev('status', { statusText: 'requesting' })],
  [2600, ev('thinking_delta', { text: '**收尾**\n\n可以回答了。' })],
  [3000, ev('text_delta', { text: '答案：' })],
  [3100, ev('text_delta', { text: '完成。' })],
];

describe('TurnStepRecorder', () => {
  test('records reasoning, a note, tools and more reasoning in order, without the answer', () => {
    const steps = record(FULL_TURN, 3500);
    expect(steps.map((s) => [s.kind, s.status, s.title ?? s.toolName])).toEqual(
      [
        ['thinking', 'done', '读取配置'],
        ['text', 'done', undefined],
        ['tool', 'done', 'Bash'],
        ['thinking', 'done', '比较方案'],
        ['tool', 'done', 'Read'],
        ['thinking', 'done', '收尾'],
      ],
    );
    // the note is the model's words before the call, cut from the whole reply
    expect(steps[1].text).toBe('我先列出文件。');
    expect(steps[2]).toMatchObject({
      toolUseId: 'bash-1',
      summary: 'ls -la',
      resultPreview: 'a.txt b.txt',
    });
    // the last text is the answer: it is the message itself, not a step
    expect(steps.some((s) => s.text?.includes('答案'))).toBe(false);
  });

  test('times each burst from the request that began it', () => {
    const steps = record(FULL_TURN, 3500);
    const thinking = steps.filter((s) => s.kind === 'thinking');
    // the first burst began with the run, the later ones where the model took
    // over again (the tool ended / the request was sent)
    expect(thinking.map((s) => [s.at, s.endedAt, s.durationMs])).toEqual([
      [0, 900, 900],
      [1220, 2000, 900],
      [2120, 3000, 880],
    ]);
  });

  test('settles what is still running when the turn ends', () => {
    const steps = record(
      [
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' })],
        [10, ev('thinking_delta', { text: '想' })],
      ],
      500,
    );
    expect(steps.map((s) => [s.kind, s.status, s.endedAt])).toEqual([
      ['tool', 'done', 500],
      ['thinking', 'done', 500],
    ]);
  });

  test('a stopped turn marks the tool that never reported back as failed', () => {
    const recorder = new TurnStepRecorder(0);
    recorder.observe(ev('thinking_delta', { text: '想' }), 10);
    recorder.observe(
      ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' }),
      20,
    );
    recorder.observe(ev('status', { statusText: 'interrupted' }), 100);
    const [thinking, tool] = recorder.settled(5_000).steps;
    expect(thinking).toMatchObject({ kind: 'thinking', status: 'done' });
    expect(tool).toMatchObject({
      kind: 'tool',
      status: 'error',
      endedAt: 100,
      resultPreview: '已停止',
    });
  });

  test('a permission denial fails the call it denied', () => {
    const steps = record(
      [
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' })],
        [
          10,
          ev('permission_denied', {
            permissionDenied: {
              toolName: 'Bash',
              toolUseId: 'b',
              message: 'denied',
              reason: 'not allowed here',
            },
          }),
        ],
      ],
      100,
    );
    expect(steps[0]).toMatchObject({
      status: 'error',
      resultPreview: 'not allowed here',
      endedAt: 10,
    });
  });

  test('a failed tool result marks the step as failed', () => {
    const steps = record(
      [
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' })],
        [10, ev('tool_result', { toolUseId: 'b', toolResult: '⚠️ exit 1' })],
      ],
      100,
    );
    expect(steps[0]).toMatchObject({
      status: 'error',
      resultPreview: 'exit 1',
    });
  });

  test('progress fills the tool step in and starts one it never saw', () => {
    const steps = record(
      [
        [0, ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' })],
        [
          10,
          ev('tool_progress', {
            toolUseId: 'b',
            toolName: 'Bash',
            toolInputSummary: 'npm test',
          }),
        ],
        [
          20,
          ev('tool_progress', {
            toolUseId: 'late',
            toolName: 'Grep',
            toolInputSummary: 'foo',
          }),
        ],
      ],
      100,
    );
    expect(steps.map((s) => [s.toolName, s.summary])).toEqual([
      ['Bash', 'npm test'],
      ['Grep', 'foo'],
    ]);
  });

  test('a sub-agent is one task step; its own events are not steps', () => {
    const steps = record(
      [
        [0, ev('thinking_delta', { text: '分派。' })],
        [
          10,
          ev('tool_use_start', {
            toolName: 'Task',
            toolUseId: 'task-1',
            toolInputSummary: 'research',
          }),
        ],
        [
          11,
          ev('task_start', {
            toolUseId: 'task-1',
            taskId: 'task-1',
            taskDescription: '调研依赖',
          }),
        ],
        // the sub-agent's own tool, reasoning and text
        [
          20,
          ev('tool_use_start', {
            toolName: 'Read',
            toolUseId: 'sub-1',
            parentToolUseId: 'task-1',
          }),
        ],
        [
          25,
          ev('thinking_delta', {
            text: '子代理在想',
            parentToolUseId: 'task-1',
          }),
        ],
        [
          26,
          ev('text_delta', { text: '子代理在说', parentToolUseId: 'task-1' }),
        ],
        [
          30,
          ev('tool_use_end', { toolUseId: 'sub-1', parentToolUseId: 'task-1' }),
        ],
        [
          40,
          ev('task_progress', {
            toolUseId: 'task-1',
            taskId: 'task-1',
            summary: '读了 3 个文件',
          }),
        ],
        [
          90,
          ev('task_notification', {
            toolUseId: 'task-1',
            taskId: 'task-1',
            taskStatus: 'completed',
            taskSummary: '依赖已梳理',
          }),
        ],
        [95, ev('tool_use_end', { toolUseId: 'task-1' })],
      ],
      100,
    );
    expect(steps.map((s) => s.kind)).toEqual(['thinking', 'task']);
    expect(steps[1]).toMatchObject({
      taskId: 'task-1',
      toolUseId: 'task-1',
      title: '调研依赖',
      summary: '依赖已梳理',
      status: 'done',
      endedAt: 90,
    });
    expect(JSON.stringify(steps)).not.toContain('子代理');
  });

  test('a failed task and a background one keep their own lifecycle', () => {
    const steps = record(
      [
        [
          0,
          ev('tool_use_start', {
            toolName: 'Agent',
            toolUseId: 't-fail',
          }),
        ],
        [
          5,
          ev('task_updated', {
            taskId: 't-fail',
            toolUseId: 't-fail',
            taskPatch: { status: 'failed', error: 'boom' },
          }),
        ],
        [
          10,
          ev('task_start', {
            taskId: 't-bg',
            toolUseId: 't-bg',
            taskDescription: '后台',
          }),
        ],
        [
          20,
          ev('task_updated', {
            taskId: 't-bg',
            toolUseId: 't-bg',
            taskPatch: { is_backgrounded: true },
          }),
        ],
      ],
      100,
    );
    expect(steps.map((s) => [s.taskId, s.status, s.summary])).toEqual([
      ['t-fail', 'error', 'boom'],
      // still running when the turn settles: settled as done
      ['t-bg', 'done', undefined],
    ]);
  });

  test('a tool nested under a skill is the models own call', () => {
    const steps = record(
      [
        [
          0,
          ev('tool_use_start', {
            toolName: 'Skill',
            toolUseId: 'skill-1',
            skillName: 'pdf',
          }),
        ],
        [
          10,
          ev('tool_use_start', {
            toolName: 'Bash',
            toolUseId: 'nested-1',
            parentToolUseId: 'skill-1',
            isNested: true,
          }),
        ],
      ],
      100,
    );
    expect(steps.map((s) => [s.toolName, s.skillName])).toEqual([
      ['Skill', 'pdf'],
      ['Bash', undefined],
    ]);
  });

  test('text before a tool is kept as a note, text after the last tool is not', () => {
    const steps = record(
      [
        [0, ev('text_delta', { text: '先看' })],
        [5, ev('text_delta', { text: '一下。' })],
        [10, ev('tool_use_start', { toolName: 'Read', toolUseId: 'r' })],
        [20, ev('tool_use_end', { toolUseId: 'r' })],
        [30, ev('text_delta', { text: '结论。' })],
      ],
      40,
    );
    expect(steps.map((s) => [s.kind, s.text])).toEqual([
      ['text', '先看一下。'],
      ['tool', undefined],
    ]);
  });

  test('text that reopens after reasoning is a note of its own, not a copy of the one before', () => {
    const steps = record(
      [
        [0, ev('text_delta', { text: '先读配置。' })],
        [10, ev('thinking_delta', { text: '再想想' })],
        [20, ev('text_delta', { text: '然后看日志。' })],
        [30, ev('tool_use_start', { toolName: 'Read', toolUseId: 'r1' })],
        [40, ev('tool_use_end', { toolUseId: 'r1' })],
        [50, ev('text_delta', { text: '最后跑测试。' })],
        [60, ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b1' })],
        [70, ev('text_delta', { text: '全部通过。' })],
      ],
      100,
    );
    expect(steps.map((s) => [s.kind, s.text ?? s.toolName])).toEqual([
      ['text', '先读配置。'],
      ['thinking', '再想想'],
      ['text', '然后看日志。'],
      ['tool', 'Read'],
      ['text', '最后跑测试。'],
      ['tool', 'Bash'],
    ]);
  });

  test('reasoning that returns no text is a step with the time it took', () => {
    const steps = record(
      [
        [0, ev('status', { statusText: 'requesting' })],
        [13_000, ev('thinking_start')],
        [13_000, ev('thinking_end', { thinkingDurationMs: 3 })],
      ],
      14_000,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: 'thinking',
      text: '',
      at: 0,
      durationMs: 13_000,
    });
  });

  test('reasoning before the first event begins at the start of the run', () => {
    const steps = record([[500, ev('thinking_delta', { text: '想' })]], 900, {
      runStartedAt: 100,
    });
    expect(steps[0]).toMatchObject({ at: 100, endedAt: 900, status: 'done' });
  });

  test('an empty delta opens nothing', () => {
    expect(
      record(
        [
          [0, ev('thinking_delta', { text: '' })],
          [1, ev('text_delta', { text: '' })],
        ],
        10,
      ),
    ).toEqual([]);
  });

  test('keeps only the newest MAX_STEPS and counts the rest', () => {
    const recorder = new TurnStepRecorder(0);
    for (let i = 0; i < MAX_STEPS + 15; i += 1) {
      recorder.observe(
        ev('tool_use_start', { toolName: 'Read', toolUseId: `r${i}` }),
        i,
      );
      recorder.observe(ev('tool_use_end', { toolUseId: `r${i}` }), i);
    }
    const { steps, dropped } = recorder.settled(1_000);
    expect(steps).toHaveLength(MAX_STEPS);
    expect(dropped).toBe(15);
    expect(steps[0].toolUseId).toBe('r15');
    expect(steps.at(-1)!.toolUseId).toBe(`r${MAX_STEPS + 14}`);
  });

  test('settling does not disturb a recorder that goes on', () => {
    const recorder = new TurnStepRecorder(0);
    recorder.observe(
      ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' }),
      10,
    );
    expect(recorder.settled(50).steps[0]).toMatchObject({
      status: 'done',
      endedAt: 50,
    });
    recorder.observe(ev('tool_use_end', { toolUseId: 'b' }), 80);
    expect(recorder.settled(100).steps[0]).toMatchObject({
      status: 'done',
      endedAt: 80,
    });
  });

  test('has nothing worth keeping until a step that is not the reply itself', () => {
    const recorder = new TurnStepRecorder(0);
    expect(recorder.isEmpty).toBe(true);
    recorder.observe(ev('text_delta', { text: '你好' }), 10);
    expect(recorder.isEmpty).toBe(true);
    recorder.observe(
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
      20,
    );
    expect(recorder.isEmpty).toBe(false);
  });

  test('a narration the host composes is not recorded', () => {
    const steps = record(
      [
        [0, ev('thinking_delta', { text: '想' })],
        [10, ev('commentary', { text: '我先读文件。' })],
        [20, ev('tool_use_start', { toolName: 'Read', toolUseId: 'r' })],
      ],
      30,
      { proactive: true },
    );
    expect(steps.map((s) => s.kind)).toEqual(['thinking', 'tool']);
    expect(JSON.stringify(steps)).not.toContain('我先读文件');
  });
});

describe('the speech tool of a proactive turn', () => {
  const SPEECH = 'mcp__happyclaw__send_message';
  const script: Array<[number, StreamEvent]> = [
    [0, ev('thinking_start')],
    [10, ev('thinking_delta', { text: '决定回复。' })],
    [100, ev('tool_use_start', { toolName: SPEECH, toolUseId: 'say-1' })],
    [
      110,
      ev('tool_progress', { toolUseId: 'say-1', toolInputSummary: '你好' }),
    ],
    [120, ev('tool_result', { toolUseId: 'say-1' })],
    [130, ev('tool_use_end', { toolUseId: 'say-1' })],
    [200, ev('tool_use_start', { toolName: 'Read', toolUseId: 'read-1' })],
  ];

  test('is never a step, whatever the id of its later events', () => {
    const steps = record(script, 300, { proactive: true });
    expect(steps.map((s) => [s.kind, s.toolName])).toEqual([
      ['thinking', undefined],
      ['tool', 'Read'],
    ]);
    expect(JSON.stringify(steps)).not.toContain('say-1');
    expect(JSON.stringify(steps)).not.toContain('你好');
  });

  test('still ends the reasoning before it', () => {
    const [thinking] = record(script, 300, { proactive: true });
    expect(thinking).toMatchObject({ status: 'done', endedAt: 100 });
  });

  test('is an ordinary tool step in an Assistant turn, as it is on screen', () => {
    const steps = record(script, 300, { proactive: false });
    expect(steps.map((s) => s.toolName)).toEqual([undefined, SPEECH, 'Read']);
  });
});

describe('a held reply sequence', () => {
  test('puts the later part after the earlier one, with unique ids', () => {
    const first = new TurnStepRecorder(0);
    first.observe(ev('thinking_delta', { text: '甲' }), 100);
    first.observe(ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }), 200);
    first.observe(ev('text_delta', { text: '第一段回答' }), 300);
    const second = new TurnStepRecorder(1_000);
    second.observe(ev('thinking_delta', { text: '乙' }), 1_100);
    second.observe(
      ev('tool_use_start', { toolName: 'B', toolUseId: 'b' }),
      1_200,
    );
    second.observe(ev('text_delta', { text: '第二段回答' }), 1_300);

    first.absorb(second, 2_000);
    const { steps, dropped } = first.settled(2_000);
    expect(steps.map((s) => [s.kind, s.toolName, s.text])).toEqual([
      ['thinking', undefined, '甲'],
      ['tool', 'A', undefined],
      ['thinking', undefined, '乙'],
      ['tool', 'B', undefined],
    ]);
    expect(dropped).toBe(0);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    // the earlier part ended where its last event was, the later one now
    expect(steps[1].endedAt).toBe(300);
    expect(steps[3].endedAt).toBe(2_000);
  });

  test('keeps the newest MAX_STEPS across the parts', () => {
    const make = (prefix: string, start: number, count: number) => {
      const r = new TurnStepRecorder(0);
      for (let i = 0; i < count; i += 1) {
        r.observe(
          ev('tool_use_start', { toolName: 'T', toolUseId: `${prefix}${i}` }),
          start + i,
        );
      }
      return r;
    };
    const first = make('a', 0, 80);
    first.absorb(make('b', 1_000, 60), 2_000);
    const { steps, dropped } = first.settled(2_000);
    expect(steps).toHaveLength(MAX_STEPS);
    expect(dropped).toBe(40);
    expect(steps[0].toolUseId).toBe('a40');
    expect(steps.at(-1)!.toolUseId).toBe('b59');
  });

  test('an empty later part adds nothing', () => {
    const first = new TurnStepRecorder(0);
    first.observe(ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }), 10);
    first.absorb(new TurnStepRecorder(0), 100);
    expect(first.settled(100).steps).toHaveLength(1);
  });
});

describe('viewSteps and capStepsThinkingBytes', () => {
  const steps: StreamingStep[] = [
    {
      id: 'thinking-0',
      kind: 'thinking',
      at: 0,
      endedAt: 900,
      durationMs: 900,
      status: 'done',
      text: '**读取配置**\n\n先看一下。',
      title: '读取配置',
    },
    { id: 'text-1', kind: 'text', at: 1, status: 'done', text: '我先看文件。' },
    {
      id: 'tool-1',
      kind: 'tool',
      at: 2,
      status: 'done',
      toolUseId: 'r',
      toolName: 'Read',
    },
    {
      id: 'tool-2',
      kind: 'tool',
      at: 3,
      status: 'done',
      toolUseId: 's',
      toolName: 'mcp__happyclaw__send_message',
    },
  ];

  test('full shows everything of an Assistant turn', () => {
    expect(viewSteps(steps, { includeThinking: true })).toEqual(steps);
  });

  test('activity keeps the status and times of reasoning, but no text or title, and no notes', () => {
    const shown = viewSteps(steps, { includeThinking: false });
    expect(shown.map((s) => s.id)).toEqual(['thinking-0', 'tool-1', 'tool-2']);
    expect(shown[0]).toEqual({
      id: 'thinking-0',
      kind: 'thinking',
      at: 0,
      endedAt: 900,
      durationMs: 900,
      status: 'done',
    });
    expect(JSON.stringify(shown)).not.toContain('读取配置');
  });

  test('a proactive Workspace shows no speech tool and no model text but reasoning', () => {
    const shown = viewSteps(steps, { includeThinking: true, proactive: true });
    expect(shown.map((s) => s.id)).toEqual(['thinking-0', 'tool-1']);
    expect(shown[0].text).toBe('**读取配置**\n\n先看一下。');
  });

  test('the thinking text is cut from the oldest step, keeping its title and times', () => {
    const big = (id: string, n: number, filler: string): StreamingStep => ({
      id,
      kind: 'thinking',
      at: n,
      endedAt: n + 1,
      durationMs: 1,
      status: 'done',
      title: `标题${n}`,
      text: filler.repeat(1_000),
    });
    const input = [big('a', 0, 'a'), big('b', 1, 'b'), big('c', 2, 'c')];
    // 3 x 1000 bytes, room for 1500
    const capped = capStepsThinkingBytes(input, 1_500);
    const bytes = (s: StreamingStep) => Buffer.byteLength(s.text ?? '', 'utf8');
    expect(capped[0].text).toBeUndefined();
    expect(capped[0]).toMatchObject({ title: '标题0', at: 0, durationMs: 1 });
    expect(capped[1].text!.startsWith('…\n\n')).toBe(true);
    expect(capped[1].text!.endsWith('b'.repeat(100))).toBe(true);
    expect(capped[2].text).toBe('c'.repeat(1_000));
    expect(
      bytes(capped[0]) + bytes(capped[1]) + bytes(capped[2]),
    ).toBeLessThanOrEqual(1_500);
    // untouched when it fits
    expect(capStepsThinkingBytes(input, 10_000)).toBe(input);
  });
});

describe('parseStoredSteps', () => {
  test('reads what was stored and nothing else', () => {
    const stored: StreamingStep[] = [
      {
        id: 'tool-1',
        kind: 'tool',
        at: 1,
        endedAt: 2,
        status: 'done',
        toolUseId: 'r',
        toolName: 'Read',
        summary: 'a.ts',
        resultPreview: 'ok',
      },
    ];
    expect(parseStoredSteps(JSON.stringify(stored))).toEqual(stored);
    // an unknown field is not passed on
    const [step] = parseStoredSteps(
      JSON.stringify([{ ...stored[0], secret: 'x', toolInput: { a: 1 } }]),
    );
    expect(step).toEqual(stored[0]);
  });

  test('damaged json, a non-array and unusable rows read as no steps', () => {
    expect(parseStoredSteps('{nope')).toEqual([]);
    expect(parseStoredSteps('{"a":1}')).toEqual([]);
    expect(parseStoredSteps('')).toEqual([]);
    expect(
      parseStoredSteps(
        JSON.stringify([
          null,
          5,
          'x',
          { id: 'x', kind: 'weird', status: 'done', at: 1 },
          { id: 'x', kind: 'tool', status: 'weird', at: 1 },
          { id: 'x', kind: 'tool', status: 'done', at: 'soon' },
          { kind: 'tool', status: 'done', at: 1 },
          { id: 'ok', kind: 'tool', status: 'done', at: 1 },
        ]),
      ).map((s) => s.id),
    ).toEqual(['ok']);
  });
});
