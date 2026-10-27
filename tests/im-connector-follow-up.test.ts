import { describe, expect, test, vi } from 'vitest';

import { setChannelImplementationLoaderForTest } from '../src/channel-registry.js';
import {
  createDingTalkChannel,
  createDiscordChannel,
  createTelegramChannel,
  createWeChatChannel,
  createWeComChannel,
  createWhatsAppChannel,
} from '../src/im-channel.js';
import {
  offerChannelFollowUp,
  parseConnectorRuntimeControl,
  runSessionBreak,
} from '../src/im-connector-follow-up.js';
import { IMConnectionManager } from '../src/im-manager.js';

describe('connector runtime controls', () => {
  const parse = (
    commandText: string,
    eligible = true,
    hasAttachments = false,
  ) => parseConnectorRuntimeControl({ commandText, eligible, hasAttachments });

  test('/steer needs a message and may carry attachments', () => {
    expect(parse('/steer  go on ')).toEqual({ kind: 'steer', text: 'go on' });
    expect(parse('/steer look at this', true, true)).toEqual({
      kind: 'steer',
      text: 'look at this',
    });
    expect(parse('/steer')).toBeUndefined();
    expect(parse('/Steer go')).toBeUndefined();
  });

  test('/break is exact, attachment-free and case-sensitive', () => {
    expect(parse(' /break ')).toEqual({ kind: 'break' });
    expect(parse('/break', true, true)).toBeUndefined();
    expect(parse('/break now')).toBeUndefined();
    expect(parse('/BREAK')).toBeUndefined();
  });

  test('nothing is a control without structural addressing', () => {
    expect(parse('/break', false)).toBeUndefined();
    expect(parse('/steer go', false)).toBeUndefined();
  });

  test('/clear and /fresh stay with the generic command handler', () => {
    expect(parse('/clear')).toBeUndefined();
    expect(parse('/fresh notes')).toBeUndefined();
  });

  test('a runtime without the host callbacks keeps legacy behavior', async () => {
    expect(
      offerChannelFollowUp(undefined, {
        targetJid: 't',
        sourceJid: 's',
        messageId: 'm',
        senderImId: 'u',
      }),
    ).toMatchObject({ shouldStartTurn: true, deliveryFields: {} });
    await expect(
      runSessionBreak(undefined, { sourceJid: 's', senderImId: 'u' }),
    ).resolves.toBe('当前运行环境不支持 /break。');
  });
});

describe('the follow-up callbacks are forwarded down to every connector', () => {
  const onFollowUpMessage = vi.fn(() => ({ disposition: 'started' as const }));
  const onFollowUpsChanged = vi.fn();
  const onSessionBreak = vi.fn(async () => 'ok');
  const callbacks = { onFollowUpMessage, onFollowUpsChanged, onSessionBreak };

  test.each([
    [
      'telegram',
      (m: IMConnectionManager) =>
        m.connectUserTelegram(
          'u',
          { botToken: 't' },
          vi.fn(),
          undefined,
          undefined,
          callbacks,
        ),
    ],
    [
      'wechat',
      (m: IMConnectionManager) =>
        m.connectUserWeChat(
          'u',
          { botToken: 't', ilinkBotId: 'i' },
          vi.fn(),
          callbacks,
        ),
    ],
    [
      'wecom',
      (m: IMConnectionManager) =>
        m.connectUserWeCom(
          'u',
          { botId: 'b', secret: 's' },
          vi.fn(),
          callbacks,
        ),
    ],
    [
      'dingtalk',
      (m: IMConnectionManager) =>
        m.connectUserDingTalk(
          'u',
          { clientId: 'c', clientSecret: 's' },
          vi.fn(),
          callbacks,
        ),
    ],
    [
      'discord',
      (m: IMConnectionManager) =>
        m.connectUserDiscord('u', { botToken: 't' }, vi.fn(), callbacks),
    ],
    [
      'whatsapp',
      (m: IMConnectionManager) =>
        m.connectUserWhatsApp(
          'u',
          { accountId: 'a', authDir: '/tmp/x' },
          vi.fn(),
          callbacks,
        ),
    ],
  ] as const)('im-manager: %s', async (_provider, connectUser) => {
    const manager = new IMConnectionManager();
    const connect = vi.spyOn(manager, 'connectChannel').mockResolvedValue(true);
    await connectUser(manager);
    const opts = connect.mock.calls[0]![3];
    expect(opts.onFollowUpMessage).toBe(onFollowUpMessage);
    expect(opts.onFollowUpsChanged).toBe(onFollowUpsChanged);
    expect(opts.onSessionBreak).toBe(onSessionBreak);
  });

  test.each([
    [
      'telegram',
      'createTelegramConnection',
      () => createTelegramChannel({ botToken: 't' }),
    ],
    [
      'wechat',
      'createWeChatConnection',
      () => createWeChatChannel({ botToken: 't', ilinkBotId: 'i' }),
    ],
    [
      'wecom',
      'createWeComConnection',
      () => createWeComChannel({ botId: 'b', secret: 's' }),
    ],
    [
      'dingtalk',
      'createDingTalkConnection',
      () => createDingTalkChannel({ clientId: 'c', clientSecret: 's' }),
    ],
    [
      'discord',
      'createDiscordConnection',
      () => createDiscordChannel({ botToken: 't' }),
    ],
    [
      'whatsapp',
      'createWhatsAppConnection',
      () => createWhatsAppChannel({ accountId: 'a', authDir: '/tmp/x' }),
    ],
  ] as const)('adapter: %s', async (provider, factory, create) => {
    const captured: { opts?: Record<string, unknown> } = {};
    const restore = setChannelImplementationLoaderForTest(
      provider,
      async () =>
        ({
          [factory]: () => ({
            connect: async (opts: Record<string, unknown>) => {
              captured.opts = opts;
              return true;
            },
            disconnect: async () => undefined,
            isConnected: () => true,
            isRunning: () => true,
          }),
        }) as never,
    );
    try {
      await create().connect({
        onReady: vi.fn(),
        onNewChat: vi.fn(),
        ...callbacks,
      });
      expect(captured.opts?.onFollowUpMessage).toBe(onFollowUpMessage);
      expect(captured.opts?.onFollowUpsChanged).toBe(onFollowUpsChanged);
      expect(captured.opts?.onSessionBreak).toBe(onSessionBreak);
    } finally {
      restore();
    }
  });
});
