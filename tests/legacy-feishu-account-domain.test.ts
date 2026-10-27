import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-feishu-domain-'));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { loadChannelAccountSecret } =
  await import('../src/channel-account-secrets.js');
const { syncLegacyFeishuDefaultAccount } =
  await import('../src/legacy-default-account-sync.js');

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['lark-user', 'feishu-user']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'test',
      display_name: id,
      role: 'member',
      status: 'active',
      permissions: [],
      created_at: now,
      updated_at: now,
    });
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function secretOf(userId: string) {
  const account = db.getLegacyChannelAccount(userId, 'feishu');
  expect(account).toBeTruthy();
  return loadChannelAccountSecret(account!.secret_ref);
}

describe('legacy Feishu settings keep the default account brand', () => {
  test('a legacy save without a brand keeps a Lark account on Lark', () => {
    syncLegacyFeishuDefaultAccount('lark-user', {
      appId: 'cli_lark',
      appSecret: 'secret-1',
      domain: 'lark',
    });
    expect(secretOf('lark-user')).toMatchObject({
      appId: 'cli_lark',
      domain: 'lark',
    });

    // PUT /api/config/user-im/feishu from a client that predates brands.
    syncLegacyFeishuDefaultAccount('lark-user', {
      appId: 'cli_lark',
      appSecret: 'secret-2',
      ownerOpenId: 'ou_owner',
    });
    expect(secretOf('lark-user')).toMatchObject({
      appId: 'cli_lark',
      appSecret: 'secret-2',
      ownerOpenId: 'ou_owner',
      domain: 'lark',
    });
  });

  test('an explicit brand in the legacy settings wins', () => {
    syncLegacyFeishuDefaultAccount('lark-user', {
      appId: 'cli_lark',
      appSecret: 'secret-3',
      domain: 'feishu',
    });
    expect(secretOf('lark-user')?.domain).toBe('feishu');
  });

  test('an account that never had a brand stays brandless (Feishu)', () => {
    syncLegacyFeishuDefaultAccount('feishu-user', {
      appId: 'cli_feishu',
      appSecret: 'secret',
    });
    expect(secretOf('feishu-user')?.domain).toBeUndefined();
  });

  test('the legacy settings sync goes through the brand-preserving helper', () => {
    const source = fs.readFileSync(
      new URL('../src/index.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf(
      'function syncLegacyConfigToDefaultChannelAccount',
    );
    const end = source.indexOf("if (channel === 'telegram')", start);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).toContain(
      'syncLegacyFeishuDefaultAccount(userId, value)',
    );
  });
});
