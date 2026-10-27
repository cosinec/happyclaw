import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-recheck-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { getChannelType } = await import('../src/im-channel.js');
const { channelConversationJid } = await import('../src/channel-address.js');
const { stripVirtualJidSuffix } = await import('../src/utils.js');
const { ownerImIdFromPersistedSender } =
  await import('../src/agent-builder-turn-auth.js');
const { isDirectMessageJid } = await import('../src/im-command-utils.js');
const { resolveChannelConversationKind } =
  await import('../src/channel-conversation-kind.js');
const { isSenderAdmittedByGroupPolicy } =
  await import('../src/im-group-audience.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Runs index.ts's queue-drain re-admission against a real database: inputs
 * that waited while a run was active are checked against the audience as it
 * is when they would run, not as it was when they arrived.
 */
function recheckHarness(policy: Record<string, object>) {
  const broadcastFollowUpUpdate = vi.fn();
  const globals: Record<string, unknown> = {
    listQueuedFollowUps: db.listQueuedFollowUps,
    cancelQueuedFollowUp: db.cancelQueuedFollowUp,
    getChannelType,
    channelConversationJid,
    stripVirtualJidSuffix,
    ownerImIdFromPersistedSender,
    isDirectMessageJid,
    resolveChannelConversationKind,
    registeredGroups: {},
    getRegisteredGroup: (jid: string) => policy[jid],
    isSenderAllowedInGroup: (jid: string, sender?: string) => {
      const group = policy[channelConversationJid(jid)];
      return group
        ? isSenderAdmittedByGroupPolicy(group, sender, getChannelType(jid))
        : false;
    },
    closeRetryWaitTurnsForWithdrawnInputs: vi.fn(),
    channelTurnScopeForInput: vi.fn(() => null),
    broadcastFollowUpUpdate,
    clearStandaloneProcessingIndicator: vi.fn(async () => undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'isDirectImConversation',
    'cancelFollowUp',
    'withdrawQueuedInputsOutsideAudience',
  ]) {
    harness.install(name);
  }
  return {
    withdraw: globals.withdrawQueuedInputsOutsideAudience as (
      chatJid: string,
    ) => void,
    broadcastFollowUpUpdate,
  };
}

let clock = Date.parse('2026-10-27T09:00:00.000Z');
function queued(
  chatJid: string,
  id: string,
  sourceJid: string,
  sender: string,
) {
  clock += 1000;
  db.storeMessageDirect(
    id,
    chatJid,
    sender,
    'Member',
    id,
    new Date(clock).toISOString(),
    false,
    {
      sourceJid,
      meta: {
        deliveryMode: 'queue',
        deliveryStatus: 'queued',
        deliveryRunId: 'run-1',
      },
    },
  );
}

describe('queued inputs are re-admitted when the queue drains', () => {
  test('a sender disallowed or outside a new owner_only audience is withdrawn', () => {
    const chatJid = 'web:recheck-groups';
    db.ensureChatExists(chatJid);
    const policy: Record<string, object> = {
      'telegram:-1001': { audience_mode: 'owner_only', owner_im_id: '42' },
      'qq:group:G1': {
        audience_mode: 'everyone',
        sender_allowlist: ['group:OWNER'],
      },
    };
    queued(chatJid, 'tg-owner', 'telegram:-1001', 'tg:42');
    queued(chatJid, 'tg-member', 'telegram:-1001', 'tg:43');
    queued(chatJid, 'qq-owner', 'qq:group:G1', 'qq:OWNER');
    queued(chatJid, 'qq-gone', 'qq:group:G1', 'qq:FORMER');
    queued(chatJid, 'web-input', 'web:recheck-groups', 'user-1');

    const h = recheckHarness(policy);
    h.withdraw(chatJid);

    expect(db.listQueuedFollowUps(chatJid).map((item) => item.id)).toEqual([
      'tg-owner',
      'qq-owner',
      'web-input',
    ]);
    expect(h.broadcastFollowUpUpdate).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({
        id: 'tg-member',
        delivery_status: 'cancelled',
      }),
    );
    expect(h.broadcastFollowUpUpdate).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({ id: 'qq-gone', delivery_status: 'cancelled' }),
    );
  });

  test('private chats are never audience-gated', () => {
    const chatJid = 'web:recheck-private';
    db.ensureChatExists(chatJid);
    queued(chatJid, 'dm', 'telegram:4242', 'tg:4242');
    const h = recheckHarness({
      'telegram:4242': { audience_mode: 'owner_only', owner_im_id: '1' },
    });
    h.withdraw(chatJid);
    expect(db.listQueuedFollowUps(chatJid).map((item) => item.id)).toEqual([
      'dm',
    ]);
  });

  test('the drain and the startup recovery both re-admit before claiming', () => {
    const source = fs.readFileSync(
      new URL('../src/index.ts', import.meta.url),
      'utf8',
    );
    const dispatch = source.slice(
      source.indexOf('async function dispatchNextQueuedFollowUp'),
      source.indexOf('function dispatchQueuedFollowUpFamily'),
    );
    expect(
      dispatch.indexOf('withdrawQueuedInputsOutsideAudience(chatJid)'),
    ).toBeLessThan(dispatch.indexOf('claimNextQueuedFollowUpBatch('));
    expect(dispatch).toContain('withdrawQueuedInputsOutsideAudience(chatJid)');
    const recovery = source.slice(
      source.indexOf('function recoverDurableFollowUps'),
      source.indexOf('function recoverDurableFollowUps') + 600,
    );
    expect(
      recovery.indexOf('withdrawQueuedInputsOutsideAudience(chatJid)'),
    ).toBeGreaterThan(-1);
    expect(
      recovery.indexOf('withdrawQueuedInputsOutsideAudience(chatJid)'),
    ).toBeLessThan(recovery.indexOf('claimNextQueuedFollowUpBatch('));
  });
});
