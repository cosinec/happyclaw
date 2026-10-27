import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const inbound = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (ctx: any, next?: () => Promise<unknown>) => Promise<void>
  >(),
  storeMessageDirect: vi.fn(),
  notifyNewImMessage: vi.fn(),
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => ({ id: 1, username: 'happy_bot' })),
      getFile: vi.fn(async () => ({})),
      getChat: vi.fn(async () => ({ is_forum: false })),
      setMessageReaction: vi.fn(async () => {}),
    };
    on(
      filter: string,
      fn: (ctx: any, next?: () => Promise<unknown>) => Promise<void>,
    ) {
      inbound.handlers.set(filter, fn);
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        inbound.stop = resolve;
      });
    }
    stop() {
      inbound.stop?.();
      inbound.stop = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: inbound.notifyNewImMessage,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTelegramConnection,
  telegramCommandMentions,
} from '../src/telegram.js';
import {
  groupAudienceHost,
  type AudienceGroup,
} from './helpers/group-audience.js';

const GROUP_JID = 'telegram:-100777';
const OWNER = 42;
const MEMBER = 43;
const OUTSIDER = 44;
let seq = 1000;

function textCtx(input: {
  text: string;
  from: number;
  chat?: { id: number; type: string; title?: string };
  entities?: unknown[];
  reply_to_message?: unknown;
}) {
  seq += 1;
  return {
    message: {
      message_id: seq,
      date: Math.floor(Date.now() / 1000),
      text: input.text,
      entities: input.entities,
      reply_to_message: input.reply_to_message,
    },
    chat: input.chat ?? { id: -100777, type: 'supergroup', title: 'Team' },
    from: { id: input.from, first_name: `user${input.from}` },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

describe('Telegram group response audience', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeMessageDirect.mockReset();
    inbound.notifyNewImMessage.mockReset();
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  }, 8000);

  async function connect(group?: AudienceGroup) {
    if (group) groups[GROUP_JID] = group;
    connection = createTelegramConnection({ botToken: 'test-token' });
    const host = groupAudienceHost('telegram', groups);
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      onCommand,
      ...host,
    } as never);
    return host;
  }

  async function sendText(input: Parameters<typeof textCtx>[0]) {
    const ctx = textCtx(input);
    await inbound.handlers.get('message:text')!(ctx);
    return ctx;
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    await connect({ audience_mode: 'owner_only', owner_im_id: String(OWNER) });

    await sendText({ text: 'from owner', from: OWNER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();

    await sendText({ text: 'from member', from: MEMBER });
    await sendText({ text: '/status', from: MEMBER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    await connect({
      audience_mode: 'everyone',
      owner_im_id: String(OWNER),
      sender_allowlist: [String(OWNER), String(MEMBER)],
    });
    await sendText({ text: 'member', from: MEMBER });
    await sendText({ text: 'outsider', from: OUTSIDER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe('member');
  });

  test('everyone without an allowlist admits every member', async () => {
    await connect({ audience_mode: 'everyone' });
    await sendText({ text: 'a', from: MEMBER });
    await sendText({ text: 'b', from: OUTSIDER });
    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('private chats never consult the group gate', async () => {
    const host = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await sendText({
      text: 'dm',
      from: OUTSIDER,
      chat: { id: OUTSIDER, type: 'private' },
    });
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only group can only be claimed with /owner_mention', async () => {
    await connect({ audience_mode: 'owner_only' });
    await sendText({ text: 'hello', from: MEMBER });
    await sendText({ text: '/status', from: MEMBER });
    expect(onCommand).not.toHaveBeenCalled();

    await sendText({ text: '/owner_mention@happy_bot', from: MEMBER });
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      String(MEMBER),
      [],
    );
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('a transfer-quarantined group cannot be bootstrapped from IM', async () => {
    await connect({
      audience_mode: 'owner_only',
      owner_claim_source: 'transfer_reset',
    });
    await sendText({ text: '/owner_mention', from: MEMBER });
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('media from a rejected sender is dropped before any download', async () => {
    await connect({ audience_mode: 'owner_only', owner_im_id: String(OWNER) });
    seq += 1;
    await inbound.handlers.get('message:video')!({
      message: {
        message_id: seq,
        date: Math.floor(Date.now() / 1000),
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      },
      chat: { id: -100777, type: 'supergroup', title: 'Team' },
      from: { id: MEMBER, first_name: 'm' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    });
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
  });

  test('/allow hands the host the replied-to member and text mentions', async () => {
    await connect({ audience_mode: 'everyone', owner_im_id: String(OWNER) });
    await sendText({
      text: '/allow',
      from: OWNER,
      reply_to_message: { from: { id: MEMBER, is_bot: false } },
    });
    expect(onCommand).toHaveBeenLastCalledWith(
      GROUP_JID,
      'allow',
      String(OWNER),
      [{ imId: String(MEMBER) }],
    );
  });
});

describe('telegramCommandMentions', () => {
  test('text_mention entities and the replied-to author, never bots', () => {
    expect(
      telegramCommandMentions({
        entities: [
          { type: 'bot_command', offset: 0, length: 6 },
          { type: 'mention', offset: 7, length: 5 },
          {
            type: 'text_mention',
            offset: 13,
            length: 3,
            user: { id: 77 },
          },
          {
            type: 'text_mention',
            offset: 17,
            length: 3,
            user: { id: 1, is_bot: true },
          },
        ],
        reply_to_message: { from: { id: 78 } },
      }),
    ).toEqual([{ imId: '77' }, { imId: '78' }]);
    expect(
      telegramCommandMentions({
        reply_to_message: { from: { id: 1, is_bot: true } },
      }),
    ).toEqual([]);
  });
});
