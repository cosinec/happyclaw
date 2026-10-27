import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  class MockDWClient {
    static instances: MockDWClient[] = [];
    listener:
      | ((downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void)
      | null = null;
    registerCallbackListener = vi.fn(
      (
        _topic: string,
        listener: (downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void,
      ) => {
        this.listener = listener;
        return this;
      },
    );
    socketCallBackResponse = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    constructor(public options: Record<string, unknown>) {
      MockDWClient.instances.push(this);
    }
  }
  return { MockDWClient };
});

vi.mock('dingtalk-stream', () => ({
  DWClient: sdk.MockDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));
vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storeMessageDirect } from '../src/db.js';
import { notifyNewImMessage } from '../src/message-notifier.js';
import {
  createDingTalkConnection,
  dingTalkCommandMentions,
  type DingTalkConnectOpts,
} from '../src/dingtalk.js';
import {
  groupAudienceHost,
  type AudienceGroup,
} from './helpers/group-audience.js';

const GROUP_JID = 'dingtalk:group:conv-1';
const webhookBodies: string[] = [];
let seq = 0;

function downstream(input: {
  senderId: string;
  content: string;
  group?: boolean;
  isInAtList?: boolean;
  atUsers?: Array<{ dingtalkId?: string; staffId?: string }>;
}) {
  seq += 1;
  const group = input.group ?? true;
  const payload: Record<string, unknown> = {
    conversationId: group ? 'conv-1' : `c2c-${input.senderId}`,
    conversationType: group ? '2' : '1',
    msgId: `dt-${seq}`,
    senderId: input.senderId,
    senderNick: input.senderId,
    senderStaffId: `staff-${input.senderId}`,
    createAt: Date.now(),
    msgtype: 'text',
    text: { content: input.content },
    sessionWebhook: 'https://hook.example/session',
    chatbotUserId: 'bot-dingtalk-id',
    robotCode: 'ding-client',
    isInAtList: input.isInAtList ?? group,
    atUsers: input.atUsers,
  };
  return {
    headers: { messageId: `stream-${seq}` },
    data: JSON.stringify(payload),
  };
}

describe('DingTalk group response audience', () => {
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;
  let connection: ReturnType<typeof createDingTalkConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk.MockDWClient.instances.length = 0;
    webhookBodies.length = 0;
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    vi.spyOn(https, 'request').mockImplementation(((
      _opts: unknown,
      callback?: (res: EventEmitter) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & Record<string, any>;
      req.setTimeout = () => undefined;
      req.write = (chunk: unknown) => webhookBodies.push(String(chunk));
      req.destroy = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & Record<string, any>;
        res.statusCode = 200;
        res.headers = {};
        callback?.(res);
        res.emit(
          'data',
          Buffer.from(
            JSON.stringify({ errcode: 0, access_token: 't', expires_in: 7200 }),
          ),
        );
        res.emit('end');
      };
      return req as any;
    }) as any);
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    vi.restoreAllMocks();
  });

  async function connect(
    group?: AudienceGroup,
    overrides: Partial<DingTalkConnectOpts> = {},
  ) {
    if (group) groups[GROUP_JID] = group;
    const host = groupAudienceHost('dingtalk', groups);
    connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onMessagePersisted: vi.fn(),
      onCommand,
      ...host,
      ...overrides,
    });
    const client = sdk.MockDWClient.instances.at(-1)!;
    return {
      host,
      deliver: (d: ReturnType<typeof downstream>) => client.listener!(d),
    };
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    const { deliver } = await connect({
      audience_mode: 'owner_only',
      owner_im_id: 'OWNER',
    });
    await deliver(downstream({ senderId: 'OWNER', content: 'hi' }));
    await deliver(downstream({ senderId: 'MEMBER', content: 'hi' }));
    await deliver(downstream({ senderId: 'MEMBER', content: '/status' }));
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][2]).toBe(
      'dingtalk:OWNER',
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: 'OWNER',
      sender_allowlist: ['OWNER', 'MEMBER'],
    });
    await deliver(downstream({ senderId: 'MEMBER', content: 'listed' }));
    await deliver(downstream({ senderId: 'OUTSIDER', content: 'not listed' }));
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe('listed');
  });

  test('everyone without an allowlist admits every member', async () => {
    const { deliver } = await connect({ audience_mode: 'everyone' });
    await deliver(downstream({ senderId: 'A', content: 'a' }));
    await deliver(downstream({ senderId: 'B', content: 'b' }));
    expect(storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('private chats never consult the group gate', async () => {
    const { host, deliver } = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await deliver(
      downstream({ senderId: 'USER', content: 'dm', group: false }),
    );
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(notifyNewImMessage).toHaveBeenCalled();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only group can only be claimed with /owner_mention', async () => {
    const { deliver } = await connect({ audience_mode: 'owner_only' });
    await deliver(downstream({ senderId: 'MEMBER', content: '/status' }));
    expect(onCommand).not.toHaveBeenCalled();
    await deliver(
      downstream({ senderId: 'MEMBER', content: '/owner_mention' }),
    );
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      'MEMBER',
      [],
    );
  });

  test('/allow hands the host the @mentioned members', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: 'OWNER',
    });
    await deliver(
      downstream({
        senderId: 'OWNER',
        content: '/allow',
        atUsers: [{ dingtalkId: 'bot-dingtalk-id' }, { dingtalkId: 'MEMBER' }],
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(GROUP_JID, 'allow', 'OWNER', [
      { imId: 'MEMBER' },
    ]);
  });
});

describe('dingTalkCommandMentions', () => {
  test('dingtalkId of every @mentioned member except the bot', () => {
    expect(
      dingTalkCommandMentions({
        chatbotUserId: 'bot',
        atUsers: [
          { dingtalkId: 'bot' },
          { dingtalkId: 'A', staffId: 's' },
          { staffId: 'only-staff' },
          { dingtalkId: 'A' },
        ],
      }),
    ).toEqual([{ imId: 'A' }]);
    expect(dingTalkCommandMentions({})).toEqual([]);
  });
});
