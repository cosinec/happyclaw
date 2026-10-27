import { describe, expect, test, vi } from 'vitest';

import { channelConversationJid } from '../src/channel-address.js';
import { getChannelType } from '../src/im-channel.js';
import { stripVirtualJidSuffix } from '../src/utils.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

/**
 * Runs index.ts's real `handleCardInterrupt` and queue serialization key. A
 * card is keyed by its reply route — a reply posted inside a topic carries
 * `#thread:`/`#root:` — while the queue knows only the Session, so the stop
 * button must reach the Session's running query from either form.
 */
function harness(activeRunnerJid: string) {
  const abort = vi.fn(async () => undefined);
  const interruptQuery = vi.fn();
  const globals: Record<string, unknown> = {
    registeredGroups: {
      'web:main': { folder: 'main' },
      'feishu:oc_group': { folder: 'main' },
    },
    channelConversationJid,
    stripVirtualJidSuffix,
    getChannelType,
    isSenderAllowedInGroup: () => true,
    getStreamingSession: (jid: string) =>
      jid.startsWith('feishu:') ? { isActive: () => true, abort } : undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
  const runtime = createRuntimeSourceHarness(globals);
  runtime.install('queueSerializationKey');
  const key = globals.queueSerializationKey as (jid: string) => string;
  // Like GroupQueue: a JID reaches the active runner sharing its key.
  interruptQuery.mockImplementation(
    (jid: string) => key(jid) === key(activeRunnerJid),
  );
  globals.queue = { interruptQuery };
  runtime.install('handleCardInterrupt');
  const handle = globals.handleCardInterrupt as (
    cardJid: string,
    operator: string,
  ) => { ok: boolean; message: string };
  return { handle, abort };
}

describe('Feishu stop button', () => {
  test('stops a conversation Session answering inside a topic', () => {
    const { handle, abort } = harness('web:main#agent:a1');
    const result = handle(
      'feishu:oc_group#thread:omt_1#root:om_1#agent:a1',
      'ou_owner',
    );
    expect(result).toMatchObject({ ok: true });
    expect(abort).toHaveBeenCalledWith('已停止');
  });

  test('stops the main Session answering inside a topic', () => {
    const { handle } = harness('web:main');
    expect(
      handle('feishu:oc_group#thread:omt_1#root:om_1', 'ou_owner'),
    ).toMatchObject({ ok: true });
  });

  test('never stops a different Session of the same workspace', () => {
    const { handle, abort } = harness('web:main#agent:a2');
    expect(
      handle('feishu:oc_group#thread:omt_1#root:om_1#agent:a1', 'ou_owner'),
    ).toEqual({ ok: false, message: '当前回复已经结束，无需中断。' });
    expect(abort).not.toHaveBeenCalled();
  });
});
