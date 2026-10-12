import { describe, expect, it } from 'vitest';
import {
  cleanToolSummary,
  describeGroup,
  describeSettled,
  formatSpanZh,
  groupProcessSteps,
  hasListedSteps,
  isReadOnlyStep,
  processSpanMs,
  stepDurationMs,
  summarizeGroup,
  summarizeSettled,
  summarizedSteps,
  toolCategory,
  visibleSteps,
} from '../src/lib/process-steps';
import { summarizeSteps, type StreamingStep } from '../src/lib/stream-steps';

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({ at: 1000, status: 'done', ...over });

const tool = (
  id: string,
  toolName: string,
  over: Partial<StreamingStep> = {},
) => step({ id, kind: 'tool', toolName, toolUseId: id, ...over });

describe('toolCategory', () => {
  it('sorts the known tools by what they work on', () => {
    expect(toolCategory('Bash')).toBe('terminal');
    expect(toolCategory('Read')).toBe('file');
    expect(toolCategory('Edit')).toBe('file');
    expect(toolCategory('Grep')).toBe('search');
    expect(toolCategory('Glob')).toBe('search');
    expect(toolCategory('WebFetch')).toBe('web');
    expect(toolCategory('mcp__docs__query')).toBe('generic');
    expect(toolCategory(undefined)).toBe('generic');
  });
});

describe('groupProcessSteps', () => {
  it('merges two or more read-only calls in a row into one group', () => {
    const items = groupProcessSteps([
      tool('a', 'Read'),
      tool('b', 'Grep'),
      tool('c', 'Glob'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'group', id: 'group-a' });
    expect(items[0].type === 'group' && items[0].steps).toHaveLength(3);
  });

  it('leaves a single read-only call a row of its own', () => {
    const items = groupProcessSteps([tool('a', 'Read')]);
    expect(items).toEqual([{ type: 'step', step: tool('a', 'Read') }]);
  });

  it('never merges a command, a write or a tool it does not know', () => {
    for (const name of ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch']) {
      const items = groupProcessSteps([
        tool('a', name),
        tool('b', name),
        tool('c', name),
      ]);
      expect(items.every((item) => item.type === 'step')).toBe(true);
    }
    expect(
      groupProcessSteps([tool('a', 'mcp__x__y'), tool('b', 'mcp__x__y')]),
    ).toHaveLength(2);
  });

  it('ends a run at anything that is not a read-only call', () => {
    const items = groupProcessSteps([
      tool('a', 'Read'),
      tool('b', 'Read'),
      tool('c', 'Bash'),
      tool('d', 'Read'),
      step({ id: 'think', kind: 'thinking' }),
      tool('e', 'Read'),
      tool('f', 'Grep'),
    ]);
    expect(items.map((item) => item.type)).toEqual([
      'group',
      'step',
      'step',
      'step',
      'group',
    ]);
  });

  it('names a group by its first call, so it keeps its identity as it grows', () => {
    const two = groupProcessSteps([tool('a', 'Read'), tool('b', 'Read')]);
    const three = groupProcessSteps([
      tool('a', 'Read'),
      tool('b', 'Read'),
      tool('c', 'Read'),
    ]);
    expect(two[0]).toMatchObject({ id: 'group-a' });
    expect(three[0]).toMatchObject({ id: 'group-a' });
  });

  it('knows which steps are read-only', () => {
    expect(isReadOnlyStep(tool('a', 'Read'))).toBe(true);
    expect(isReadOnlyStep(tool('a', 'LS'))).toBe(true);
    expect(isReadOnlyStep(tool('a', 'Bash'))).toBe(false);
    expect(isReadOnlyStep(step({ id: 't', kind: 'thinking' }))).toBe(false);
  });
});

describe('describeGroup', () => {
  it('counts the files looked at and the searches made', () => {
    const summary = summarizeGroup([
      tool('a', 'Read'),
      tool('b', 'Read'),
      tool('c', 'LS'),
      tool('d', 'Grep'),
      tool('e', 'Glob'),
    ]);
    expect(summary).toEqual({ files: 3, searches: 2, running: 0, failed: 0 });
    expect(describeGroup(summary)).toBe('已浏览 3 个文件 · 搜索 2 次');
  });

  it('reads right with only one of the two', () => {
    expect(
      describeGroup({ files: 4, searches: 0, running: 0, failed: 0 }),
    ).toBe('已浏览 4 个文件');
    expect(
      describeGroup({ files: 0, searches: 2, running: 0, failed: 0 }),
    ).toBe('已搜索 2 次');
  });

  it('is in the present tense while a call is running, and counts the failures', () => {
    const summary = summarizeGroup([
      tool('a', 'Read', { status: 'error' }),
      tool('b', 'Read', { status: 'running' }),
    ]);
    expect(summary).toMatchObject({ running: 1, failed: 1 });
    expect(describeGroup(summary)).toBe('正在浏览 2 个文件');
  });
});

describe('processSpanMs', () => {
  it('is the wall clock from the first step to the end of the last', () => {
    expect(
      processSpanMs([
        step({ id: 'a', kind: 'thinking', at: 1000, endedAt: 3000 }),
        tool('b', 'Read', { at: 3000, endedAt: 4500 }),
        tool('c', 'Bash', { at: 4000, endedAt: 15_000 }),
      ]),
    ).toBe(14_000);
  });

  it('falls back on the total it was given when the steps have no times', () => {
    const bare = [step({ id: 'a', kind: 'thinking', at: 1000 })];
    expect(processSpanMs(bare, 9000)).toBe(9000);
    expect(processSpanMs(bare)).toBeUndefined();
    expect(processSpanMs([], 5000)).toBe(5000);
    expect(processSpanMs([], -1)).toBeUndefined();
  });

  it('does not guess while something is still running', () => {
    expect(
      processSpanMs(
        [
          tool('a', 'Read', { at: 1000, endedAt: 2000 }),
          tool('b', 'Bash', { at: 2000, status: 'running' }),
        ],
        7000,
      ),
    ).toBe(7000);
  });

  it('uses a step\u2019s own duration when it has no end time', () => {
    expect(
      processSpanMs([
        step({ id: 'a', kind: 'thinking', at: 1000, durationMs: 4000 }),
      ]),
    ).toBe(4000);
  });

  it('knows how long one step took', () => {
    expect(stepDurationMs(tool('a', 'Read', { durationMs: 700 }))).toBe(700);
    expect(stepDurationMs(tool('a', 'Read', { at: 100, endedAt: 600 }))).toBe(
      500,
    );
    expect(stepDurationMs(tool('a', 'Read'))).toBeUndefined();
  });
});

describe('formatSpanZh', () => {
  it('reads as a span of time, and says nothing under a second', () => {
    expect(formatSpanZh(400)).toBe('');
    expect(formatSpanZh(undefined)).toBe('');
    expect(formatSpanZh(3200)).toBe('3.2 秒');
    expect(formatSpanZh(14_400)).toBe('14 秒');
    expect(formatSpanZh(72_000)).toBe('1 分 12 秒');
    expect(formatSpanZh(120_000)).toBe('2 分');
    expect(formatSpanZh(119_700)).toBe('2 分');
  });
});

describe('summarizeSettled', () => {
  const thinking = (id: string, at: number, endedAt: number) =>
    step({ id, kind: 'thinking', at, endedAt, durationMs: endedAt - at });

  it('says what the run did, how long it took, and what it used', () => {
    expect(
      summarizeSettled([
        thinking('t1', 0, 3000),
        tool('a', 'Read', { at: 3000, endedAt: 4000 }),
        thinking('t2', 4000, 6000),
        tool('b', 'Bash', { at: 6000, endedAt: 14_000 }),
      ]),
    ).toBe('已处理 14 秒 · 2 个工具 · 2 段思考');
  });

  it('is the reasoning alone when there was no tool', () => {
    expect(summarizeSettled([thinking('t1', 0, 12_000)])).toBe('已思考 12 秒');
    expect(summarizeSettled([thinking('t1', 0, 300)])).toBe('已思考');
  });

  it('is the tools alone when there was no reasoning', () => {
    expect(
      summarizeSettled([
        tool('a', 'Read', { at: 0, endedAt: 500 }),
        tool('b', 'Bash', { at: 500, endedAt: 9000 }),
      ]),
    ).toBe('已使用 2 个工具');
  });

  it('counts a sub-agent as a tool and the failures at the end', () => {
    expect(
      summarizeSettled([
        thinking('t1', 0, 2000),
        step({
          id: 'task-1',
          kind: 'task',
          taskId: 'task-1',
          at: 2000,
          endedAt: 9000,
        }),
        tool('b', 'Bash', { at: 9000, endedAt: 10_000, status: 'error' }),
      ]),
    ).toBe('已处理 10 秒 · 2 个工具 · 1 段思考 · 1 个失败');
  });

  it('takes the total it was given when the steps carry no times', () => {
    expect(
      summarizeSettled(
        [
          step({ id: 't1', kind: 'thinking', status: 'done' }),
          tool('a', 'Read', { at: 1000 }),
        ],
        20_000,
      ),
    ).toBe('已处理 20 秒 · 1 个工具 · 1 段思考');
  });

  it('leaves the answer and a question for the reader out of the count', () => {
    expect(
      summarizeSettled([
        tool('a', 'Read', { at: 0, endedAt: 500 }),
        tool('q', 'AskUserQuestion', { at: 500, endedAt: 600 }),
        step({
          id: 'text-1',
          kind: 'text',
          at: 700,
          endedAt: 800,
          text: '好了',
        }),
      ]),
    ).toBe('已使用 1 个工具');
  });

  it('has a line for notes alone, and for nothing it can name', () => {
    expect(
      describeSettled({
        tools: 0,
        tasks: 0,
        thinking: 0,
        commentary: 2,
        failed: 0,
      }),
    ).toBe('2 条过程说明');
    expect(
      describeSettled({
        tools: 0,
        tasks: 0,
        thinking: 0,
        commentary: 0,
        failed: 0,
      }),
    ).toBe('已处理');
  });
});

describe('what the card lists', () => {
  const steps = [
    step({ id: 'a', kind: 'thinking', endedAt: 2000, text: '想' }),
    step({ id: 'n', kind: 'text', text: '先看看', endedAt: 2500 }),
    tool('b', 'Read', { endedAt: 3000 }),
    step({
      id: 'ans',
      kind: 'text',
      text: '答案',
      at: 4000,
      status: 'running',
    }),
  ];

  it('drops the commentary unless it is asked for', () => {
    expect(visibleSteps(steps, true)).toHaveLength(4);
    expect(visibleSteps(steps, false).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('has something to show when the timeline would list a step', () => {
    expect(hasListedSteps(steps)).toBe(true);
    expect(hasListedSteps([])).toBe(false);
    // The answer alone is the text below the card, not a step of it.
    expect(
      hasListedSteps([
        step({ id: 'ans', kind: 'text', text: '答案', status: 'running' }),
      ]),
    ).toBe(false);
  });

  it('sums up the listed steps, not the answer', () => {
    expect(summarizeSteps(summarizedSteps(steps))).toMatchObject({
      tools: 1,
      thinking: 1,
      commentary: 1,
    });
  });
});

describe('cleanToolSummary', () => {
  it('takes the label off what a call was given', () => {
    expect(cleanToolSummary('command: ls -la && echo done')).toBe(
      'ls -la && echo done',
    );
    expect(cleanToolSummary('pattern: createSession')).toBe('createSession');
    expect(cleanToolSummary('query: react hooks')).toBe('react hooks');
  });

  it('reads the object out of a summary that is JSON', () => {
    expect(cleanToolSummary('{"file_path":"/repo/web/a.ts"}')).toBe(
      '/repo/web/a.ts',
    );
    expect(cleanToolSummary('{"path":"C:\\\\x\\\\y","limit":10}')).toBe(
      'C:\\x\\y',
    );
    // Cut short by the runner.
    expect(cleanToolSummary('{"file_path":"/repo/web/very/long/pa…')).toBe(
      '/repo/web/very/long/pa…',
    );
  });

  it('leaves anything else as it is', () => {
    expect(cleanToolSummary('npm test')).toBe('npm test');
    expect(cleanToolSummary('{"limit":10}')).toBe('{"limit":10}');
    expect(cleanToolSummary('  ')).toBeUndefined();
    expect(cleanToolSummary(undefined)).toBeUndefined();
  });
});
