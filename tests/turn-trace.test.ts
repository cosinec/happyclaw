import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-trace-'));
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [dataDir, storeDir, groupsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const {
  MAX_TURN_TRACE_EVENTS,
  MAX_TURN_TRACE_THINKING_BYTES,
  TurnTraceAccumulator,
  TurnTraceTracker,
  markMessagesWithTrace,
  presentTurnTrace,
  resolveTurnTraceExposure,
} = await import('../src/turn-trace.js');

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';

const OWNER = 'trace-owner';

function ev(eventType: StreamEventType, extra: Partial<StreamEvent> = {}) {
  return { eventType, ...extra } as StreamEvent;
}

type StoreInput = Parameters<typeof db.upsertTurnTrace>[0];

function tracker(
  mode: InteractionMode,
  visibility: { current: ProcessVisibility } = { current: 'full' },
) {
  const stored: StoreInput[] = [];
  const instance = new TurnTraceTracker({
    mode,
    getVisibility: () => visibility.current,
    store: (input) => {
      stored.push(input);
    },
  });
  return { instance, stored, visibility };
}

/** One tool-using turn: reasoning, a tool call with a result, an answer. */
function playTurn(
  t: InstanceType<typeof TurnTraceTracker>,
  inputId: string,
  startAt = 1_000,
): void {
  t.observe(inputId, ev('status', { statusText: 'requesting' }), startAt);
  t.observe(inputId, ev('thinking_start'), startAt + 100);
  t.observe(inputId, ev('thinking_delta', { text: '先看目录' }), startAt + 200);
  t.observe(
    inputId,
    ev('thinking_end', { thinkingDurationMs: 300 }),
    startAt + 300,
  );
  t.observe(
    inputId,
    ev('tool_use_start', {
      toolName: 'Bash',
      toolUseId: 'tool-1',
      toolInputSummary: 'command: ls',
    }),
    startAt + 400,
  );
  t.observe(
    inputId,
    ev('tool_result', {
      toolUseId: 'tool-1',
      toolResult: 'a.txt',
      detail: 'a.txt',
    }),
    startAt + 500,
  );
  t.observe(
    inputId,
    ev('tool_use_end', { toolUseId: 'tool-1' }),
    startAt + 510,
  );
  t.observe(inputId, ev('status', { statusText: 'requesting' }), startAt + 520);
  t.observe(inputId, ev('thinking_start'), startAt + 700);
  t.observe(inputId, ev('thinking_delta', { text: '再总结' }), startAt + 710);
  t.observe(inputId, ev('thinking_end'), startAt + 720);
  t.observe(inputId, ev('text_delta', { text: '这是答案' }), startAt + 800);
}

describe('TurnTraceAccumulator', () => {
  test('collects thinking, timing and trace rows of a turn', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('thinking_delta', { text: '想' }), 100);
    acc.observe(
      ev('tool_use_start', { toolName: 'Bash', toolUseId: 't' }),
      400,
    );
    acc.observe(ev('tool_use_end', { toolUseId: 't' }), 500);
    const content = acc.toContent({ includeThinking: true, now: 600 })!;
    expect(content.thinking).toBe('想');
    expect(content.thinkingDurationMs).toBe(400);
    expect(content.trace.map((row) => row.title)).toEqual([
      '工具 Bash',
      '工具完成 t',
    ]);
    expect(acc.isEmpty).toBe(false);
  });

  test('a turn that did nothing worth keeping yields no content', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('text_delta', { text: '你好' }), 10);
    acc.observe(ev('status', { statusText: 'requesting' }), 20);
    expect(acc.isEmpty).toBe(true);
    expect(acc.toContent({ includeThinking: true })).toBeNull();
  });

  test('reasoning without any text still records that, and for how long', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('thinking_start'), 1_000);
    acc.observe(ev('thinking_end', { thinkingDurationMs: 2_000 }), 1_500);
    expect(acc.toContent({ includeThinking: true })).toEqual({
      thinking: '',
      thinkingDurationMs: 2_000,
      trace: [],
    });
  });

  test('tool_progress updates the tool row instead of adding rows', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' }), 10);
    acc.observe(
      ev('tool_use_start', { toolName: 'Skill', toolUseId: 's' }),
      20,
    );
    // a long-running tool reports its elapsed time again and again
    for (let i = 0; i < 100; i += 1) {
      acc.observe(
        ev('tool_progress', {
          toolName: 'Bash',
          toolUseId: 'b',
          elapsedSeconds: i,
        }),
        30 + i,
      );
    }
    acc.observe(
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'b',
        toolInputSummary: 'command: sleep 100',
      }),
      200,
    );
    acc.observe(
      ev('tool_progress', {
        toolName: 'Skill',
        toolUseId: 's',
        skillName: 'pdf',
      }),
      210,
    );
    acc.observe(ev('tool_use_end', { toolUseId: 'b' }), 300);
    const { trace } = acc.toContent({ includeThinking: false })!;
    expect(trace.map((row) => [row.kind, row.title, row.summary])).toEqual([
      ['tool', '工具 Bash', 'command: sleep 100'],
      ['skill', '技能 pdf', undefined],
      ['tool', '工具完成 b', undefined],
    ]);
  });

  test('keeps the newest 200 trace rows', () => {
    const acc = new TurnTraceAccumulator(0);
    for (let i = 0; i < MAX_TURN_TRACE_EVENTS + 25; i += 1) {
      acc.observe(
        ev('tool_use_start', { toolName: `T${i}`, toolUseId: `t${i}` }),
        i,
      );
    }
    const { trace } = acc.toContent({ includeThinking: false })!;
    expect(trace).toHaveLength(MAX_TURN_TRACE_EVENTS);
    expect(trace[0].title).toBe('工具 T25');
    expect(trace.at(-1)!.title).toBe(`工具 T${MAX_TURN_TRACE_EVENTS + 24}`);
  });

  test('thinking beyond 64KB keeps the tail and says it was cut', () => {
    const acc = new TurnTraceAccumulator(0);
    const paragraph = `${'推理'.repeat(500)}\n\n`;
    for (let i = 0; i < 120; i += 1) {
      acc.observe(ev('thinking_delta', { text: `${i}:${paragraph}` }), i + 1);
    }
    const { thinking } = acc.toContent({ includeThinking: true })!;
    expect(Buffer.byteLength(thinking, 'utf8')).toBeLessThanOrEqual(
      MAX_TURN_TRACE_THINKING_BYTES,
    );
    expect(thinking.startsWith('…\n\n')).toBe(true);
    // the newest paragraph survives, whole
    expect(thinking.trimEnd().endsWith(`119:${'推理'.repeat(500)}`)).toBe(true);
  });

  test('absorb appends a later part of the same reply sequence', () => {
    const first = new TurnTraceAccumulator(0);
    first.observe(ev('thinking_delta', { text: '甲' }), 100);
    first.observe(ev('text_delta', { text: '字' }), 300);
    const second = new TurnTraceAccumulator(1_000);
    second.observe(ev('thinking_delta', { text: '乙' }), 1_100);
    second.observe(ev('text_delta', { text: '字' }), 1_150);
    first.absorb(second, 2_000);
    const content = first.toContent({ includeThinking: true })!;
    expect(content.thinking).toBe('甲\n\n乙');
    expect(content.thinkingDurationMs).toBe(300 + 150);
  });
});

describe('TurnTraceTracker', () => {
  test('an Assistant turn is recorded as it ran, tool results included', () => {
    const { instance, stored } = tracker('assistant');
    playTurn(instance, 'in-1');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(true);
    expect(stored).toHaveLength(1);
    const [row] = stored;
    expect(row).toMatchObject({
      chatJid: 'web:a',
      turnId: 'in-1',
      thinking: '先看目录\n\n再总结',
    });
    const trace = JSON.parse(row.traceJson);
    expect(trace.map((r: { title: string }) => r.title)).toEqual([
      '工具 Bash',
      '工具结果',
      '工具完成 tool-1',
    ]);
    // the result text is part of what an Assistant workspace shows
    expect(trace[1].detail).toBe('a.txt');
    expect(row.thinkingDurationMs).toBeGreaterThan(0);
    // once stored, the turn is no longer pending
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
  });

  test('turns of one warm Runner are kept apart', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
    );
    instance.observe(
      'in-2',
      ev('tool_use_start', { toolName: 'B', toolUseId: 'b' }),
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-2' });
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    expect(
      stored.map((s) => [s.turnId, JSON.parse(s.traceJson)[0].title]),
    ).toEqual([
      ['in-2', '工具 B'],
      ['in-1', '工具 A'],
    ]);
  });

  test('a hidden proactive workspace records nothing', () => {
    const { instance, stored } = tracker('proactive', { current: 'hidden' });
    playTurn(instance, 'in-1');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
    expect(stored).toHaveLength(0);
  });

  test('activity keeps the structure but never the thinking text', () => {
    const { instance, stored } = tracker('proactive', { current: 'activity' });
    playTurn(instance, 'in-1');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(true);
    const [row] = stored;
    expect(row.thinking).toBe('');
    expect(row.thinkingDurationMs).toBeGreaterThan(0);
    expect(
      JSON.parse(row.traceJson).map((r: { title: string }) => r.title),
    ).toEqual(['工具 Bash', '工具结果', '工具完成 tool-1']);
  });

  test('full keeps thinking; no proactive level keeps what a tool returned', () => {
    const { instance, stored } = tracker('proactive', { current: 'full' });
    playTurn(instance, 'in-1');
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    const [row] = stored;
    expect(row.thinking).toBe('先看目录\n\n再总结');
    const result = JSON.parse(row.traceJson).find(
      (r: { title: string }) => r.title === '工具结果',
    );
    expect(result.detail).toBeUndefined();
    expect(row.traceJson).not.toContain('a.txt');
    expect(row.traceJson).not.toContain('这是答案');
  });

  test('the visibility is read live: a turn follows a change made while it runs', () => {
    const visibility = { current: 'hidden' as ProcessVisibility };
    const { instance, stored } = tracker('proactive', visibility);
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'Early', toolUseId: 'e' }),
    );
    visibility.current = 'activity';
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'Late', toolUseId: 'l' }),
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    expect(
      JSON.parse(stored[0].traceJson).map((r: { title: string }) => r.title),
    ).toEqual(['工具 Late']);

    // lowered to hidden before the turn settles: nothing is written
    visibility.current = 'full';
    instance.observe(
      'in-2',
      ev('tool_use_start', { toolName: 'X', toolUseId: 'x' }),
    );
    visibility.current = 'hidden';
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-2' })).toBe(false);
    expect(stored).toHaveLength(1);
  });

  test('a held reply sequence is written under its first turn id, and grows', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
      10,
    );
    // first held part: the sequence's DB turn id is the first input's
    instance.persist({
      chatJid: 'web:a',
      inputId: 'in-1',
      turnId: 'in-1',
      keep: true,
    });
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'B', toolUseId: 'b' }),
      20,
    );
    // the continuation turn has its own input id
    instance.observe(
      'in-2',
      ev('tool_use_start', { toolName: 'C', toolUseId: 'c' }),
      30,
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-2', turnId: 'in-1' });
    expect(stored.map((s) => s.turnId)).toEqual(['in-1', 'in-1']);
    expect(
      JSON.parse(stored[1].traceJson).map((r: { title: string }) => r.title),
    ).toEqual(['工具 A', '工具 B', '工具 C']);
  });

  test('a failing store never loses the reply', () => {
    const instance = new TurnTraceTracker({
      mode: 'assistant',
      getVisibility: () => 'full',
      store: () => {
        throw new Error('disk full');
      },
    });
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
    );
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
  });

  test('discard forgets a turn; a queue of unsettled turns stays bounded', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'gone',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
    );
    instance.discard('gone');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'gone' })).toBe(false);

    for (let i = 0; i < 100; i += 1) {
      instance.observe(
        `t${i}`,
        ev('tool_use_start', { toolName: 'A', toolUseId: `a${i}` }),
      );
    }
    expect(instance.persist({ chatJid: 'web:a', inputId: 't0' })).toBe(false);
    expect(instance.persist({ chatJid: 'web:a', inputId: 't99' })).toBe(true);
    expect(stored).toHaveLength(1);
  });
});

function createUser(id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

function createWorkspace(
  folder: string,
  mode: InteractionMode,
  visibility: ProcessVisibility,
): void {
  const profile = db.getOrCreateDefaultAgentProfile(OWNER);
  db.setRegisteredGroup(`web:${folder}`, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    created_by: OWNER,
    executionMode: 'container',
  });
  db.assignWorkspaceAgentProfile(folder, profile.id, mode, visibility);
}

const JID = 'web:trace-chat';
let minute = 0;

function storeMessage(
  id: string,
  turnId: string | undefined,
  options: { fromMe?: boolean; sender?: string; chatJid?: string } = {},
): void {
  const chatJid = options.chatJid ?? JID;
  db.ensureChatExists(chatJid);
  minute += 1;
  db.storeMessageDirect(
    id,
    chatJid,
    options.sender ?? (options.fromMe === false ? 'user-1' : 'happyclaw-agent'),
    options.fromMe === false ? 'User' : 'HappyClaw',
    `content ${id}`,
    `2026-10-12T00:${String(minute).padStart(2, '0')}:00.000Z`,
    options.fromMe !== false,
    turnId ? { meta: { turnId } } : undefined,
  );
}

function storeTrace(turnId: string, chatJid = JID): void {
  db.upsertTurnTrace({
    chatJid,
    turnId,
    thinking: '想了想',
    thinkingDurationMs: 1_200,
    traceJson: JSON.stringify([
      { id: '1-a', timestamp: 1, kind: 'tool', title: '工具 Bash' },
    ]),
  });
}

describe('stored traces and the messages that carry them', () => {
  beforeAll(() => {
    db.initDatabase();
    createUser(OWNER);
  });
  afterAll(() => {
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the real store keeps what the tracker collected', () => {
    const real = new TurnTraceTracker({
      mode: 'assistant',
      getVisibility: () => 'full',
    });
    playTurn(real, 'real-1');
    storeMessage('m-real', 'real-1');
    expect(real.persist({ chatJid: JID, inputId: 'real-1' })).toBe(true);
    const record = db.getTurnTrace(JID, 'real-1')!;
    expect(record.thinking).toBe('先看目录\n\n再总结');
    expect(
      presentTurnTrace(record, { visible: true, includeThinking: true }),
    ).toMatchObject({
      turn_id: 'real-1',
      thinking: '先看目录\n\n再总结',
      thinking_duration_ms: record.thinking_duration_ms,
      trace: [
        { title: '工具 Bash' },
        { title: '工具结果' },
        { title: '工具完成 tool-1' },
      ],
    });
  });

  test('presenting honours the exposure and survives a damaged trace', () => {
    storeTrace('present-1');
    const record = db.getTurnTrace(JID, 'present-1')!;
    expect(
      presentTurnTrace(record, { visible: true, includeThinking: false }),
    ).toMatchObject({ thinking: '', thinking_duration_ms: 1_200 });
    expect(
      presentTurnTrace(
        { ...record, trace_json: '{not json' },
        { visible: true, includeThinking: true },
      ),
    ).toMatchObject({ thinking: '想了想', trace: [] });
  });

  test('the newest agent message of a turn is its last one', () => {
    storeMessage('t1-user', 'turn-1', { fromMe: false });
    storeMessage('t1-a', 'turn-1');
    storeMessage('t1-b', 'turn-1');
    storeMessage('t1-notice', 'turn-1', { sender: '__system__' });
    expect(db.getLastAgentMessageIdForTurn(JID, 'turn-1')).toBe('t1-b');
    expect(
      db.getLastAgentMessageIdForTurn(JID, 'no-such-turn'),
    ).toBeUndefined();
    expect(
      db.getLastAgentMessageIdForTurn('web:other', 'turn-1'),
    ).toBeUndefined();
  });

  test('has_trace goes on the last agent message of a traced turn only', () => {
    storeMessage('t2-user', 'turn-2', { fromMe: false });
    storeMessage('t2-a', 'turn-2');
    storeMessage('t2-b', 'turn-2');
    storeMessage('t3-a', 'turn-3');
    storeMessage('t4-a', undefined);
    storeTrace('turn-2');
    const wanted = new Set(['t2-user', 't2-a', 't2-b', 't3-a', 't4-a']);
    const listed = db
      .getMessagesPage(JID, undefined, 200)
      .filter((m) => wanted.has(m.id));
    expect(listed).toHaveLength(5);
    const marked = markMessagesWithTrace(listed, {
      visible: true,
      includeThinking: true,
    });
    expect(marked.filter((m) => m.has_trace).map((m) => m.id)).toEqual([
      't2-b',
    ]);

    // a page that ends before the turn does: the flag waits for the page that
    // holds the true last message
    const olderPage = marked.filter((m) => m.id !== 't2-b');
    expect(
      markMessagesWithTrace(olderPage, {
        visible: true,
        includeThinking: true,
      }).some((m) => m.has_trace),
    ).toBe(false);

    // nothing is flagged where traces are hidden
    expect(
      markMessagesWithTrace(listed, { visible: false, includeThinking: false }),
    ).toBe(listed);
  });

  test('deleting the last message of a turn takes its trace along', () => {
    storeMessage('t5-a', 'turn-5');
    storeMessage('t5-b', 'turn-5');
    storeTrace('turn-5');
    expect(db.deleteMessage(JID, 't5-a')).toBe(true);
    expect(db.getTurnTrace(JID, 'turn-5')).toBeDefined();
    expect(db.deleteMessage(JID, 't5-b')).toBe(true);
    expect(db.getTurnTrace(JID, 'turn-5')).toBeUndefined();
  });

  test('clearing a chat removes its traces and spares the others', () => {
    const other = 'web:trace-other';
    storeMessage('c-a', 'turn-c', { chatJid: 'web:trace-clear' });
    storeMessage('o-a', 'turn-c', { chatJid: other });
    storeTrace('turn-c', 'web:trace-clear');
    storeTrace('turn-c', other);
    db.deleteChatHistory('web:trace-clear');
    expect(db.getTurnTrace('web:trace-clear', 'turn-c')).toBeUndefined();
    expect(db.getTurnTrace(other, 'turn-c')).toBeDefined();
  });

  test('a chat tree takes its Runtime Session traces with it, exactly', () => {
    const base = 'web:tree_1';
    for (const jid of [
      base,
      `${base}#agent:s1`,
      `${base}#agent:s2`,
      'web:treeX1',
      `${base}2`,
    ]) {
      storeMessage(`tree-${jid}`, 'turn-t', { chatJid: jid });
      storeTrace('turn-t', jid);
    }
    expect(db.deleteTurnTracesForChatTree(base)).toBe(3);
    expect(db.getTurnTrace('web:treeX1', 'turn-t')).toBeDefined();
    expect(db.getTurnTrace(`${base}2`, 'turn-t')).toBeDefined();
    expect(db.getTurnTrace(`${base}#agent:s1`, 'turn-t')).toBeUndefined();
  });

  test('exposure follows the workspace contract and its current visibility', () => {
    createWorkspace('expo-assistant', 'assistant', 'hidden');
    createWorkspace('expo-hidden', 'proactive', 'hidden');
    createWorkspace('expo-activity', 'proactive', 'activity');
    createWorkspace('expo-full', 'proactive', 'full');
    expect(resolveTurnTraceExposure('expo-assistant')).toEqual({
      visible: true,
      includeThinking: true,
    });
    expect(resolveTurnTraceExposure('expo-hidden')).toEqual({
      visible: false,
      includeThinking: false,
    });
    expect(resolveTurnTraceExposure('expo-activity')).toEqual({
      visible: true,
      includeThinking: false,
    });
    expect(resolveTurnTraceExposure('expo-full')).toEqual({
      visible: true,
      includeThinking: true,
    });
    // fire-and-forget Spawn Agents keep Assistant semantics
    expect(
      resolveTurnTraceExposure('expo-hidden', { agentKind: 'spawn' }),
    ).toEqual({
      visible: true,
      includeThinking: true,
    });
    // a change takes effect at once, whatever the turn was recorded under
    db.setWorkspaceProcessVisibility('expo-hidden', 'full');
    expect(resolveTurnTraceExposure('expo-hidden').visible).toBe(true);
  });
});
