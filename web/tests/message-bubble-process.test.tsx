// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupInfo, Message } from '../src/stores/chat';
import type { StreamingStep } from '../src/lib/stream-steps';

vi.mock('../src/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { MessageBubble } = await import('../src/components/chat/MessageBubble');
const { useChatStore } = await import('../src/stores/chat');
const initialState = useChatStore.getState();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LAYOUT_KEY = 'happyclaw-stream-layout:guest';
const memory = new Map<string, string>();

const JID = 'web:bubble-process';

const reply = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  chat_jid: JID,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '最终答案在这里。',
  timestamp: '2026-10-10T00:00:00.000Z',
  is_from_me: true,
  source_kind: 'sdk_final',
  turn_id: 'turn-1',
  has_trace: true,
  ...over,
});

const group = (over: Partial<GroupInfo> = {}) =>
  ({
    name: 'w',
    folder: 'bubble-process',
    added_at: '2026-01-01T00:00:00.000Z',
    interaction_mode: 'assistant',
    ...over,
  }) as GroupInfo;

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({
  at: 1_000_000,
  endedAt: 1_004_000,
  status: 'done',
  ...over,
});

/** Two reasoning bursts around two tool calls, with commentary between. */
const STEPS: StreamingStep[] = [
  step({
    id: 'thinking-0',
    kind: 'thinking',
    durationMs: 3000,
    title: '确认范围',
    text: '**确认范围**\n\n先看项目结构。',
  }),
  step({
    id: 'tool-a',
    kind: 'tool',
    at: 1_004_000,
    endedAt: 1_006_000,
    toolName: 'Bash',
    toolUseId: 'a',
    summary: 'command: npm test',
  }),
  step({
    id: 'text-0',
    kind: 'text',
    at: 1_006_000,
    endedAt: 1_007_000,
    text: '测试通过，再看一眼构建。',
  }),
  step({
    id: 'tool-b',
    kind: 'tool',
    at: 1_007_000,
    endedAt: 1_009_000,
    toolName: 'Bash',
    toolUseId: 'b',
    summary: 'command: npm run build',
  }),
  step({
    id: 'thinking-1',
    kind: 'thinking',
    at: 1_009_000,
    endedAt: 1_011_000,
    durationMs: 2000,
    title: '整理结论',
    text: '**整理结论**\n\n可以回答了。',
  }),
  step({
    id: 'answer',
    kind: 'text',
    at: 1_011_000,
    endedAt: 1_012_000,
    text: '最终答案在这里。',
  }),
];

const TRACE = [
  {
    id: 'r1',
    timestamp: 1,
    kind: 'tool' as const,
    title: '工具 Bash',
    summary: 'npm test',
    toolUseId: 'a',
  },
];

/** The way MessageList feeds a bubble: from the caches of the store. */
function Row({ message }: { message: Message }) {
  const thinking = useChatStore((s) => s.thinkingCache[message.id]);
  const duration = useChatStore((s) => s.thinkingDurationCache[message.id]);
  const trace = useChatStore((s) => s.traceCache[message.id]);
  const steps = useChatStore((s) => s.stepsCache[message.id]);
  return (
    <MessageBubble
      message={message}
      showTime={false}
      thinkingContent={thinking}
      thinkingDurationMs={duration}
      traceEvents={trace}
      replySteps={steps}
    />
  );
}

let root: Root;
let container: HTMLDivElement;

function seed(
  caches: {
    steps?: StreamingStep[];
    dropped?: number;
    thinking?: string;
    duration?: number;
    trace?: typeof TRACE;
  } = {},
) {
  useChatStore.setState({
    ...(caches.steps
      ? {
          stepsCache: {
            m1: { steps: caches.steps, dropped: caches.dropped ?? 0 },
          },
        }
      : {}),
    ...(caches.thinking ? { thinkingCache: { m1: caches.thinking } } : {}),
    ...(caches.duration
      ? { thinkingDurationCache: { m1: caches.duration } }
      : {}),
    ...(caches.trace ? { traceCache: { m1: caches.trace } } : {}),
  });
}

const mount = (message: Message = reply()) =>
  act(async () => {
    root.render(<Row message={message} />);
  });
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });

const card = () =>
  container.querySelector<HTMLElement>('[data-hc-process-card]');
const summaryRow = () => card()?.querySelector('button') ?? null;
const text = () => container.textContent ?? '';
const timeline = () =>
  container.querySelector('[role="list"][aria-label="处理步骤"]');

beforeEach(() => {
  memory.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
    },
  });
  useChatStore.setState(
    {
      ...initialState,
      groups: { [JID]: group() },
      messages: { [JID]: [] },
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stepsCache: {},
      turnTraceStatus: {},
    },
    true,
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('a finished reply that has its steps', () => {
  it('sums them up in one settled row instead of the reasoning and the trace', async () => {
    seed({
      steps: STEPS,
      thinking: '**确认范围**\n\n先看项目结构。',
      duration: 5000,
      trace: TRACE,
    });
    await mount();

    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(summaryRow()?.textContent).toBe(
      '已处理 11 秒 · 2 个工具 · 2 段思考',
    );
    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: the steps are not listed, and the two old rows are not there.
    expect(timeline()).toBeNull();
    expect(text()).not.toContain('执行详情');
    expect(text()).not.toMatch(/已思考 \d/);
    expect(text()).toContain('最终答案在这里。');
  });

  it('opens to the steps in the order they happened', async () => {
    seed({ steps: STEPS });
    await mount();
    await click(summaryRow());

    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('true');
    const rows = [...(timeline()?.querySelectorAll('[role="listitem"]') ?? [])];
    const order = [
      '确认范围',
      'npm test',
      '测试通过，再看一眼构建。',
      'npm run build',
      '整理结论',
    ].map((needle) =>
      rows.findIndex((row) => row.textContent?.includes(needle)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The answer is the message, not a row of the card.
    expect(timeline()?.textContent).not.toContain('最终答案在这里。');
  });

  it('keeps the card above the answer, where the streaming card left it', async () => {
    seed({ steps: STEPS });
    await mount();
    const answer = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('最终答案在这里。'),
    );
    expect(answer).toBeTruthy();
    expect(
      card()!.compareDocumentPosition(answer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps a denied permission above the card and a Workflow below it', async () => {
    seed({
      steps: STEPS,
      trace: [
        ...TRACE,
        {
          id: 'p1',
          timestamp: 2,
          kind: 'permission' as never,
          title: '权限被拒：Write',
          summary: 'a.ts',
        },
      ],
    });
    await mount(
      reply({
        workflow_runs: [
          {
            taskId: 'wf-1',
            workflowName: '审查流程',
            summary: '审查完成',
            status: 'completed',
            phases: [],
            agents: [],
          },
        ],
      }),
    );

    const alert = [...container.querySelectorAll('div')].find((el) =>
      el.textContent?.startsWith('权限被拒绝 (1)'),
    );
    const workflow = container.querySelector(
      'section[aria-label^="动态工作流"]',
    );
    expect(alert).toBeTruthy();
    expect(workflow).toBeTruthy();
    const after = (a: Node, b: Node) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(alert!, card()!)).toBe(true);
    expect(after(card()!, workflow!)).toBe(true);
    // The trace panel the card replaces is not there.
    expect(text()).not.toContain('执行详情');
  });

  it('takes the total time from the reply when the steps carry none', async () => {
    seed({
      steps: [
        step({
          id: 'thinking-0',
          kind: 'thinking',
          at: 0,
          endedAt: undefined,
          status: 'done',
        }),
        step({
          id: 'tool-a',
          kind: 'tool',
          at: 0,
          endedAt: undefined,
          toolName: 'Bash',
          toolUseId: 'a',
          summary: 'command: ls',
        }),
      ],
      duration: 9000,
    });
    await mount();
    expect(summaryRow()?.textContent).toContain('9 秒');
  });

  it('says how many steps were dropped from the front when it is opened', async () => {
    seed({ steps: STEPS, dropped: 12 });
    await mount();
    await click(summaryRow());
    expect(text()).toContain('较早 12 步');
  });

  it('lists the commentary and the reasoning text of an assistant workspace', async () => {
    seed({ steps: STEPS });
    await mount();
    await click(summaryRow());
    expect(text()).toContain('测试通过，再看一眼构建。');
    expect(text()).toContain('确认范围');
  });
});

describe('a finished reply the card does not take', () => {
  const OLD = {
    thinking: '**确认范围**\n\n先看项目结构。',
    duration: 5000,
    trace: TRACE,
  };
  const twoRows = () => {
    expect(text()).toMatch(/已思考 \d/);
    expect(text()).toContain('执行详情');
    expect(card()).toBeNull();
  };

  it('keeps the two rows in the classic layout', async () => {
    memory.set(LAYOUT_KEY, 'classic');
    seed({ steps: STEPS, ...OLD });
    await mount();
    twoRows();
  });

  it('keeps the two rows of a reply with no steps (an older turn)', async () => {
    seed(OLD);
    await mount();
    twoRows();
  });

  it('keeps the two rows when the steps hold nothing to list', async () => {
    seed({
      steps: [step({ id: 'answer', kind: 'text', text: '最终答案在这里。' })],
      ...OLD,
    });
    await mount();
    twoRows();
  });

  it('keeps a reply of the classic layout open when asked, as it was', async () => {
    memory.set(LAYOUT_KEY, 'classic');
    seed({ steps: STEPS, ...OLD });
    await mount();
    const thinkingRow = [...container.querySelectorAll('button')].find((b) =>
      /已思考/.test(b.textContent ?? ''),
    );
    expect(thinkingRow?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('what a proactive workspace lets its owner see', () => {
  const secretSteps = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      durationMs: 3000,
      title: '内部推理标题',
      text: '**内部推理标题**\n\n不该出现的推理。',
    }),
    step({
      id: 'text-0',
      kind: 'text',
      at: 1_004_000,
      endedAt: 1_005_000,
      text: '不该出现的过程说明。',
      commentary: true,
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_005_000,
      endedAt: 1_006_000,
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm test',
    }),
  ];
  const proactive = (level: 'activity' | 'full') =>
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: level,
        }),
      },
    });

  it('shows the reasoning text and the commentary at the full level', async () => {
    proactive('full');
    seed({ steps: secretSteps });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    await click(summaryRow());
    expect(text()).toContain('内部推理标题');
    expect(text()).toContain('不该出现的过程说明。');
  });

  it('shows neither at the activity level, only that the model reasoned', async () => {
    proactive('activity');
    seed({ steps: secretSteps });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    await click(summaryRow());
    expect(summaryRow()?.textContent).toContain('1 个工具');
    expect(text()).not.toContain('内部推理标题');
    expect(text()).not.toContain('不该出现的推理');
    expect(text()).not.toContain('不该出现的过程说明');
    expect(text()).toContain('npm test');
  });

  it('keeps the two rows when the level leaves no step to list', async () => {
    proactive('activity');
    seed({
      steps: [secretSteps[1]],
      thinking: '推理',
      duration: 4000,
    });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    expect(card()).toBeNull();
    expect(text()).toMatch(/已思考 \d/);
  });
});

describe('a reply that is replaced', () => {
  it('follows the steps that arrive for it', async () => {
    await mount(reply({ has_trace: undefined }));
    expect(card()).toBeNull();
    act(() => seed({ steps: STEPS }));
    await act(async () => {});
    expect(card()?.getAttribute('data-mode')).toBe('settled');
  });
});
