// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingDisplay } from '../src/components/chat/StreamingDisplay';
import { useChatStore, type StreamingState } from '../src/stores/chat';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const JID = 'web:reply-rate';
const AGENT = 'session-1';

let root: Root;
let container: HTMLDivElement;

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
};

beforeEach(() => {
  vi.useFakeTimers();
  memory.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  useChatStore.setState({
    streaming: {},
    agentStreaming: {},
    stopRequests: {},
    activeRuns: {},
  });
});

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

/** The reply's state, read and replaced where the view looks for it. */
let target: { agentId?: string } = {};
const current = (): StreamingState => {
  const s = useChatStore.getState();
  return (
    (target.agentId ? s.agentStreaming[target.agentId] : s.streaming[JID]) ??
    base
  );
};
const update = (over: Partial<StreamingState>) => {
  const next = { ...current(), ...over };
  useChatStore.setState((s) =>
    target.agentId
      ? { agentStreaming: { ...s.agentStreaming, [target.agentId!]: next } }
      : { streaming: { ...s.streaming, [JID]: next } },
  );
};

const mount = async (agentId?: string) => {
  target = { agentId };
  const runtimeJid = agentId ? `${JID}#agent:${agentId}` : JID;
  useChatStore.setState({
    activeRuns: {
      [runtimeJid]: {
        chatJid: runtimeJid,
        runId: 'run-1',
        startedAt: new Date(Date.now() - 12_000).toISOString(),
        phase: 'running',
      },
    },
  });
  update({ partialText: '开头' });
  await act(async () => {
    root.render(
      <StreamingDisplay groupJid={JID} agentId={agentId} isWaiting stopHint />,
    );
  });
};

const CHUNK = '流式输出速度估算正文';

/** `chunk` more of `field` every 100 ms, for `ms`: ten characters are 100 tok/s. */
const write = async (
  ms: number,
  chunk = CHUNK,
  field: 'partialText' | 'thinkingText' = 'partialText',
) => {
  for (let t = 0; t < ms; t += 100) {
    await act(async () => {
      vi.advanceTimersByTime(100);
      update({ [field]: current()[field] + chunk });
    });
  }
};

const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

const rate = () =>
  [...container.querySelectorAll('span')].find((el) =>
    /^· .*tok\/s$/.test(el.textContent ?? ''),
  );

describe('the run status line, while the reply streams', () => {
  it('shows the estimated speed after the timer', async () => {
    await mount();
    expect(rate()).toBeUndefined();
    await write(3000);
    expect(rate()?.textContent).toBe('· 约 100 tok/s');
    const line = rate()!.parentElement!.textContent ?? '';
    expect(line).toMatch(/^正在回复.*15s· 约 100 tok\/s· Esc 停止$/);
  });

  it('keeps it from screen readers and from narrow screens', async () => {
    await mount();
    await write(3000);
    const el = rate()!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.closest('[aria-live]')).toBeNull();
    expect(el.className).toContain('max-sm:hidden');
    for (const live of container.querySelectorAll('[aria-live]')) {
      expect(live.textContent).not.toContain('tok/s');
    }
  });

  it('changes what it shows at most once a second', async () => {
    await mount();
    await write(3000);
    const el = rate()!;
    const shown = [el.textContent];
    // Twice as fast for three seconds, looked at every 100 ms.
    for (let i = 0; i < 30; i += 1) {
      await write(100, CHUNK.repeat(2));
      if (shown.at(-1) !== rate()?.textContent) shown.push(rate()?.textContent);
    }
    expect(shown.length).toBeLessThanOrEqual(4);
    expect(shown.at(-1)).toBe('· 约 200 tok/s');
  });

  it('hides it while a tool runs, and measures afresh after', async () => {
    await mount();
    await write(3000);
    expect(rate()).toBeDefined();
    await act(async () => {
      update({
        activeTools: [
          { toolName: 'Bash', toolUseId: 't1', startTime: Date.now() },
        ],
      });
    });
    expect(rate()).toBeUndefined();
    await wait(5000);
    expect(rate()).toBeUndefined();
    // The tool returned: the model is at work before any text comes back.
    await act(async () => {
      update({ activeTools: [], awaitingModel: true });
    });
    await wait(2000);
    expect(rate()).toBeUndefined();
    await act(async () => {
      update({ awaitingModel: false });
    });
    await write(1000);
    expect(rate()?.textContent).toBe('· 约 100 tok/s');
  });

  it('hides it while the model reasons', async () => {
    await mount();
    await write(3000);
    expect(rate()).toBeDefined();
    await act(async () => {
      update({ isThinking: true, thinkingText: '先想一想' });
    });
    expect(rate()).toBeUndefined();
    for (let t = 0; t < 2000; t += 100) {
      await write(100, '再想一想更多细节', 'thinkingText');
      expect(rate()).toBeUndefined();
    }
  });

  it('hides it once the text has stopped growing for about two seconds', async () => {
    await mount();
    await write(3000);
    expect(rate()).toBeDefined();
    await wait(1000);
    expect(rate()).toBeDefined();
    await wait(2000);
    expect(rate()).toBeUndefined();
  });

  it('hides it once a stop is requested', async () => {
    await mount();
    await write(3000);
    await act(async () => {
      useChatStore.setState({ stopRequests: { [JID]: Date.now() } });
    });
    expect(rate()).toBeUndefined();
  });

  it('shows it in the compact display mode', async () => {
    memory.set('happyclaw-display-mode:guest', 'compact');
    await mount();
    await write(3000);
    expect(rate()?.textContent).toBe('· 约 100 tok/s');
  });

  it("reads a session's own reply", async () => {
    await mount(AGENT);
    // The main conversation's reply does not count.
    useChatStore.setState({
      streaming: { [JID]: { ...base, partialText: '主会话' } },
    });
    await write(3000);
    expect(rate()?.textContent).toBe('· 约 100 tok/s');
  });
});
