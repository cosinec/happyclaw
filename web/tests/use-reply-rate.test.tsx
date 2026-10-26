// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReplyRate } from '../src/hooks/useReplyRate';
import { trackReplyText } from '../src/lib/reply-rate';
import { useChatStore, type StreamingState } from '../src/stores/chat';

vi.mock('../src/lib/reply-rate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/reply-rate')>();
  return { ...actual, trackReplyText: vi.fn(actual.trackReplyText) };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const JID = 'web:reply-rate-hook';
const OTHER = 'web:another-conversation';

const base: StreamingState = {
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
};

let root: Root;
let container: HTMLDivElement;
let shown: number | null = null;
let intervals: Set<number>;

function Probe() {
  shown = useReplyRate(JID);
  return null;
}

const update = (jid: string, over: Partial<StreamingState>) =>
  act(async () => {
    useChatStore.setState((s) => ({
      streaming: {
        ...s.streaming,
        [jid]: { ...base, ...s.streaming[jid], ...over },
      },
    }));
  });

const grow = (jid: string) =>
  update(jid, {
    partialText:
      (useChatStore.getState().streaming[jid]?.partialText ?? '') +
      '流式输出速度估算正文',
  });

beforeEach(() => {
  vi.useFakeTimers();
  // The hook's own ticks: those set and not yet cleared.
  intervals = new Set();
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((...args) => {
    const id = setInterval(...(args as Parameters<typeof setInterval>));
    intervals.add(id);
    return id;
  });
  vi.spyOn(window, 'clearInterval').mockImplementation((id) => {
    intervals.delete(id as number);
    clearInterval(id);
  });
  vi.mocked(trackReplyText).mockClear();
  useChatStore.setState({ streaming: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  shown = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useChatStore.setState({ streaming: {} });
});

const mount = () => act(async () => root.render(<Probe />));

describe('useReplyRate', () => {
  it("follows only its own run's stream", async () => {
    await update(JID, { partialText: '开头' });
    await mount();
    const seen = () => vi.mocked(trackReplyText).mock.calls.length;
    expect(seen()).toBe(1);
    // Another conversation streaming, the store changing elsewhere.
    for (let i = 0; i < 10; i += 1) {
      await grow(OTHER);
      await act(async () => {
        useChatStore.setState({ drafts: { [JID]: `草稿 ${i}` } });
      });
    }
    expect(seen()).toBe(1);
    await grow(JID);
    expect(seen()).toBe(2);
  });

  it('ticks only while it measures', async () => {
    await update(JID, { isThinking: true, thinkingText: '先想' });
    await mount();
    expect(intervals.size).toBe(0);
    // The reply's text streams: measured, and shown once a second.
    await update(JID, { isThinking: false, partialText: '开头' });
    expect(intervals.size).toBe(1);
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      await grow(JID);
    }
    expect(shown).toBe(100);
    // A tool runs: nothing to measure, nothing ticking.
    await update(JID, {
      activeTools: [{ toolName: 'Bash', toolUseId: 't1', startTime: 0 }],
    });
    expect(shown).toBeNull();
    expect(intervals.size).toBe(0);
    await update(JID, { activeTools: [] });
    expect(intervals.size).toBe(1);
    await act(async () => root.unmount());
    expect(intervals.size).toBe(0);
    root = createRoot(container);
  });
});
