import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'routes-process-visibility-'),
);
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [dataDir, storeDir, groupsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    DATA_DIR: dataDir,
    STORE_DIR: storeDir,
    GROUPS_DIR: groupsDir,
    isDockerAvailable: vi.fn(async () => true),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = process.env.HAPPYCLAW_VISIBILITY_TEST_USER ?? 'visibility-owner';
    c.set('user', {
      id,
      username: id,
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;
const turnTraceRoutes = (await import('../src/routes/turn-traces.js')).default;

const OWNER_ID = 'visibility-owner';
const STRANGER_ID = 'visibility-stranger';
const registeredGroups: Record<string, any> = {};
const sessions: Record<string, string> = {};
const stopGroup = vi.fn(async () => {});
const queue = {
  pauseGroupsForMutation: vi.fn(() => ({ id: 1 })),
  resumeGroupsAfterMutation: vi.fn(),
  listDescendantJids: vi.fn(() => []),
  stopGroup,
  isGroupRuntimeSafetyBlocked: vi.fn(() => false),
  blockGroupsForRuntimeSafety: vi.fn(),
  unblockGroupsForRuntimeSafety: vi.fn(),
};

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

function asUser(id: string): void {
  process.env.HAPPYCLAW_VISIBILITY_TEST_USER = id;
}

function workspace(
  slug: string,
  mode: 'assistant' | 'proactive',
  visibility?: 'hidden' | 'activity' | 'full',
): { jid: string; folder: string } {
  const jid = `web:${slug}`;
  db.setRegisteredGroup(jid, {
    name: slug,
    folder: slug,
    added_at: new Date().toISOString(),
    created_by: OWNER_ID,
    executionMode: 'container',
  });
  registeredGroups[jid] = db.getRegisteredGroup(jid);
  db.assignWorkspaceAgentProfile(
    slug,
    db.getOrCreateDefaultAgentProfile(OWNER_ID).id,
    mode,
    visibility,
  );
  return { jid, folder: slug };
}

const json = { 'content-type': 'application/json' };
const patchGroup = (jid: string, body: unknown) =>
  groupRoutes.request(`/${encodeURIComponent(jid)}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify(body),
  });

beforeAll(() => {
  db.initDatabase();
  createUser(OWNER_ID);
  createUser(STRANGER_ID);
  webContext.setWebDeps({
    queue,
    sessions,
    getRegisteredGroups: () => registeredGroups,
    ensureTerminalContainerStarted: vi.fn(() => true),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_VISIBILITY_TEST_USER;
  vi.clearAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace process_visibility API', () => {
  test('a new workspace defaults to activity and may be created with any level', async () => {
    asUser(OWNER_ID);
    const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    const create = (extra: Record<string, unknown>) =>
      groupRoutes.request('/', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          name: 'Visibility Workspace',
          agent_profile_id: profile.id,
          execution_mode: 'container',
          interaction_mode: 'proactive',
          ...extra,
        }),
      });

    const defaulted = await (await create({})).json();
    expect(defaulted.group.process_visibility).toBe('activity');
    expect(db.getWorkspaceProcessVisibility(defaulted.group.folder)).toBe(
      'activity',
    );

    for (const level of ['hidden', 'full'] as const) {
      const created = await (
        await create({ process_visibility: level })
      ).json();
      expect(created.group.process_visibility).toBe(level);
      expect(db.getWorkspaceProcessVisibility(created.group.folder)).toBe(
        level,
      );
    }

    const rejected = await create({ process_visibility: 'everything' });
    expect(rejected.status).toBe(400);
  });

  test('the group list carries the effective value of every web workspace', async () => {
    asUser(OWNER_ID);
    const legacy = workspace('visibility-legacy', 'proactive');
    db.setWorkspaceProcessVisibility(legacy.folder, 'hidden');
    const shown = workspace('visibility-shown', 'assistant', 'full');

    const body = await (
      await groupRoutes.request('/', { method: 'GET' })
    ).json();
    expect(body.groups[legacy.jid].process_visibility).toBe('hidden');
    expect(body.groups[shown.jid].process_visibility).toBe('full');
    for (const [jid, group] of Object.entries<any>(body.groups)) {
      if (jid.startsWith('web:')) {
        expect(['hidden', 'activity', 'full']).toContain(
          group.process_visibility,
        );
      }
    }
  });

  test('the owner changes it live: no quiesce, no restart, no session reset', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace('visibility-live', 'proactive', 'hidden');
    db.setSession(folder, 'sdk-session-keep');
    sessions[folder] = 'sdk-session-keep';

    const response = await patchGroup(jid, { process_visibility: 'full' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('full');
    // the interaction contract is untouched
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(stopGroup).not.toHaveBeenCalled();
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    expect(db.getSession(folder)).toBe('sdk-session-keep');
    expect(sessions[folder]).toBe('sdk-session-keep');
  });

  test('an Assistant workspace may store the setting too', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace(
      'visibility-assistant',
      'assistant',
      'hidden',
    );
    const response = await patchGroup(jid, { process_visibility: 'activity' });
    expect(response.status).toBe(200);
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('activity');
    expect(db.getWorkspaceInteractionMode(folder)).toBe('assistant');
  });

  test('changing the mode and the visibility together applies both', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace('visibility-both', 'assistant', 'hidden');
    const response = await patchGroup(jid, {
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('full');
  });

  test('only the owner may change it, and only on web workspaces', async () => {
    const { jid, folder } = workspace(
      'visibility-denied',
      'proactive',
      'hidden',
    );

    asUser(STRANGER_ID);
    expect((await patchGroup(jid, { process_visibility: 'full' })).status).toBe(
      404,
    );
    expect(db.getWorkspaceProcessVisibility(folder)).toBe('hidden');

    asUser(OWNER_ID);
    expect((await patchGroup(jid, { process_visibility: 'nope' })).status).toBe(
      400,
    );
    expect((await patchGroup(jid, {})).status).toBe(400);

    const imJid = 'feishu:oc_visibility_im';
    db.setRegisteredGroup(imJid, {
      name: 'IM Chat',
      folder: 'visibility-im',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[imJid] = db.getRegisteredGroup(imJid);
    const im = await patchGroup(imJid, { process_visibility: 'full' });
    expect(im.status).toBe(403);
  });

  test('a workspace without an AgentProfile binding answers 409', async () => {
    asUser(OWNER_ID);
    const jid = 'web:visibility-unbound';
    db.setRegisteredGroup(jid, {
      name: 'Unbound',
      folder: 'visibility-unbound',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[jid] = db.getRegisteredGroup(jid);
    const response = await patchGroup(jid, { process_visibility: 'full' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'WORKSPACE_AGENT_PROFILE_MISSING',
    });
  });
});

/** A turn of a workspace: a user message, two agent messages, a stored trace. */
function seedTurn(
  chatJid: string,
  turnId: string,
  options: { thinking?: string } = {},
): void {
  db.ensureChatExists(chatJid);
  const at = (minute: number) =>
    `2026-10-12T01:${String(minute).padStart(2, '0')}:00.000Z`;
  db.storeMessageDirect(
    `${turnId}-user`,
    chatJid,
    OWNER_ID,
    'Owner',
    'hi',
    at(1),
    false,
    {
      meta: { turnId },
    },
  );
  db.storeMessageDirect(
    `${turnId}-a`,
    chatJid,
    'happyclaw-agent',
    'Agent',
    'one',
    at(2),
    true,
    {
      meta: { turnId, sourceKind: 'sdk_send_message' },
    },
  );
  db.storeMessageDirect(
    `${turnId}-b`,
    chatJid,
    'happyclaw-agent',
    'Agent',
    'two',
    at(3),
    true,
    {
      meta: { turnId, sourceKind: 'sdk_send_message' },
    },
  );
  db.upsertTurnTrace({
    chatJid,
    turnId,
    thinking: options.thinking ?? '想了想',
    thinkingDurationMs: 4_200,
    traceJson: JSON.stringify([
      { id: '1-a', timestamp: 1, kind: 'tool', title: '工具 Bash' },
    ]),
  });
}

const getMessages = async (jid: string) =>
  (await (
    await groupRoutes.request(`/${encodeURIComponent(jid)}/messages`, {
      method: 'GET',
    })
  ).json()) as { messages: Array<{ id: string; has_trace?: boolean }> };

const getTrace = (jid: string, turnId: string) =>
  turnTraceRoutes.request(
    `/${encodeURIComponent(jid)}/turn-traces/${encodeURIComponent(turnId)}`,
    { method: 'GET' },
  );

describe('turn traces over HTTP', () => {
  test('an Assistant workspace lists has_trace and serves the whole trace', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('trace-assistant', 'assistant', 'hidden');
    seedTurn(jid, 'turn-a');

    const { messages } = await getMessages(jid);
    expect(messages.filter((m) => m.has_trace).map((m) => m.id)).toEqual([
      'turn-a-b',
    ]);

    const response = await getTrace(jid, 'turn-a');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toMatchObject({
      turn_id: 'turn-a',
      thinking: '想了想',
      thinking_duration_ms: 4_200,
      trace: [{ title: '工具 Bash', kind: 'tool' }],
      created_at: expect.any(String),
    });
    expect((await getTrace(jid, 'no-such-turn')).status).toBe(404);
  });

  test('a proactive workspace follows its current visibility', async () => {
    asUser(OWNER_ID);
    const { jid, folder } = workspace('trace-proactive', 'proactive', 'full');
    seedTurn(jid, 'turn-p');

    expect((await (await getTrace(jid, 'turn-p')).json()).thinking).toBe(
      '想了想',
    );
    expect((await getMessages(jid)).messages.some((m) => m.has_trace)).toBe(
      true,
    );

    db.setWorkspaceProcessVisibility(folder, 'activity');
    const activity = await getTrace(jid, 'turn-p');
    expect(activity.status).toBe(200);
    await expect(activity.json()).resolves.toMatchObject({
      thinking: '',
      thinking_duration_ms: 4_200,
      trace: [{ title: '工具 Bash' }],
    });
    expect((await getMessages(jid)).messages.some((m) => m.has_trace)).toBe(
      true,
    );

    db.setWorkspaceProcessVisibility(folder, 'hidden');
    expect((await getTrace(jid, 'turn-p')).status).toBe(404);
    expect((await getMessages(jid)).messages.some((m) => m.has_trace)).toBe(
      false,
    );
  });

  test('other users get a 404, like every other resource of the workspace', async () => {
    const { jid } = workspace('trace-private', 'assistant');
    seedTurn(jid, 'turn-x');
    asUser(STRANGER_ID);
    expect((await getTrace(jid, 'turn-x')).status).toBe(404);
    expect((await getTrace('web:no-such-workspace', 'turn-x')).status).toBe(
      404,
    );
  });

  test('a Runtime Session trace is read through its virtual chat JID', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('trace-session', 'assistant');
    const agentId = 'session-trace-1';
    db.createAgent({
      id: agentId,
      group_folder: 'trace-session',
      chat_jid: jid,
      name: 'Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    const virtualJid = `${jid}#agent:${agentId}`;
    seedTurn(virtualJid, 'turn-s', { thinking: '会话里的思考' });

    const response = await getTrace(virtualJid, 'turn-s');
    expect(response.status).toBe(200);
    expect((await response.json()).thinking).toBe('会话里的思考');
    // the session list flags its last agent message
    const listed = (await (
      await groupRoutes.request(
        `/${encodeURIComponent(jid)}/messages?agentId=${agentId}`,
        { method: 'GET' },
      )
    ).json()) as { messages: Array<{ id: string; has_trace?: boolean }> };
    expect(listed.messages.filter((m) => m.has_trace).map((m) => m.id)).toEqual(
      ['turn-s-b'],
    );

    // another workspace's session id does not open it
    const otherWorkspace = workspace('trace-session-other', 'assistant');
    expect(
      (await getTrace(`${otherWorkspace.jid}#agent:${agentId}`, 'turn-s'))
        .status,
    ).toBe(404);
  });

  test('deleting the last message of a turn removes its trace', async () => {
    asUser(OWNER_ID);
    const { jid } = workspace('trace-delete', 'assistant');
    seedTurn(jid, 'turn-d');
    // user messages cannot be deleted by a member? they are the sender's own
    db.deleteMessage(jid, 'turn-d-a');
    expect((await getTrace(jid, 'turn-d')).status).toBe(200);
    db.deleteMessage(jid, 'turn-d-b');
    db.deleteMessage(jid, 'turn-d-user');
    expect((await getTrace(jid, 'turn-d')).status).toBe(404);
  });
});
