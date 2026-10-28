/**
 * The chat picker labels "default" with `default.model`. It must name the
 * model a launch without a conversation pick really runs, so the label is
 * checked against the real pool selection, not against a copy of its rules.
 *
 * Real configuration file and database in a temp DATA_DIR.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-default-label-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: OWNER,
      username: OWNER,
      role: 'admin',
      permissions: ['manage_system_config'],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({ broadcastNewMessage: () => {} }));
vi.mock(
  '../src/codex-gateway/model-catalog-sync.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // The picker may ask for a fresher catalog; nothing leaves the test.
    maybeRefreshCodexProviderCatalog: () => {},
  }),
);

const OWNER = vi.hoisted(() => 'label-owner');
const JID = 'web:default-label';
const FOLDER = 'default-label';

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

let glm: ReturnType<typeof runtimeConfig.createProvider>;
let kimi: ReturnType<typeof runtimeConfig.createProvider>;
let chatgpt: ReturnType<typeof runtimeConfig.createProvider>;
let agentId = '';

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups', FOLDER), { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Default label',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER,
  } as never);
  glm = runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://glm.example.test',
    anthropicAuthToken: 'glm-token',
    anthropicModel: 'glm-5',
    models: [{ id: 'glm-5' }, { id: 'glm-5-air', hidden: true }],
    enabled: true,
  });
  kimi = runtimeConfig.createProvider({
    name: 'Kimi',
    type: 'third_party',
    anthropicBaseUrl: 'https://kimi.example.test',
    anthropicAuthToken: 'kimi-token',
    anthropicModel: 'kimi-k3',
    enabled: false,
  });
  chatgpt = runtimeConfig.createProvider({
    name: 'ChatGPT',
    type: 'third_party',
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: 'gateway-identifier',
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct',
      planType: null,
      email: null,
    },
    enabled: false,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  runtimeConfig.setDefaultModelConfig(null);
  runtimeConfig.setProviderEnabled(glm.id, true);
  runtimeConfig.setProviderEnabled(kimi.id, false);
  db.deleteWorkspaceAgentProfile(FOLDER);
  db.deleteAllSessionsForFolder(FOLDER);
  agentId = '';
  for (const provider of [glm, kimi, chatgpt]) {
    providerPool.resetHealth(provider.id);
  }
});

/** Bind the workspace to an Agent on (configuration, model). */
function bindAgent(modelConfigId: string, model?: string): void {
  const profile = db.createAgentProfile({
    ownerUserId: OWNER,
    name: `Agent ${Math.random()}`,
    modelConfigId,
    model,
  });
  db.assignWorkspaceAgentProfile(FOLDER, profile.id);
  agentId = profile.id;
}

async function labelled(): Promise<{
  source: string;
  modelConfigId: string | null;
  model: string | null;
  effort: string | null;
}> {
  const res = await groupRoutes.request(
    `/${encodeURIComponent(JID)}/model-selection`,
  );
  expect(res.status).toBe(200);
  return (await res.json()).default;
}

/** What a launch without a conversation pick runs. */
function launched(): {
  profileId: string;
  model: string | null;
  /** CLAUDE_CODE_EFFORT_LEVEL in the environment the launch builds. */
  effort: string | null;
} {
  const profile = agentId ? db.getAgentProfile(agentId) : undefined;
  const selection = runner.trySelectPoolProvider(
    FOLDER,
    null,
    profile?.model_config_id,
    null,
    profile?.model,
  )!;
  providerPool.releaseSession(selection.profileId);
  const effortLine = runtimeConfig
    .buildClaudeEnvLines(
      selection.resolved.config,
      selection.resolved.customEnv,
    )
    .find((line) => line.startsWith('CLAUDE_CODE_EFFORT_LEVEL='));
  return {
    profileId: selection.profileId,
    model: selection.sessionModel || null,
    effort: effortLine?.split('=')[1] ?? null,
  };
}

async function expectLabelMatchesLaunch(expected: {
  source: string;
  model: string | null;
  effort?: string | null;
}) {
  const label = await labelled();
  const launch = launched();
  expect(label).toMatchObject(expected);
  expect(label.modelConfigId).toBe(launch.profileId);
  expect(label.model).toBe(launch.model);
  // A model that takes efforts runs at the one the label names.
  if (expected.effort) expect(label.effort).toBe(launch.effort);
}

describe('default.model names what an unpicked launch runs', () => {
  test("an Agent's model within its configuration", async () => {
    bindAgent(glm.id, 'glm-5-air');
    // glm-5-air runs low, but takes no effort a conversation could pick.
    await expectLabelMatchesLaunch({
      source: 'agent',
      model: 'glm-5-air',
      effort: null,
    });
  });

  test("an Agent's model the configuration no longer offers", async () => {
    bindAgent(glm.id, 'glm-4-gone');
    await expectLabelMatchesLaunch({ source: 'agent', model: 'glm-5' });
  });

  test('an Agent bound to a configuration without a model', async () => {
    bindAgent(kimi.id);
    await expectLabelMatchesLaunch({
      source: 'agent',
      model: 'kimi-k3',
      effort: 'max',
    });
  });

  test('the global default', async () => {
    runtimeConfig.setDefaultModelConfig(kimi.id);
    await expectLabelMatchesLaunch({
      source: 'default',
      model: 'kimi-k3',
      effort: 'max',
    });
  });

  test('the single enabled configuration', async () => {
    await expectLabelMatchesLaunch({ source: 'single', model: 'glm-5' });
  });

  test('a ChatGPT subscription, as default and as an Agent model', async () => {
    runtimeConfig.setDefaultModelConfig(chatgpt.id);
    await expectLabelMatchesLaunch({ source: 'default', model: 'gpt-6-sol' });
    // ChatGPT's effort is the gateway's, as its catalog view reports it.
    const chatgptView = (
      await (
        await groupRoutes.request(`/${encodeURIComponent(JID)}/model-selection`)
      ).json()
    ).options.find((option: { id: string }) => option.id === chatgpt.id).codex;
    expect((await labelled()).effort).toBe(
      chatgptView.models.find(
        (model: { value: string }) => model.value === 'gpt-6-sol',
      ).defaultEffort,
    );

    bindAgent(chatgpt.id, 'gpt-6.1-sol');
    await expectLabelMatchesLaunch({ source: 'agent', model: 'gpt-6.1-sol' });
  });

  test('the automatic pool names no model', async () => {
    runtimeConfig.setProviderEnabled(kimi.id, true);
    expect(await labelled()).toMatchObject({
      source: 'pool',
      modelConfigId: null,
      model: null,
    });
  });
});
