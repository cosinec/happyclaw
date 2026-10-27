// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { UnifiedProviderPublic } from './types';
import { button, click, flush, makeProvider, text, type } from './test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
  },
}));
vi.mock('../../stores/confirm', () => ({ confirmDialog: mocks.confirm }));

const { ConnectionDetailDialog } = await import('./ConnectionDetailDialog');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDERS = '/api/config/claude/providers';

let root: Root;
let container: HTMLDivElement;
const onChanged = vi.fn();
const setNotice = vi.fn();
const setError = vi.fn();

/** GET answers: the impact count, else the catalog request fails (offline). */
function answerGets(stoppedRunners = 2) {
  mocks.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/impact')) return { activeRunners: 1, stoppedRunners };
    throw new Error('offline');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  answerGets();
  mocks.confirm.mockResolvedValue(true);
  mocks.patch.mockImplementation(async (_path: string, body: object) => ({
    provider: { ...current, ...body, updatedAt: 'later' },
  }));
  mocks.put.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

let current: UnifiedProviderPublic;

async function render(provider: UnifiedProviderPublic) {
  current = provider;
  await act(async () => {
    root.render(
      <ConnectionDetailDialog
        provider={provider}
        onClose={() => {}}
        onChanged={onChanged}
        setNotice={setNotice}
        setError={setError}
      />,
    );
  });
  await flush();
}

const officialProvider = makeProvider({
  id: 'claude',
  name: 'Claude 官方',
  type: 'official',
  anthropicBaseUrl: '',
  anthropicModel: '',
  anthropicAuthMode: null,
  hasAnthropicAuthToken: false,
  anthropicAuthTokenMasked: null,
  hasClaudeOAuthCredentials: true,
  claudeOAuthCredentialsExpiresAt: Date.now() - 1000,
  claudeOAuthCredentialsAccessTokenMasked: 'sk-a***',
  claudeAuthKind: 'oauth',
  claudeOAuthAccountEmail: 'owner@example.com',
  claudeOAuthSubscriptionType: 'max',
  claudeOAuthNeedsReLogin: true,
  claudeOAuthLastRefreshError: {
    kind: 'invalid_grant',
    message: 'Refresh token was revoked',
    at: 1,
  },
  models: [{ id: 'opus' }, { id: 'sonnet' }],
});

const codexProvider = makeProvider({
  id: 'chatgpt',
  name: 'ChatGPT 订阅',
  anthropicBaseUrl: '__codex_gateway__',
  anthropicModel: 'gpt-6-sol',
  anthropicAuthMode: null,
  hasCodexOAuthCredentials: true,
  codexOAuthCredentialsExpiresAt: Date.now() + 3_600_000,
  codexOAuthCredentialsEmail: 'owner@example.com',
  codexOAuthCredentialsPlanType: 'pro',
  codexOAuthNeedsReauth: true,
  codexOAuthLastRefreshError: {
    kind: 'reauth_required',
    message: 'refresh_token_reused',
    at: '2026-10-11T00:00:00.000Z',
  },
  codexDefaultEffort: 'high',
  models: [],
});

const legacyProvider = makeProvider({
  id: 'glm',
  name: 'GLM',
  anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  anthropicModel: 'glm-5.3',
  anthropicAuthMode: null,
  anthropicAuthTokenMasked: 'glm-***',
  models: [{ id: 'glm-5.3' }, { id: 'glm-5.2', hidden: true }],
});

function select(selector: string): HTMLSelectElement {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`${selector} not found`);
  return element as HTMLSelectElement;
}

async function choose(selector: string, value: string) {
  await act(async () => {
    const element = select(selector);
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function openMenu(label: string) {
  const trigger = document.querySelector(`button[aria-label="${label}"]`);
  if (!trigger) throw new Error(`menu "${label}" not found`);
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

async function menuItem(label: string) {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!item) throw new Error(`menu item "${label}" not found`);
  await click(item);
  await flush();
}

describe('Claude subscription', () => {
  test('shows the account and a needed re-login', async () => {
    await render(officialProvider);
    expect(text()).toContain('授权已失效，需要重新登录 Claude');
    expect(text()).toContain('Refresh token was revoked');
    expect(text()).toContain('owner@example.com（max）');
    expect(text()).toContain('需重新登录');
  });

  test('a pasted credential is sent raw for the server to parse, after confirming', async () => {
    await render(officialProvider);
    await type(
      '#connection-secret',
      '  {"claudeAiOauth":{"accessToken":"a"}}  ',
    );
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith(
      `${PROVIDERS}/claude/secrets`,
      { claudeCredentialInput: '{"claudeAiOauth":{"accessToken":"a"}}' },
      120_000,
    );
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  test('the setup-token login asks the server for that profile', async () => {
    mocks.post.mockResolvedValue({
      authorizeUrl: 'https://x.test',
      state: 's',
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await render(officialProvider);
    await click(button('改为获取 1 年期 Setup Token'));
    expect(mocks.post).toHaveBeenCalledWith('/api/config/claude/oauth/start', {
      targetProviderId: 'claude',
      profile: 'setup_token',
    });
    expect(open).toHaveBeenCalledWith(
      'https://x.test',
      '_blank',
      'noopener,noreferrer',
    );
  });

  test('the test button runs an account check and reloads the status', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      probes: [],
      code: null,
      record: {
        ok: true,
        code: null,
        status: 200,
        model: null,
        latencyMs: 80,
        at: '2026-10-28T00:00:00.000Z',
      },
    });
    await render(officialProvider);
    expect(text()).toContain('不消耗额度');
    await click(button('测试连接'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      `${PROVIDERS}/test`,
      { providerId: 'claude' },
      60_000,
    );
    expect(text()).toContain('连接成功');
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('ChatGPT subscription', () => {
  test('flags a refused refresh and keeps the effective default effort', async () => {
    await render(codexProvider);
    // The account's own plan-filtered catalog, not the global one.
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/config/codex/model-catalog?providerId=chatgpt',
    );
    expect(text()).toContain('ChatGPT 授权已失效，请重新登录');
    expect(text()).toContain('refresh_token_reused');
    expect(select('#codex-effort-select').value).toBe('high');
    // Nothing changed yet: nothing to save.
    expect(button('保存默认模型').disabled).toBe(true);

    await choose('#codex-effort-select', 'medium');
    await click(button('保存默认模型'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/chatgpt`,
      { customEnv: { CODEX_REASONING_EFFORT: 'medium' } },
      120_000,
    );
  });

  test('the offline catalog marks the same default effort as the server', async () => {
    await render({
      ...codexProvider,
      anthropicModel: 'gpt-6-astra',
      codexOAuthNeedsReauth: false,
      codexOAuthLastRefreshError: null,
      codexDefaultEffort: undefined,
    });
    const effort = select('#codex-effort-select');
    // No stored or resolved effort: the catalog default (gpt-6.1-sol's) applies.
    expect(effort.value).toBe('low');
    expect(
      [...effort.options].find((option) => option.text.endsWith('（默认）'))
        ?.value,
    ).toBe('low');
    expect(
      [...select('#codex-model-select').options]
        .slice(0, 3)
        .map((option) => option.value),
    ).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol']);
  });

  test('a spent code sends the user back to log in again', async () => {
    mocks.post
      .mockResolvedValueOnce({ authorizeUrl: 'https://x.test', state: 's' })
      .mockRejectedValueOnce({
        status: 400,
        message: '授权码已失效',
        body: { retryable: false },
      });
    vi.spyOn(window, 'open').mockReturnValue(null);
    await render(codexProvider);
    await click(button('重新登录 ChatGPT'));
    await type(
      'input[aria-label^="粘贴 localhost:1455"]',
      'http://localhost:1455/auth/callback?code=c&state=s',
    );
    await click(button('确认'));
    await flush();
    expect(text()).toContain('授权码已失效');
    expect(button('重新登录 ChatGPT')).toBeTruthy();
  });
});

describe('third-party connection settings', () => {
  test('a new key is saved in one PATCH and a legacy auth mode is kept', async () => {
    await render(legacyProvider);
    await type('#connection-secret', 'glm-new-key');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicAuthToken: 'glm-new-key' },
      120_000,
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('the confirmation states the runners it stops and that history is kept', async () => {
    await render(legacyProvider);
    await type('#connection-base-url', 'https://open.bigmodel.cn/api/paas');
    await click(button('保存连接设置'));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(`${PROVIDERS}/glm/impact`);
    const message = mocks.confirm.mock.calls[0][0].message as string;
    expect(message).toContain('保存会停止 2 个运行中的会话');
    expect(message).toContain('下一条消息会开启新的 SDK 会话，聊天记录保留');
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicBaseUrl: 'https://open.bigmodel.cn/api/paas' },
      120_000,
    );
  });

  test('with nothing to stop the confirmation skips the count; declining saves nothing', async () => {
    answerGets(0);
    mocks.confirm.mockResolvedValue(false);
    await render(legacyProvider);
    await type('#connection-secret', 'k');
    await click(button('保存连接设置'));
    await flush();
    const message = mocks.confirm.mock.calls[0][0].message as string;
    expect(message).not.toContain('停止');
    expect(message).toContain('聊天记录保留');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  test('a preset connection keeps its address read-only', async () => {
    await render(
      makeProvider({
        presetId: 'deepseek',
        anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      }),
    );
    const url = document.querySelector(
      '#connection-base-url',
    ) as HTMLInputElement;
    expect(url.readOnly).toBe(true);
    expect(text()).toContain('「DeepSeek」预设的地址');
  });

  test('a passed test on a legacy connection offers to keep the header it found', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      probes: [{ model: 'glm-5.3', ok: true, status: 200, latencyMs: 90 }],
      code: null,
      authMode: 'x-api-key',
    });
    await render(legacyProvider);
    await click(button('测试连接'));
    await flush();
    expect(text()).toContain('服务商接受 x-api-key 认证');
    await click(button('保存认证方式'));
    await flush();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { anthropicAuthMode: 'x-api-key' },
      120_000,
    );
  });
});

describe('model list', () => {
  test('showing a model saves the list at once without asking', async () => {
    await render(legacyProvider);
    const toggle = document.querySelector(
      '[role="switch"][aria-label="在聊天中显示 glm-5.2"]',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    // The default model is always shown.
    expect(
      document
        .querySelector('[role="switch"][aria-label="在聊天中显示 glm-5.3"]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
    await click(toggle);
    await flush();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      { models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }] },
      120_000,
    );
  });

  test('an effort is saved per model', async () => {
    await render(legacyProvider);
    await choose('select[aria-label="glm-5.2 的推理档位"]', 'high');
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', hidden: true, effort: 'high' },
        ],
      },
      120_000,
    );
  });

  test('a new default model is a protocol change and asks first', async () => {
    await render(legacyProvider);
    await openMenu('glm-5.2 的更多操作');
    await menuItem('设为默认模型');
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
        anthropicModel: 'glm-5.2',
      },
      120_000,
    );
  });

  test('turning on 1M renames the model, and the default with it', async () => {
    await render(legacyProvider);
    await click(
      document.querySelector('[aria-label="glm-5.3 使用 1M 上下文"]'),
    );
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [{ id: 'glm-5.3[1m]' }, { id: 'glm-5.2', hidden: true }],
        anthropicModel: 'glm-5.3[1m]',
      },
      120_000,
    );
  });

  test('removing a model an Agent uses names the Agent and keeps the model', async () => {
    mocks.patch.mockRejectedValue({
      status: 409,
      message: 'model in use',
      body: {
        code: 'MODEL_IN_USE',
        agents: [{ id: 'a1', name: '写作助手' }],
      },
    });
    await render(legacyProvider);
    await openMenu('glm-5.2 的更多操作');
    await menuItem('从连接中删除');
    expect(setError).toHaveBeenCalledWith(
      expect.stringContaining('智能体「写作助手」'),
    );
    expect(text()).toContain('glm-5.2');
  });

  test('refreshing only adds the new models, hidden', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      source: 'endpoint',
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.4' }],
    });
    await render(legacyProvider);
    await click(button('刷新模型列表'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      `${PROVIDERS}/discover-models`,
      { providerId: 'glm' },
      45_000,
    );
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', hidden: true },
          { id: 'glm-5.4', hidden: true },
        ],
      },
      120_000,
    );
    expect(setNotice).toHaveBeenCalledWith(
      expect.stringContaining('新增 1 个'),
    );
  });

  test('a model already listed with or without [1m] is not added twice', async () => {
    await render(legacyProvider);
    await type('input[aria-label="手动添加模型"]', 'glm-5.2[1m]');
    await click(button('添加'));
    await flush();
    expect(setError).toHaveBeenCalledWith('列表里已经有 glm-5.2');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  test('a manual model is added visible', async () => {
    await render(legacyProvider);
    await type('input[aria-label="手动添加模型"]', 'glm-6');
    await click(button('添加'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/glm`,
      {
        models: [
          { id: 'glm-5.3' },
          { id: 'glm-5.2', hidden: true },
          { id: 'glm-6' },
        ],
      },
      120_000,
    );
  });
});
