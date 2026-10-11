import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupInfo, Message } from '../web/src/stores/chat';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
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

const { useChatStore, mergeMessagesChronologically } =
  await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

const JID = 'web:trace';
const message = (id = 'm1', over: Partial<Message> = {}): Message => ({
  id,
  chat_jid: JID,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '最终答案。',
  timestamp: '2026-10-10T00:00:00.000Z',
  is_from_me: true,
  source_kind: 'sdk_final',
  turn_id: 'turn-1',
  has_trace: true,
  ...over,
});

const row = (
  id: string,
  title: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  timestamp: 1,
  kind: 'tool',
  title,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      messages: { [JID]: [] },
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      turnTraceStatus: {},
    },
    true,
  );
});

describe('loading the reasoning and trace the server kept', () => {
  it('asks for the turn of the message and fills the caches it renders from', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '**确认范围**\n\n先看目录。',
      thinking_duration_ms: 6400,
      trace: [row('a', '工具 Read', { summary: 'a.ts', toolUseId: 't1' })],
      created_at: '2026-10-10T00:00:00.000Z',
    });
    const loaded = await useChatStore.getState().loadTurnTrace(message());
    expect(loaded).toBe(true);
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(JID)}/turn-traces/turn-1`,
    );
    const state = useChatStore.getState();
    expect(state.thinkingCache.m1).toBe('**确认范围**\n\n先看目录。');
    expect(state.thinkingDurationCache.m1).toBe(6400);
    expect(state.traceCache.m1).toHaveLength(1);
    expect(state.turnTraceStatus.m1).toBeUndefined();
  });

  it('asks a session by its whole jid', async () => {
    apiGetMock.mockResolvedValueOnce({ turn_id: 't', thinking: '想' });
    await useChatStore
      .getState()
      .loadTurnTrace(message('m2', { chat_jid: `${JID}#agent:s1` }));
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(`${JID}#agent:s1`)}/turn-traces/turn-1`,
    );
  });

  it('keeps duration alone when the model gave no text', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      thinking_duration_ms: 3000,
      trace: [],
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.thinkingCache.m1).toBeUndefined();
    expect(state.thinkingDurationCache.m1).toBe(3000);
  });

  it('keeps the trace alone at the activity level (no reasoning text)', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      thinking_duration_ms: null,
      trace: [row('a', '工具 Bash')],
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.thinkingCache.m1).toBeUndefined();
    expect(state.thinkingDurationCache.m1).toBeUndefined();
    expect(state.traceCache.m1).toHaveLength(1);
  });

  it('marks a turn with nothing kept as empty, and does not ask again', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
    });
    await useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('empty');
  });

  it('treats a turn the server no longer shows as empty', async () => {
    apiGetMock.mockRejectedValueOnce({ status: 404, message: 'Not found' });
    const loaded = await useChatStore.getState().loadTurnTrace(message());
    expect(loaded).toBe(false);
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('empty');
  });

  it('fails quietly and lets the next ask try again', async () => {
    apiGetMock.mockRejectedValueOnce({ status: 0, message: 'Network error' });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(false);
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('failed');
    expect(useChatStore.getState().error).toBeNull();

    apiGetMock.mockResolvedValueOnce({ turn_id: 'turn-1', thinking: '想了。' });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    expect(useChatStore.getState().thinkingCache.m1).toBe('想了。');
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
  });

  it('asks once while a load is in flight', async () => {
    let resolve!: (value: unknown) => void;
    apiGetMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(false);
    resolve({ turn_id: 'turn-1', thinking: '想' });
    await first;
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it('does not ask for what this tab already has', async () => {
    useChatStore.setState({ thinkingCache: { m1: '已有的思考' } });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('cannot ask for a message with no turn', async () => {
    expect(
      await useChatStore
        .getState()
        .loadTurnTrace(message('m3', { turn_id: null })),
    ).toBe(false);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('shows a proactive reply of a visible workspace the same way', async () => {
    useChatStore.setState({
      groups: {
        [JID]: {
          name: 'w',
          folder: 'trace',
          added_at: '2026-01-01T00:00:00.000Z',
          interaction_mode: 'proactive',
          process_visibility: 'activity',
        } as GroupInfo,
      },
    });
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [row('a', '工具 Grep')],
    });
    await useChatStore
      .getState()
      .loadTurnTrace(message('m4', { source_kind: 'sdk_send_message' }));
    expect(useChatStore.getState().traceCache.m4).toHaveLength(1);
  });
});

describe('has_trace on a message', () => {
  it('is kept from a message the WebSocket delivers', () => {
    useChatStore.getState().handleWsNewMessage(JID, {
      id: 'ws-1',
      chat_jid: JID,
      sender: 'happyclaw-agent',
      sender_name: 'HappyClaw',
      content: '终稿',
      timestamp: '2026-10-10T00:00:00.000Z',
      is_from_me: true,
      source_kind: 'sdk_final',
      turn_id: 'turn-ws',
      has_trace: true,
    });
    const [stored] = useChatStore.getState().messages[JID];
    expect(stored).toMatchObject({ id: 'ws-1', turn_id: 'turn-ws' });
    expect(stored.has_trace).toBe(true);
  });

  it('is left out when the server did not say so', () => {
    useChatStore.getState().handleWsNewMessage(JID, {
      id: 'ws-2',
      chat_jid: JID,
      sender: 'happyclaw-agent',
      sender_name: 'HappyClaw',
      content: '没有轨迹的回复',
      timestamp: '2026-10-10T00:00:00.000Z',
      is_from_me: true,
      source_kind: 'sdk_final',
      turn_id: 'turn-ws-2',
    });
    expect(useChatStore.getState().messages[JID][0].has_trace).toBeUndefined();
  });

  it('reaches the stored message when the server adds it later', () => {
    const before = [message('m1', { has_trace: undefined })];
    const after = mergeMessagesChronologically(before, [message('m1')]);
    expect(after[0].has_trace).toBe(true);
  });
});
