import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GroupInfo,
  Message,
  StreamEvent,
  StreamSnapshotData,
} from '../web/src/stores/chat';
import {
  THINKING_OMITTED_MARKER,
  MAX_THINKING_TEXT,
} from '../web/src/lib/thinking-text';
import { answerStart } from '../web/src/lib/stream-steps';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
    delete: vi.fn(),
  },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

const JID = 'web:timeline';
const RUN = 'run-1';

const rafCallbacks: FrameRequestCallback[] = [];
function flushRaf(): void {
  for (const cb of rafCallbacks.splice(0)) cb(0);
}

function reset(): void {
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      messages: { [JID]: [] },
      waiting: {},
      activeRuns: {},
      streaming: {},
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stopRequests: {},
      settledStreaming: {},
      pendingThinking: {},
      pendingThinkingDuration: {},
      clearing: {},
      agents: {},
      agentStreaming: {},
      activeAgentTab: {},
      agentMessages: {},
      agentWaiting: {},
      agentHasMore: {},
      unreadReplies: {},
    },
    true,
  );
}

function emit(event: StreamEvent, agentId?: string): void {
  useChatStore.getState().handleStreamEvent(JID, event, agentId, RUN);
}

/** Emit a thinking or text delta and let the frame apply it. */
function delta(kind: 'thinking_delta' | 'text_delta', text: string): void {
  emit({ eventType: kind, text });
  flushRaf();
}

function tool(id: string, name = 'Read', summary?: string): void {
  emit({
    eventType: 'tool_use_start',
    toolName: name,
    toolUseId: id,
    toolInputSummary: summary,
  });
}

const live = () => useChatStore.getState().streaming[JID]!;

function setWorkspace(
  mode: 'assistant' | 'proactive',
  visibility?: 'hidden' | 'activity' | 'full',
): void {
  useChatStore.setState({
    groups: {
      [JID]: {
        name: 'w',
        folder: 'timeline',
        added_at: '2026-01-01T00:00:00.000Z',
        interaction_mode: mode,
        process_visibility: visibility,
      } as GroupInfo,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rafCallbacks.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
  reset();
  useChatStore.getState().handleRunStarted(JID, RUN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reasoning text', () => {
  it('separates bursts with a blank line, not the first one', () => {
    delta('thinking_delta', '先读文件。');
    expect(live().thinkingText).toBe('先读文件。');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('thinking_delta', '再比较方案。');
    expect(live().thinkingText).toBe('先读文件。\n\n再比较方案。');
    delta('thinking_delta', '继续。');
    expect(live().thinkingText).toBe('先读文件。\n\n再比较方案。继续。');
  });

  it('opens a burst at thinking_start without adding a second gap', () => {
    delta('thinking_delta', '第一段。');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    emit({ eventType: 'thinking_start' });
    expect(live().isThinking).toBe(true);
    delta('thinking_delta', '第二段。');
    expect(live().thinkingText).toBe('第一段。\n\n第二段。');
    expect(live().steps?.filter((s) => s.kind === 'thinking')).toHaveLength(2);
  });

  it('is thinking from thinking_start even with no text at all', () => {
    emit({ eventType: 'status', statusText: 'requesting' });
    emit({ eventType: 'thinking_start' });
    expect(live().isThinking).toBe(true);
    expect(live().thinkingText).toBe('');
    expect(live().awaitingModel).toBe(false);
    emit({ eventType: 'thinking_end', thinkingDurationMs: 4200 });
    expect(live().isThinking).toBe(false);
    expect(live().thinkingDurationMs).toBe(4200);
    expect(live().steps?.[0]).toMatchObject({
      kind: 'thinking',
      status: 'done',
      durationMs: 4200,
    });
  });

  it('adds up the models own timing over bursts', () => {
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 1500 });
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 2500 });
    expect(live().thinkingDurationMs).toBe(4000);
    // Text after the end does not count the burst a second time.
    delta('text_delta', '回答');
    expect(live().thinkingDurationMs).toBe(4000);
  });

  it('keeps timing by the clock when the runner sends no thinking events', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    delta('thinking_delta', '想');
    vi.setSystemTime(new Date('2026-10-10T00:00:05.000Z'));
    delta('text_delta', '答');
    expect(live().thinkingDurationMs).toBeGreaterThanOrEqual(5000);
  });

  it('ignores a sub-agents thinking events', () => {
    emit({ eventType: 'thinking_start', parentToolUseId: 'task-1' });
    emit({
      eventType: 'thinking_end',
      parentToolUseId: 'task-1',
      thinkingDurationMs: 9000,
    });
    expect(live()?.isThinking ?? false).toBe(false);
    expect(live()?.thinkingDurationMs).toBeUndefined();
  });

  it('keeps a title for the collapsed label', () => {
    delta('thinking_delta', '**确认订阅范围**\n\n先看 store。');
    expect(live().thinkingTitle).toBe('确认订阅范围');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('thinking_delta', '**比较方案**\n\n两种做法。');
    expect(live().thinkingTitle).toBe('比较方案');
  });

  it('bounds the text at a paragraph and says what it dropped', () => {
    const paragraph = (i: number) => `第 ${i} 段：${'思考内容'.repeat(25)}。`;
    for (let i = 0; i < 400; i += 1) {
      delta('thinking_delta', `${i === 0 ? '' : '\n\n'}${paragraph(i)}`);
    }
    const text = live().thinkingText;
    expect(text.length).toBeLessThanOrEqual(MAX_THINKING_TEXT);
    expect(text.startsWith(`${THINKING_OMITTED_MARKER}\n\n`)).toBe(true);
    expect(text.endsWith(paragraph(399))).toBe(true);
    const first = text.slice(THINKING_OMITTED_MARKER.length + 2);
    expect(first.startsWith('第 ')).toBe(true);
  });
});

describe('the wait for the model', () => {
  it('is the model at work from the request, until something comes back', () => {
    emit({ eventType: 'status', statusText: 'requesting' });
    expect(live().awaitingModel).toBe(true);
    expect(live().phaseStartedAt).toBeTypeOf('number');
    delta('thinking_delta', '想');
    expect(live().awaitingModel).toBe(false);

    emit({ eventType: 'status', statusText: 'requesting' });
    expect(live().awaitingModel).toBe(true);
    delta('text_delta', '答');
    expect(live().awaitingModel).toBe(false);
  });

  it('is cleared by a tool start too', () => {
    emit({ eventType: 'status', statusText: 'requesting' });
    tool('t1');
    expect(live().awaitingModel).toBe(false);
  });
});

describe('steps', () => {
  it('lists reasoning, tools and the answer in the order they happened', () => {
    delta('thinking_delta', '**计划**\n\n先读。');
    tool('t1', 'Read', 'a.ts');
    emit({ eventType: 'tool_result', toolUseId: 't1', toolResult: 'ok' });
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('text_delta', '结论。');
    const steps = live().steps!;
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      'thinking:done',
      'tool:done',
      'text:running',
    ]);
    expect(steps[0].title).toBe('计划');
    expect(steps[1]).toMatchObject({
      toolName: 'Read',
      summary: 'a.ts',
      resultPreview: 'ok',
    });
    expect(answerStart(steps, live().partialBase ?? 0)).toBe(0);
  });

  it('turns text before a tool into commentary and puts the answer after it', () => {
    delta('text_delta', '我先看一下文件。');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('text_delta', '结论如下。');
    const state = live();
    expect(state.partialText).toBe('我先看一下文件。结论如下。');
    const kinds = state.steps!.map((s) => s.kind);
    expect(kinds).toEqual(['text', 'tool', 'text']);
    expect(state.steps![0]).toMatchObject({
      status: 'done',
      text: '我先看一下文件。',
    });
    const start = answerStart(state.steps, state.partialBase ?? 0)!;
    expect(state.partialText.slice(start)).toBe('结论如下。');
  });

  it('updates a tool in place and does not write a trace row per progress', () => {
    tool('t1', 'Bash');
    const rows = live().traceEvents.length;
    for (let i = 0; i < 30; i += 1) {
      emit({
        eventType: 'tool_progress',
        toolUseId: 't1',
        toolName: 'Bash',
        elapsedSeconds: i,
        toolInputSummary: i === 5 ? 'npm test' : undefined,
      });
    }
    expect(live().traceEvents).toHaveLength(rows);
    expect(live().steps![0].summary).toBe('npm test');
    const row = live().traceEvents.find((r) => r.toolUseId === 't1');
    expect(row).toMatchObject({ title: '工具 Bash', summary: 'npm test' });
  });

  it('starts a step for progress of a tool it never saw start', () => {
    emit({
      eventType: 'tool_progress',
      toolUseId: 'late',
      toolName: 'Grep',
      toolInputSummary: 'foo',
    });
    expect(live().steps![0]).toMatchObject({
      kind: 'tool',
      toolName: 'Grep',
      summary: 'foo',
    });
    expect(live().traceEvents.map((r) => r.title)).toEqual(['工具 Grep']);
  });

  it('marks a failed result and a denied call as errors', () => {
    tool('t1', 'Bash');
    emit({
      eventType: 'tool_result',
      toolUseId: 't1',
      toolResult: '⚠️ 失败了',
    });
    tool('t2', 'Write');
    emit({
      eventType: 'permission_denied',
      permissionDenied: {
        toolName: 'Write',
        toolUseId: 't2',
        reason: '被权限策略拒绝',
        message: 'denied',
      },
    });
    const [first, second] = live().steps!;
    expect(first).toMatchObject({ status: 'error', resultPreview: '失败了' });
    expect(second).toMatchObject({
      status: 'error',
      resultPreview: '被权限策略拒绝',
    });
  });

  it('merges a Task tool, its task events and its progress into one step', () => {
    tool('task-1', 'Task', '检查滚动');
    emit({
      eventType: 'task_start',
      toolUseId: 'task-1',
      taskId: 'task-1',
      taskDescription: '检查移动端滚动',
    });
    emit({
      eventType: 'task_progress',
      toolUseId: 'task-1',
      taskId: 'task-1',
      summary: '已读完 3 个文件',
    });
    // Its own tools belong to its card, not the timeline.
    emit({
      eventType: 'tool_use_start',
      toolName: 'Read',
      toolUseId: 'inner',
      parentToolUseId: 'task-1',
      isNested: true,
    });
    let steps = live().steps!;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: 'task',
      status: 'running',
      title: '检查移动端滚动',
      summary: '已读完 3 个文件',
    });
    emit({
      eventType: 'task_notification',
      taskId: 'task-1',
      toolUseId: 'task-1',
      taskStatus: 'completed',
      taskSummary: '检查完成',
    });
    steps = live().steps!;
    expect(steps[0]).toMatchObject({ status: 'done', summary: '检查完成' });
  });

  it('lists the tools run under a skill as the models own calls', () => {
    tool('skill-1', 'Skill');
    emit({
      eventType: 'tool_use_start',
      toolName: 'Edit',
      toolUseId: 'e1',
      parentToolUseId: 'skill-1',
      isNested: true,
    });
    expect(live().steps!.map((s) => s.toolUseId)).toEqual(['skill-1', 'e1']);
  });

  it('keeps the cap and counts what it dropped', () => {
    for (let i = 0; i < 130; i += 1) {
      tool(`t${i}`);
      emit({ eventType: 'tool_use_end', toolUseId: `t${i}` });
    }
    expect(live().steps).toHaveLength(100);
    expect(live().stepsDropped).toBe(30);
  });

  it('finishes the steps when the run settles', () => {
    delta('thinking_delta', '想。');
    tool('t1');
    delta('text_delta', '答案。');
    useChatStore.getState().handleRunFinished(JID, RUN);
    const settled = useChatStore.getState().settledStreaming[JID]!;
    expect(settled.steps!.every((s) => s.status !== 'running')).toBe(true);
    expect(settled.steps!.map((s) => s.kind)).toEqual([
      'thinking',
      'tool',
      'text',
    ]);
  });

  it('marks a tool that was running when the run was stopped', () => {
    delta('text_delta', '先说一句。');
    tool('t1', 'Bash');
    emit({ eventType: 'status', statusText: 'interrupted' });
    const frozen = useChatStore.getState().streaming[JID]!;
    expect(frozen.interrupted).toBe(true);
    const bash = frozen.steps!.find((s) => s.toolUseId === 't1')!;
    expect(bash).toMatchObject({ status: 'error', resultPreview: '已停止' });
  });
});

describe('what a finished reply keeps', () => {
  const finalMessage = (id: string): Message => ({
    id,
    chat_jid: JID,
    sender: 'happyclaw-agent',
    sender_name: 'HappyClaw',
    content: '最终答案。',
    timestamp: '2026-10-10T00:00:00.000Z',
    is_from_me: true,
    source_kind: 'sdk_final',
    finalization_reason: 'completed',
    turn_id: 'turn-1',
  });

  it('carries over thinking time even when the model gave no summary', () => {
    emit({ eventType: 'thinking_start', turnId: 'turn-1' });
    emit({
      eventType: 'thinking_end',
      thinkingDurationMs: 6400,
      turnId: 'turn-1',
    });
    delta('text_delta', '最终答案。');
    useChatStore.getState().handleRunFinished(JID, RUN);
    expect(useChatStore.getState().settledStreaming[JID]).toBeDefined();
    useChatStore.getState().handleWsNewMessage(JID, finalMessage('final-1'));
    const state = useChatStore.getState();
    expect(state.thinkingCache['final-1']).toBeUndefined();
    expect(state.thinkingDurationCache['final-1']).toBe(6400);
  });

  it('settles a reply that only reasoned silently', () => {
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 3000 });
    useChatStore.getState().handleRunFinished(JID, RUN);
    expect(useChatStore.getState().settledStreaming[JID]).toBeDefined();
  });

  it('does not settle a run with nothing to carry over', () => {
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    useChatStore.getState().handleRunFinished(JID, RUN);
    expect(useChatStore.getState().settledStreaming[JID]).toBeUndefined();
  });
});

describe('a proactive workspace', () => {
  beforeEach(() => {
    reset();
  });

  function start(): void {
    useChatStore.getState().handleRunStarted(JID, RUN);
  }

  it('never takes model text, at any level', () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      reset();
      setWorkspace('proactive', level);
      start();
      emit({ eventType: 'text_delta', text: '内部想法' });
      flushRaf();
      emit({
        eventType: 'text_delta',
        text: '子 Agent 的话',
        parentToolUseId: 'task-1',
      });
      expect(useChatStore.getState().streaming[JID]?.partialText ?? '').toBe(
        '',
      );
    }
  });

  it('shows only the spinner when the process is hidden', () => {
    setWorkspace('proactive', 'hidden');
    start();
    emit({ eventType: 'status', statusText: 'requesting' });
    tool('t1', 'Bash', 'ls');
    emit({ eventType: 'thinking_start' });
    const state = live();
    expect(state.activeTools).toEqual([]);
    expect(state.steps ?? []).toEqual([]);
    expect(state.systemStatus).toBe('requesting');
  });

  it('takes the activity, never the reasoning text, at the activity level', () => {
    setWorkspace('proactive', 'activity');
    start();
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_delta', text: '不该出现的思考' });
    flushRaf();
    emit({ eventType: 'thinking_end', thinkingDurationMs: 2000 });
    tool('t1', 'Bash', 'npm test');
    emit({
      eventType: 'tool_result',
      toolUseId: 't1',
      toolResult: '秘密输出',
      detail: '秘密输出',
    });
    const state = live();
    expect(state.thinkingText).toBe('');
    expect(state.thinkingDurationMs).toBe(2000);
    const kinds = state.steps!.map((s) => s.kind);
    expect(kinds).toEqual(['thinking', 'tool']);
    expect(state.steps![1].resultPreview).toBeUndefined();
    expect(JSON.stringify(state.traceEvents)).not.toContain('秘密输出');
  });

  it('takes the reasoning text at the full level', () => {
    setWorkspace('proactive', 'full');
    start();
    emit({ eventType: 'thinking_start' });
    delta('thinking_delta', '**检查文件**\n\n先看目录。');
    expect(live().thinkingText).toContain('先看目录');
    expect(live().thinkingTitle).toBe('检查文件');
  });

  it('treats a missing level as hidden', () => {
    setWorkspace('proactive', undefined);
    start();
    tool('t1');
    expect(useChatStore.getState().streaming[JID]?.steps ?? []).toEqual([]);
  });

  it('keeps the Assistant contract for a spawn agent in its workspace', () => {
    setWorkspace('proactive', 'hidden');
    useChatStore.setState({
      agents: {
        [JID]: [{ id: 'spawn-1', kind: 'spawn' } as never],
      },
    });
    useChatStore.getState().handleRunStarted(`${JID}#agent:spawn-1`, 'run-s');
    useChatStore
      .getState()
      .handleStreamEvent(
        JID,
        { eventType: 'text_delta', text: '并行任务的回复' },
        'spawn-1',
        'run-s',
      );
    flushRaf();
    expect(useChatStore.getState().agentStreaming['spawn-1']?.partialText).toBe(
      '并行任务的回复',
    );
  });

  it('does not settle a card: its messages are not replies', () => {
    setWorkspace('proactive', 'full');
    start();
    emit({ eventType: 'thinking_start' });
    delta('thinking_delta', '想了很多。');
    useChatStore.getState().handleRunFinished(JID, RUN);
    expect(useChatStore.getState().settledStreaming[JID]).toBeUndefined();
  });

  it('does not touch an Assistant workspace', () => {
    setWorkspace('assistant', 'hidden');
    start();
    delta('text_delta', '正常回复');
    tool('t1');
    expect(live().partialText).toBe('正常回复');
    expect(live().steps!.map((s) => s.kind)).toEqual(['text', 'tool']);
  });
});

describe('a reconnect snapshot', () => {
  const snapshot = (over: Partial<StreamSnapshotData> = {}) =>
    ({
      partialText: '正在回答',
      thinkingText: '**计划**\n\n先读。',
      thinkingDurationMs: 4000,
      activeTools: [
        {
          toolName: 'Bash',
          toolUseId: 't2',
          startTime: Date.now() - 2000,
          toolInputSummary: 'ls',
        },
      ],
      recentEvents: [],
      traceEvents: [
        {
          id: 'a',
          timestamp: 100,
          kind: 'tool',
          title: '工具 Read',
          summary: 'a.ts',
          toolUseId: 't1',
        },
        {
          id: 'b',
          timestamp: 300,
          kind: 'tool',
          title: '工具 Bash',
          summary: 'ls',
          toolUseId: 't2',
        },
      ],
      systemStatus: null,
      turnId: 'turn-9',
      ...over,
    }) as StreamSnapshotData;

  it('rebuilds a plausible order for a tab that has no steps', () => {
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot(), undefined, RUN);
    const state = live();
    expect(state.steps!.map((s) => `${s.kind}:${s.status}`)).toEqual([
      'thinking:done',
      'tool:done',
      'tool:running',
      'text:running',
    ]);
    expect(state.thinkingTitle).toBe('计划');
    expect(state.thinkingDurationMs).toBe(4000);
  });

  it('keeps the steps this tab already has for the same turn', () => {
    emit({
      eventType: 'tool_use_start',
      toolName: 'Read',
      toolUseId: 't1',
      turnId: 'turn-9',
    });
    delta('text_delta', '正在回答');
    const before = live().steps;
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot(), undefined, RUN);
    expect(live().steps).toBe(before);
  });
});
