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
