// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  button,
  click,
  findButton,
  flush,
  makeProvider,
  text,
  type,
} from './test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
  },
}));

const { AddModelWizard } = await import('./AddModelWizard');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROVIDERS = '/api/config/claude/providers';
const DISCOVER = `${PROVIDERS}/discover-models`;
const TEST = `${PROVIDERS}/test`;

let root: Root;
let container: HTMLDivElement;
const onDone = vi.fn();
const onConnectionCreated = vi.fn();

/** Answers by path; a value may be a function of the body. */
function answer(routes: Record<string, unknown>) {
  mocks.post.mockImplementation(async (path: string, body: unknown) => {
    const route = routes[path];
    if (route === undefined) throw new Error(`unexpected POST ${path}`);
    return typeof route === 'function' ? route(body) : route;
  });
}

const OK_TEST = {
  ok: true,
  probes: [{ model: 'm', ok: true, status: 200, latencyMs: 321 }],
  code: null,
  authMode: 'bearer',
};

function failedTest(code: string, status: number, message = 'refused') {
  return {
    ok: false,
    probes: [{ model: 'm', ok: false, status, latencyMs: 50, message }],
    code,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockRejectedValue(new Error('offline'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(enabledCount = 1) {
  await act(async () => {
    root.render(
      <AddModelWizard
        enabledCount={enabledCount}
        onDone={onDone}
        onConnectionCreated={onConnectionCreated}
        onCancel={() => {}}
        layout="page"
      />,
    );
  });
}

function buttonContaining(fragment: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(fragment),
  );
  if (!match) throw new Error(`button containing "${fragment}" not found`);
  return match;
}

function checkbox(id: string): HTMLElement | null {
  return document.querySelector(`[role="checkbox"][aria-label="使用 ${id}"]`);
}

const field = (selector: string) =>
  document.querySelector(selector) as HTMLInputElement | null;

async function next() {
  await click(button('下一步'));
  await flush();
}

describe('vendor preset', () => {
  test('checks the preset models, leaves discovered extras unchecked and saves what the test found', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        authMode: 'bearer',
        models: [
          { id: 'deepseek-flash' },
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-chat' },
        ],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new', name: 'DeepSeek' }),
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));

    // The address is the preset's and cannot be edited.
    expect(field('#wizard-preset-url')?.value).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(field('#wizard-preset-url')?.readOnly).toBe(true);
    expect(findButton('下一步')?.disabled).toBe(true);
    await type('#wizard-api-key', 'sk-ds');
    await next();

    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      {
        type: 'third_party',
        presetId: 'deepseek',
        anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
        anthropicAuthToken: 'sk-ds',
      },
      30_000,
    );
    expect(checkbox('deepseek-flash[1m]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(checkbox('deepseek-v4-pro[1m]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(checkbox('deepseek-chat')?.getAttribute('aria-checked')).toBe(
      'false',
    );

    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      {
        type: 'third_party',
        presetId: 'deepseek',
        anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
        anthropicAuthToken: 'sk-ds',
        anthropicModel: 'deepseek-flash[1m]',
        customEnv: {},
      },
      60_000,
    );
    expect(text()).toContain('连接成功');
    // Another connection is enabled: the new one stays out of the pool.
    expect(
      document.querySelector('#wizard-pool')?.getAttribute('aria-checked'),
    ).toBe('false');
    expect(text()).toContain('已有启用的连接，默认不加入');

    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(PROVIDERS, {
      name: 'DeepSeek',
      type: 'third_party',
      presetId: 'deepseek',
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      anthropicAuthToken: 'sk-ds',
      anthropicModel: 'deepseek-flash[1m]',
      models: [{ id: 'deepseek-flash[1m]' }, { id: 'deepseek-v4-pro[1m]' }],
      customEnv: {},
      enabled: false,
      anthropicAuthMode: 'bearer',
    });
    // The saved connection is tested once more so its status is stored.
    expect(mocks.post).toHaveBeenLastCalledWith(
      TEST,
      { providerId: 'new' },
      60_000,
    );
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new' }),
      true,
    );
  });

  test('a failed discovery says why and still finishes with the preset models', async () => {
    answer({
      [DISCOVER]: {
        ok: false,
        code: 'AUTH_FORBIDDEN',
        status: 403,
        message: 'plan does not include models API',
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk-ds');
    await next();
    expect(text()).toContain('没能获取模型列表：没有访问权限');
    expect(text()).toContain('仍可使用下方的模型或手动添加');
    expect(text()).toContain('plan does not include models API');
    expect(checkbox('deepseek-flash[1m]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      PROVIDERS,
      expect.objectContaining({
        models: [{ id: 'deepseek-flash[1m]' }, { id: 'deepseek-v4-pro[1m]' }],
      }),
    );
  });
});

describe('custom address', () => {
  test('suggests a preset after typing stops, never switches by itself, keeps the draft', async () => {
    vi.useFakeTimers();
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://API.deepseek.com/anthropic/');
    await type('#wizard-api-key', 'sk-kept');
    expect(text()).not.toContain('看起来是');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(text()).toContain('看起来是「DeepSeek」');
    // Still the custom form.
    expect(field('#wizard-base-url')).not.toBeNull();

    await click(button('按预设配置'));
    expect(field('#wizard-preset-url')?.value).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(field('#wizard-api-key')?.value).toBe('sk-kept');
  });

  test('继续自定义 dismisses the suggestion for that address', async () => {
    vi.useFakeTimers();
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://api.moonshot.cn/anthropic');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await click(button('继续自定义'));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(text()).not.toContain('看起来是');
    expect(field('#wizard-base-url')?.value).toBe(
      'https://api.moonshot.cn/anthropic',
    );
  });

  test('an address shared by two presets suggests nothing', async () => {
    vi.useFakeTimers();
    await render();
    await click(buttonContaining('自定义兼容地址'));
    // 智谱 GLM and its Coding Plan share this endpoint.
    await type('#wizard-base-url', 'https://open.bigmodel.cn/api/anthropic');
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(text()).not.toContain('看起来是');
  });

  test('a pasted alias fills the draft and saves its model and environment', async () => {
    answer({
      [DISCOVER]: {
        ok: false,
        code: 'ENDPOINT_NOT_FOUND',
        status: 404,
        message: '',
      },
      // No header reported: the alias's own one is kept.
      [TEST]: { ...OK_TEST, authMode: undefined },
      [PROVIDERS]: makeProvider({ id: 'dcc', name: 'dcc' }),
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type(
      'textarea[aria-label="粘贴 alias 或环境变量"]',
      'alias dcc="CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432 ANTHROPIC_BASE_URL=https://relay.example.test/anthropic ANTHROPIC_AUTH_TOKEN=sk-fake ANTHROPIC_MODEL=deepseek-v4-pro[1m] ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash[1m] claude"',
    );
    await click(button('解析'));
    await click(button('填入表单'));
    expect(field('#wizard-base-url')?.value).toBe(
      'https://relay.example.test/anthropic',
    );
    await next();
    expect(text()).toContain('没能获取模型列表：地址不对');
    expect(checkbox('deepseek-v4-pro[1m]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    await next();
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(PROVIDERS, {
      name: 'dcc',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.test/anthropic',
      anthropicAuthToken: 'sk-fake',
      anthropicModel: 'deepseek-v4-pro[1m]',
      models: [{ id: 'deepseek-v4-pro[1m]' }],
      customEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1m]',
      },
      enabled: false,
      anthropicAuthMode: 'bearer',
    });
  });

  test('a model typed with [1m] turns its 1M switch on', async () => {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk');
    await next();
    await type('input[aria-label="手动添加模型"]', 'glm-5.3[1m]');
    await click(button('添加'));
    expect(checkbox('glm-5.3[1m]')?.getAttribute('aria-checked')).toBe('true');
    expect(
      document
        .querySelector('[aria-label="glm-5.3[1m] 使用 1M 上下文"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('test before saving', () => {
  async function reachSave(routes: Record<string, unknown>) {
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [PROVIDERS]: makeProvider({ id: 'new' }),
      ...routes,
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk-bad');
    await next();
    await next();
  }

  test('an invalid key blocks saving until the key changes', async () => {
    await reachSave({
      [TEST]: failedTest('AUTH_INVALID', 401, 'invalid x-api-key'),
    });
    expect(text()).toContain('密钥无效');
    expect(text()).toContain('密钥无效时不能保存');
    expect(button('保存').disabled).toBe(true);
    await click(button('保存'));
    expect(mocks.post).not.toHaveBeenCalledWith(PROVIDERS, expect.anything());

    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'new' }),
    });
    await click(button('上一步'));
    await click(button('上一步'));
    await type('#wizard-api-key', 'sk-good');
    await next();
    await next();
    expect(button('保存').disabled).toBe(false);
  });

  test('another failure may still be saved, as unverified', async () => {
    await reachSave({ [TEST]: failedTest('RATE_LIMITED', 429) });
    expect(text()).toContain('请求过于频繁');
    await click(button('仍然保存（未验证）'));
    await flush();
    expect(onDone).toHaveBeenCalledWith(expect.anything(), false);
  });

  test('going back and forth without changes does not test again', async () => {
    await reachSave({ [TEST]: OK_TEST });
    await click(button('上一步'));
    await next();
    const tests = mocks.post.mock.calls.filter(([path]) => path === TEST);
    expect(tests).toHaveLength(1);
  });
});

describe('late answers', () => {
  test('a model list for an older key is dropped', async () => {
    let answerFirst!: (value: unknown) => void;
    mocks.post.mockImplementation(async (path: string, body: unknown) => {
      if (path !== DISCOVER) throw new Error(path);
      if (
        (body as { anthropicAuthToken: string }).anthropicAuthToken === 'sk-a'
      ) {
        return new Promise((resolve) => {
          answerFirst = resolve;
        });
      }
      return { ok: true, source: 'endpoint', models: [{ id: 'model-b' }] };
    });
    await render();
    await click(buttonContaining('自定义兼容地址'));
    await type('#wizard-base-url', 'https://relay.example.test');
    await type('#wizard-api-key', 'sk-a');
    await next();
    await click(button('上一步'));
    await type('#wizard-api-key', 'sk-b');
    await next();
    expect(checkbox('model-b')).not.toBeNull();
    await act(async () => {
      answerFirst({
        ok: true,
        source: 'endpoint',
        models: [{ id: 'model-a' }],
      });
    });
    await flush();
    expect(checkbox('model-a')).toBeNull();
    expect(text()).toContain('获取到 1 个模型');
  });

  test('a test result for an older default model is dropped', async () => {
    let answerFirst!: (value: unknown) => void;
    let tests = 0;
    answer({
      [DISCOVER]: { ok: true, source: 'endpoint', models: [] },
      [TEST]: () => {
        tests += 1;
        return tests === 1
          ? new Promise((resolve) => {
              answerFirst = resolve;
            })
          : OK_TEST;
      },
    });
    await render();
    await click(buttonContaining('api.deepseek.com'));
    await type('#wizard-api-key', 'sk');
    await next();
    await next();
    await click(button('上一步'));
    await click(
      document.querySelector(
        '[aria-label="把 deepseek-v4-pro[1m] 设为默认模型"]',
      ),
    );
    await next();
    expect(text()).toContain('连接成功');
    await act(async () => {
      answerFirst(failedTest('AUTH_INVALID', 401));
    });
    await flush();
    expect(text()).toContain('连接成功');
    expect(text()).not.toContain('密钥无效');
  });
});

describe('official kinds', () => {
  test('an Anthropic API key lists models unchecked and honors the pool switch', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'endpoint',
        models: [{ id: 'claude-opus-4-7', name: 'Claude Opus 4.7' }],
      },
      [TEST]: OK_TEST,
      [PROVIDERS]: makeProvider({ id: 'api', type: 'official' }),
    });
    await render(0);
    await click(buttonContaining('Anthropic API Key'));
    await type('#wizard-api-key', 'sk-ant-1');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      { type: 'official', anthropicApiKey: 'sk-ant-1' },
      30_000,
    );
    expect(checkbox('claude-opus-4-7')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(text()).toContain('不指定（由 Claude Code 选择）');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      { type: 'official', anthropicApiKey: 'sk-ant-1', anthropicModel: '' },
      60_000,
    );
    // Nothing else is enabled: like the server, it joins the pool.
    const pool = document.querySelector('#wizard-pool') as HTMLElement;
    expect(pool.getAttribute('aria-checked')).toBe('true');
    expect(text()).toContain('目前没有其他启用的连接，默认加入');
    await click(pool);
    await click(button('保存'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(PROVIDERS, {
      name: 'Anthropic API Key',
      type: 'official',
      anthropicApiKey: 'sk-ant-1',
      anthropicModel: '',
      models: [],
      enabled: false,
    });
  });

  test('a pasted setup-token is checked before saving and an invalid one blocks', async () => {
    answer({
      [DISCOVER]: {
        ok: true,
        source: 'builtin',
        models: [{ id: 'opus' }, { id: 'sonnet' }],
      },
      [TEST]: failedTest('AUTH_INVALID', 401),
    });
    await render();
    await click(buttonContaining('Claude 订阅'));
    await type('#wizard-claude-credential', ' sk-ant-oat01-x ');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      { type: 'official', claudeCredentialInput: 'sk-ant-oat01-x' },
      30_000,
    );
    // Built-in aliases are what a subscription runs: offered checked.
    expect(checkbox('opus')?.getAttribute('aria-checked')).toBe('true');
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      {
        type: 'official',
        claudeCredentialInput: 'sk-ant-oat01-x',
        anthropicModel: '',
      },
      60_000,
    );
    expect(button('保存').disabled).toBe(true);
  });

  test('a Claude login creates the connection, then the wizard updates it', async () => {
    const created = makeProvider({
      id: 'claude-new',
      name: '官方 Claude (a@example.com)',
      type: 'official',
      anthropicBaseUrl: '',
      anthropicModel: '',
      models: [],
      hasAnthropicAuthToken: false,
      hasClaudeOAuthCredentials: true,
      claudeAuthKind: 'oauth',
      claudeOAuthAccountEmail: 'a@example.com',
    });
    answer({
      '/api/config/claude/oauth/start': {
        authorizeUrl: 'https://claude.test/auth',
        state: 's1',
      },
      '/api/config/claude/oauth/callback': created,
      [DISCOVER]: {
        ok: true,
        source: 'builtin',
        models: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }],
      },
      [TEST]: { ...OK_TEST, authMode: undefined },
    });
    mocks.patch.mockResolvedValue({ provider: created });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await render();
    await click(buttonContaining('Claude 订阅'));
    await click(button('登录 Claude'));
    expect(open).toHaveBeenCalledWith(
      'https://claude.test/auth',
      '_blank',
      'noopener,noreferrer',
    );
    await type('input[aria-label="粘贴授权码"]', 'code#s1');
    await click(button('确认'));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/config/claude/oauth/callback',
      { state: 's1', code: 'code#s1' },
      60_000,
    );
    expect(onConnectionCreated).toHaveBeenCalledWith(created);
    expect(mocks.post).toHaveBeenCalledWith(
      DISCOVER,
      { providerId: 'claude-new' },
      30_000,
    );
    await next();
    expect(mocks.post).toHaveBeenCalledWith(
      TEST,
      { providerId: 'claude-new' },
      60_000,
    );
    // The saved connection is tested by id: a new default is no reason to
    // send the same check again.
    await click(button('上一步'));
    await click(document.querySelector('[aria-label="把 opus 设为默认模型"]'));
    await next();
    expect(
      mocks.post.mock.calls.filter(([path]) => path === TEST),
    ).toHaveLength(1);
    await click(button('保存'));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/claude-new`,
      {
        models: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }],
        anthropicModel: 'opus',
      },
      120_000,
    );
    expect(mocks.post).not.toHaveBeenCalledWith(PROVIDERS, expect.anything());
    expect(onDone).toHaveBeenCalledWith(created, true);
  });

  test('a ChatGPT login picks its default model from the account catalog', async () => {
    const created = makeProvider({
      id: 'gpt',
      name: 'ChatGPT 订阅',
      anthropicModel: 'gpt-6.1-sol',
      models: [],
      hasCodexOAuthCredentials: true,
      codexDefaultEffort: 'low',
    });
    answer({
      '/api/config/codex/oauth/start': {
        authorizeUrl: 'https://auth.openai.test',
        state: 's2',
      },
      '/api/config/codex/oauth/callback': created,
      [TEST]: { ...OK_TEST, authMode: undefined },
    });
    mocks.get.mockResolvedValue({
      models: [
        {
          value: 'gpt-6.1-sol',
          label: 'gpt-6.1-sol',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'low',
        },
        {
          value: 'gpt-6-astra',
          label: 'gpt-6-astra',
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
      defaultModel: 'gpt-6.1-sol',
      defaultEffort: 'low',
    });
    mocks.patch.mockResolvedValue({ provider: created });
    vi.spyOn(window, 'open').mockReturnValue(null);
    await render();
    await click(buttonContaining('ChatGPT 订阅'));
    await click(button('登录 ChatGPT'));
    await type(
      'input[aria-label="粘贴 localhost:1455 回调完整地址"]',
      'http://localhost:1455/auth/callback?code=c&state=s2',
    );
    await click(button('确认'));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/config/codex/model-catalog?providerId=gpt',
    );
    const select = field('#codex-model-select') as unknown as HTMLSelectElement;
    expect(select.value).toBe('gpt-6.1-sol');
    await act(async () => {
      select.value = 'gpt-6-astra';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await next();
    await click(button('保存'));
    await flush();
    // The effort it had is offered by the new model, so only the model changes.
    expect(mocks.patch).toHaveBeenCalledWith(
      `${PROVIDERS}/gpt`,
      { anthropicModel: 'gpt-6-astra' },
      120_000,
    );
  });
});
