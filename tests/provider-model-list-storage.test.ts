import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-model-list-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

const configFile = path.join(root, 'config', 'claude-provider.json');

type StoredFile = {
  version: number;
  providers: Array<Record<string, unknown>>;
};

function readFile(): StoredFile {
  return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as StoredFile;
}

function writeFile(file: StoredFile): void {
  fs.writeFileSync(configFile, JSON.stringify(file, null, 2));
}

function createThirdParty(
  patch: Partial<Parameters<typeof runtimeConfig.createProvider>[0]> = {},
) {
  return runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    anthropicAuthToken: 'glm-secret-123456',
    anthropicModel: 'glm-5.3',
    ...patch,
  });
}

const PASSED = {
  ok: true,
  code: null,
  status: 200,
  model: 'glm-5.3',
  latencyMs: 120,
  at: '2026-10-20T08:00:00.000Z',
} as const;

beforeEach(() => {
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('stored model lists', () => {
  test('a connection saved before lists existed offers its one model', () => {
    const created = createThirdParty();
    // The file is what an earlier release wrote: none of the new fields.
    const file = readFile();
    expect(file.version).toBe(5);
    expect(Object.keys(file.providers[0])).not.toEqual(
      expect.arrayContaining(['models']),
    );
    expect(file.providers[0]).not.toHaveProperty('presetId');
    expect(file.providers[0]).not.toHaveProperty('lastTest');

    const [provider] = runtimeConfig.getProviders();
    expect(provider.models).toBeUndefined();
    expect(runtimeConfig.toPublicProvider(provider)).toMatchObject({
      id: created.id,
      anthropicModel: 'glm-5.3',
      models: [{ id: 'glm-5.3' }],
      presetId: null,
      lastTest: null,
    });
  });

  test('a pass-through relay without a model offers none', () => {
    createThirdParty({ anthropicModel: '' });
    const [provider] = runtimeConfig.getProviders();
    expect(runtimeConfig.toPublicProvider(provider).models).toEqual([]);
  });

  test('creating stores the list, the default first and visible, and the preset', () => {
    createThirdParty({
      presetId: 'zhipu-glm-cn',
      models: [
        { id: 'glm-5.3-flash[1m]', effort: 'high' },
        { id: 'glm-5.3', hidden: true },
        { id: 'glm-5.2', hidden: true },
      ],
    });
    const stored = readFile().providers[0];
    expect(stored.models).toEqual([
      { id: 'glm-5.3-flash[1m]', effort: 'high' },
      { id: 'glm-5.3' },
      { id: 'glm-5.2', hidden: true },
    ]);
    expect(stored.presetId).toBe('zhipu-glm-cn');

    createThirdParty({
      anthropicModel: 'glm-5.1',
      models: [{ id: 'glm-5.2' }],
    });
    expect(readFile().providers[1].models).toEqual([
      { id: 'glm-5.1' },
      { id: 'glm-5.2' },
    ]);
  });

  test('a default model Claude Code cannot take is refused', () => {
    expect(() => createThirdParty({ anthropicModel: 'glm 5.3' })).toThrow(
      '模型名无效',
    );
  });

  test('reading drops what this release cannot vouch for', () => {
    createThirdParty();
    const file = readFile();
    file.providers[0].models = [
      'glm-5.3',
      { id: 'has space' },
      { id: 'glm-5.2', hidden: true, effort: 'turbo', extra: 1 },
      { id: 'glm-5.2' },
      42,
    ];
    file.providers[0].presetId = 'no-such-preset';
    file.providers[0].lastTest = { ...PASSED, ok: 'yes' };
    writeFile(file);

    const [provider] = runtimeConfig.getProviders();
    expect(provider.models).toEqual([
      { id: 'glm-5.3' },
      { id: 'glm-5.2', hidden: true },
    ]);
    expect(provider.presetId).toBeUndefined();
    expect(provider.lastTest).toBeUndefined();

    file.providers[0].models = { not: 'a list' };
    // A failure code a newer release added reads as UNKNOWN.
    file.providers[0].lastTest = {
      ...PASSED,
      ok: false,
      code: 'SOMETHING_NEW',
      status: 418,
    };
    writeFile(file);
    const [reread] = runtimeConfig.getProviders();
    expect(reread.models).toBeUndefined();
    expect(reread.lastTest).toEqual({
      ...PASSED,
      ok: false,
      code: 'UNKNOWN',
      status: 418,
    });
  });

  test('the new fields sit beside the old ones, which an older release reads unchanged', () => {
    const created = createThirdParty({
      presetId: 'zhipu-glm-cn',
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    runtimeConfig.recordProviderTest(created.id, created, PASSED);
    const withFields = readFile();
    expect(withFields.version).toBe(5);

    // What an older release keeps: everything but the fields it ignores.
    const stripped = structuredClone(withFields);
    for (const provider of stripped.providers) {
      delete provider.models;
      delete provider.presetId;
      delete provider.lastTest;
    }
    writeFile(stripped);
    const [old] = runtimeConfig.getProviders();
    writeFile(withFields);
    const [current] = runtimeConfig.getProviders();

    const { models, presetId, lastTest, ...rest } = current;
    expect(models).toHaveLength(2);
    expect(presetId).toBe('zhipu-glm-cn');
    expect(lastTest).toEqual(PASSED);
    expect(old).toEqual(rest);
    expect(old.anthropicAuthToken).toBe('glm-secret-123456');
  });

  test('ChatGPT subscriptions keep no list or preset: their catalog is the list', () => {
    const provider = runtimeConfig.createProvider({
      name: 'ChatGPT',
      type: 'third_party',
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: 'gateway-identifier-123456',
      anthropicModel: 'gpt-5.5',
      codexOAuthCredentials: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        accountId: 'acct',
        planType: 'pro',
        email: null,
      },
      models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }],
      presetId: 'deepseek',
    });
    expect(provider.models).toBeUndefined();
    expect(provider.presetId).toBeUndefined();
    expect(readFile().providers[0]).not.toHaveProperty('models');
    expect(runtimeConfig.toPublicProvider(provider).models).toEqual([]);
  });
});

describe('editing a list', () => {
  test('a new default joins the list instead of replacing the old one', () => {
    const { id } = createThirdParty();
    const updated = runtimeConfig.updateProvider(id, {
      anthropicModel: 'glm-5.2',
    });
    expect(updated.models).toEqual([{ id: 'glm-5.2' }, { id: 'glm-5.3' }]);

    // Back to the old default: the list stays as it is.
    expect(
      runtimeConfig.updateProvider(id, { anthropicModel: 'glm-5.3' }).models,
    ).toEqual([{ id: 'glm-5.2' }, { id: 'glm-5.3' }]);
  });

  test('a new list replaces the old one; the default is shown even if sent hidden', () => {
    const { id } = createThirdParty({
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    const updated = runtimeConfig.updateProvider(id, {
      models: [
        { id: 'glm-5.3', hidden: true, effort: 'low' },
        { id: 'glm-5.1' },
      ],
    });
    expect(updated.models).toEqual([
      { id: 'glm-5.3', effort: 'low' },
      { id: 'glm-5.1' },
    ]);
    // A list without the default gets it back in front.
    expect(
      runtimeConfig.updateProvider(id, { models: [{ id: 'glm-5.1' }] }).models,
    ).toEqual([{ id: 'glm-5.3' }, { id: 'glm-5.1' }]);
    expect(
      runtimeConfig.updateProvider(id, { name: 'Renamed' }).models,
    ).toEqual([{ id: 'glm-5.3' }, { id: 'glm-5.1' }]);
  });

  test('presetId can be set, kept, cleared, and an unknown one is not kept', () => {
    const { id } = createThirdParty({ presetId: 'zhipu-glm-cn' });
    expect(runtimeConfig.updateProvider(id, { name: 'x' }).presetId).toBe(
      'zhipu-glm-cn',
    );
    expect(
      runtimeConfig.updateProvider(id, { presetId: null }).presetId,
    ).toBeUndefined();
    expect(
      runtimeConfig.updateProvider(id, { presetId: 'no-such' }).presetId,
    ).toBeUndefined();
    expect(readFile().providers[0]).not.toHaveProperty('presetId');
  });
});

describe('the last connection test', () => {
  test('is kept with the connection, with the auth header style it found', () => {
    const created = createThirdParty();
    const before = readFile().providers[0].updatedAt;
    const recorded = runtimeConfig.recordProviderTest(
      created.id,
      created,
      PASSED,
      'x-api-key',
    );
    expect(recorded).toMatchObject({
      lastTest: PASSED,
      anthropicAuthMode: 'x-api-key',
    });
    const stored = readFile().providers[0];
    expect(stored.lastTest).toEqual(PASSED);
    expect(stored.updatedAt).toBe(before);

    // A connection that has a style keeps it.
    const second = runtimeConfig.getProviderById(created.id)!;
    runtimeConfig.recordProviderTest(created.id, second, PASSED, 'bearer');
    expect(runtimeConfig.getProviderById(created.id)?.anthropicAuthMode).toBe(
      'x-api-key',
    );
  });

  test('is not written when the connection changed while the test ran', () => {
    const created = createThirdParty();
    runtimeConfig.updateProviderSecrets(created.id, {
      anthropicAuthToken: 'glm-other-654321',
    });
    expect(
      runtimeConfig.recordProviderTest(created.id, created, PASSED),
    ).toBeNull();
    expect(runtimeConfig.getProviderById(created.id)?.lastTest).toBeUndefined();
  });

  test('stops vouching once the endpoint, header or key changes', () => {
    const created = createThirdParty();
    const test = () =>
      runtimeConfig.recordProviderTest(
        created.id,
        runtimeConfig.getProviderById(created.id)!,
        PASSED,
      );

    test();
    expect(
      runtimeConfig.updateProvider(created.id, {
        name: 'Renamed',
        models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
        anthropicModel: 'glm-5.2',
      }).lastTest,
    ).toEqual(PASSED);

    expect(
      runtimeConfig.updateProvider(created.id, {
        anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
      }).lastTest,
    ).toBeUndefined();

    test();
    expect(
      runtimeConfig.updateProvider(created.id, { anthropicAuthMode: 'bearer' })
        .lastTest,
    ).toBeUndefined();

    test();
    expect(
      runtimeConfig.updateProviderSecrets(created.id, {
        anthropicAuthToken: 'glm-new-secret-999',
      }).lastTest,
    ).toBeUndefined();
    expect(readFile().providers[0]).not.toHaveProperty('lastTest');
  });
});
