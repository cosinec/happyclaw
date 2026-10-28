import { describe, expect, test } from 'vitest';

import { resolveAgentTurnAnchor } from '../container/agent-runner/src/agent-turn-contract.js';
import type {
  HappyClawOwnerProfileTurnResult,
  WorkspaceMemorySnapshot,
} from '../container/agent-runner/src/mcp-tools.js';
import { HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK } from '../container/agent-runner/src/owner-profile-context.js';
import {
  decorateUserTurn,
  TurnNoteLedger,
  type TurnNoteSources,
} from '../container/agent-runner/src/turn-notes.js';
import type { ChannelTurnContext } from '../container/agent-runner/src/types.js';

function memory(
  ...items: Array<{ id: string; revision?: number; content?: string }>
): WorkspaceMemorySnapshot {
  const full = items.map((item) => ({
    id: item.id,
    revision: item.revision ?? 1,
    kind: 'fact',
    content: item.content ?? `content of ${item.id}`,
  }));
  return {
    workspaceJid: 'web:ws',
    storeRevision: 7,
    items: full,
    renderedText: [
      '<workspace_memory workspace="web:ws" revision="7">',
      ...full.map(
        (item) =>
          `<memory id="${item.id}" revision="${item.revision}" kind="fact">${item.content}</memory>`,
      ),
      '</workspace_memory>',
    ].join('\n'),
    retrievalTrace: {
      itemRevisions: full.map(({ id, revision }) => ({ id, revision })),
      generatedAt: '2026-10-28T00:00:00.000Z',
    },
  };
}

function owner(
  preferredAddress: string,
  revision = 1,
): HappyClawOwnerProfileTurnResult {
  return {
    projection: {
      workspaceJid: 'web:home',
      preferredAddress,
      revision,
      onboarding: {
        state: 'completed',
        revision: 2,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    },
    onboardingStatus: 'known',
    firstWake: false,
  };
}

function channel(
  messageId: string,
  extra: Partial<ChannelTurnContext> = {},
): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    sourceJid: 'feishu:oc_chat',
    channelAccountId: 'account-1',
    chat: { id: 'oc_chat', type: 'group' },
    message: { id: messageId },
    sender: { openId: 'ou_a' },
    ...extra,
  };
}

const anchor = resolveAgentTurnAnchor(
  {
    id: 'agent',
    name: 'Agent',
    version: 1,
    identityHash: 'hash',
    identityPrompt: 'Follow the release contract.',
  },
  'custom',
);

const sources = (over: Partial<TurnNoteSources> = {}): TurnNoteSources => ({
  memory: memory({ id: 'a' }, { id: 'b' }),
  ownerProfile: owner('小何'),
  channelContext: channel('om_1'),
  anchor,
  ...over,
});

/** Stage one turn and answer it in a healthy result. */
function turn(
  ledger: TurnNoteLedger,
  uuid: string,
  input: TurnNoteSources,
  resumeAnchor?: string,
) {
  const notes = ledger.stage(uuid, input);
  ledger.observeAnswered([uuid]);
  ledger.commitAnswered(resumeAnchor);
  return notes;
}

describe('per-turn notes', () => {
  test('a later turn carries only what changed, and nothing when nothing did', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const first = turn(ledger, 'u1', sources());
    ledger.bindSession('s1');
    expect(first.ownerProfile).toContain('小何');
    expect(first.memory).toContain('content of a');
    expect(first.channel).toContain('"om_1"');
    expect(first.anchor).toBe(anchor);
    expect(first.sentMemory).toEqual([
      { id: 'a', revision: 1 },
      { id: 'b', revision: 1 },
    ]);

    const same = turn(
      ledger,
      'u2',
      sources({ channelContext: channel('om_1') }),
    );
    expect(same).toMatchObject({
      ownerProfile: '',
      memory: '',
      channel: '',
      anchor: undefined,
      sentMemory: [],
    });
    expect(decorateUserTurn('hello', same)).toBe('hello');

    const changed = turn(
      ledger,
      'u3',
      sources({
        memory: memory(
          { id: 'a', revision: 2, content: 'edited a' },
          { id: 'c' },
        ),
        ownerProfile: owner('何先生', 2),
        channelContext: channel('om_3'),
      }),
    );
    expect(changed.sentMemory).toEqual([
      { id: 'a', revision: 2 },
      { id: 'c', revision: 1 },
    ]);
    expect(changed.memory).toContain('edited a');
    expect(changed.memory).not.toContain('content of b');
    expect(changed.ownerProfile).toContain('何先生');
    expect(changed.channel).toContain('changes_only="true"');
    expect(changed.channel).toContain('{"message":{"id":"om_3"}}');
  });

  test('a dropped channel field is sent as null', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(
      ledger,
      'u1',
      sources({
        channelContext: channel('om_1', { mentions: [{ name: 'Bot' }] }),
      }),
    );
    const next = turn(
      ledger,
      'u2',
      sources({ channelContext: channel('om_1') }),
    );
    expect(next.channel).toContain('{"mentions":null}');
  });

  test("a turn without the owner's block withdraws the one in context", () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    const stranger = turn(ledger, 'u2', sources({ ownerProfile: null }));
    expect(stranger.ownerProfile).toBe(HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK);
    expect(
      turn(ledger, 'u3', sources({ ownerProfile: null })).ownerProfile,
    ).toBe('');
    expect(turn(ledger, 'u4', sources()).ownerProfile).toContain('小何');
    // A session that never had a block withdraws nothing.
    const fresh = new TurnNoteLedger();
    fresh.beginQuery(undefined);
    expect(
      turn(fresh, 'v1', sources({ ownerProfile: null })).ownerProfile,
    ).toBe('');
  });

  test('the anchor rides on every tenth turn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const anchored = Array.from({ length: 21 }, (_, i) =>
      turn(ledger, `u${i}`, sources()).anchor ? i + 1 : 0,
    ).filter(Boolean);
    expect(anchored).toEqual([1, 11, 21]);
    // A turn that may not carry it (a continuation) does not count.
    const quiet = new TurnNoteLedger();
    quiet.beginQuery(undefined);
    turn(quiet, 'q0', sources());
    for (let i = 1; i <= 20; i++)
      turn(quiet, `q${i}`, sources({ anchor: undefined }));
    expect(turn(quiet, 'q21', sources()).anchor).toBeUndefined();
  });

  test('notes count only once a healthy result answered their turn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    ledger.stage('u1', sources());
    ledger.bindSession('s1');
    // The turn failed: the next query sends everything again.
    ledger.beginQuery('s1', 'assistant-1');
    expect(ledger.stage('u2', sources()).anchor).toBe(anchor);

    // Answered but not completed (background work pending): not yet sent.
    ledger.observeAnswered(['u2']);
    ledger.beginQuery('s1', 'assistant-2');
    const again = ledger.stage('u3', sources());
    expect(again.memory).toContain('content of a');
    ledger.observeAnswered(['u3']);
    ledger.commitAnswered('assistant-3');
    expect(ledger.stage('u4', sources()).memory).toBe('');
  });

  test('a queued turn plans against the turns ahead of it, merged or not', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    ledger.stage('u1', sources());
    const queued = ledger.stage('u2', sources());
    expect(queued.memory).toBe('');
    // One result answered both (the CLI merged them).
    ledger.observeAnswered(['u1', 'u2']);
    ledger.commitAnswered('assistant-2');
    expect(ledger.stage('u3', sources()).channel).toBe('');

    // A result answers the turn ahead; the queued one is not in yet.
    const split = new TurnNoteLedger();
    split.beginQuery(undefined);
    split.stage('v1', sources());
    split.bindSession('s1');
    split.stage('v2', sources({ memory: memory({ id: 'c' }) }));
    split.observeAnswered(['v1']);
    split.commitAnswered('assistant-v1');
    split.beginQuery('s1'); // v2 was interrupted
    expect(
      split.stage('v3', sources({ memory: memory({ id: 'c' }) })).sentMemory,
    ).toEqual([{ id: 'c', revision: 1 }]);
  });

  test('a retry that resumes at the last healthy turn forgets what came after it', () => {
    // A healthy turn without an assistant uuid does not move the resume point.
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources(), 'assistant-1');
    ledger.bindSession('s1');
    turn(ledger, 'u2', sources({ memory: memory({ id: 'a' }, { id: 'c' }) }));
    ledger.beginQuery('s1', 'assistant-1');
    const retried = ledger.stage(
      'u3',
      sources({ memory: memory({ id: 'c' }) }),
    );
    expect(retried.sentMemory).toEqual([{ id: 'c', revision: 1 }]);
    expect(retried.anchor).toBeUndefined();

    // A compaction during the failed turn: the retry resumes before it.
    const compacted = new TurnNoteLedger();
    compacted.beginQuery(undefined);
    turn(compacted, 'v1', sources(), 'assistant-v1');
    compacted.bindSession('s2');
    compacted.stage('v2', sources({ channelContext: channel('om_2') }));
    compacted.beginCompaction();
    compacted.restoreAfterCompaction();
    compacted.endCompaction();
    compacted.beginQuery('s2', 'assistant-v1');
    const again = compacted.stage(
      'v2-retry',
      sources({ channelContext: channel('om_2') }),
    );
    expect(again.channel).toContain('{"message":{"id":"om_2"}}');
    expect(again.anchor).toBeUndefined();
  });

  test('another session, or a new one, starts over', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    ledger.bindSession('s1');
    ledger.beginQuery('s1');
    expect(ledger.stage('u2', sources()).anchor).toBeUndefined();

    ledger.beginQuery('s2'); // /clear, a provider switch that cleared it
    expect(ledger.stage('u3', sources()).anchor).toBe(anchor);
    ledger.beginQuery(undefined); // /fresh
    expect(ledger.stage('u4', sources()).anchor).toBe(anchor);

    // The CLI answered with another session than the one resumed.
    const other = new TurnNoteLedger();
    other.beginQuery(undefined);
    turn(other, 'v1', sources());
    other.bindSession('s1');
    other.beginQuery('s1');
    other.bindSession('s9');
    expect(other.stage('v2', sources()).anchor).toBe(anchor);
  });

  test('a compaction restores the latest notes in full, once', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    ledger.bindSession('s1');
    // Turn 2 is in flight, carrying only its new channel message.
    ledger.stage(
      'u2',
      sources({ channelContext: channel('om_2'), anchor: undefined }),
    );
    ledger.beginCompaction();
    const restored = ledger.restoreAfterCompaction();
    ledger.endCompaction();
    expect(restored).toContain('<active-agent-turn-contract');
    expect(restored).toContain('小何');
    expect(restored).toContain('content of b');
    expect(restored).toContain('"om_2"');
    expect(restored).not.toContain('changes_only');
    // The restored notes are in the context: the next turn adds nothing.
    const next = ledger.stage(
      'u3',
      sources({ channelContext: channel('om_2') }),
    );
    expect([next.memory, next.channel, next.ownerProfile]).toEqual([
      '',
      '',
      '',
    ]);
    expect(next.anchor).toBeUndefined();
  });

  test('a compaction without a restore sends everything on the next turn', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    turn(ledger, 'u1', sources());
    ledger.beginCompaction();
    ledger.endCompaction();
    const next = ledger.stage('u2', sources());
    expect(next.anchor).toBe(anchor);
    expect(next.memory).toContain('content of a');
  });

  test('decorated turns keep the platform order inside the anchor', () => {
    const ledger = new TurnNoteLedger();
    ledger.beginQuery(undefined);
    const text = decorateUserTurn(
      'the question',
      ledger.stage('u1', sources()),
    );
    const at = (needle: string) => text.indexOf(needle);
    expect(at('<active-agent-turn-contract')).toBe(0);
    expect(at('<workspace_owner_profile')).toBeLessThan(
      at('<workspace_memory_snapshot'),
    );
    expect(at('<workspace_memory_snapshot')).toBeLessThan(
      at('<channel_context'),
    );
    expect(text).toMatch(
      /<channel_context[\s\S]*\n\nthe question\n<\/current-user-message>$/,
    );
  });
});
