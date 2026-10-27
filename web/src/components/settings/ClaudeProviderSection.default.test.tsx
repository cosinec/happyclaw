// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ProviderWithHealth } from './types';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  setNotice: vi.fn(),
  setError: vi.fn(),
  wizard: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    get: mocks.get,
    put: mocks.put,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.del,
  },
}));
// The wizard and the detail have their own tests; record what they are given.
vi.mock('./AddModelWizard', () => ({
  AddModelWizardDialog: (props: unknown) => {
    mocks.wizard(props);
    return null;
  },
}));
vi.mock('./ConnectionDetailDialog', () => ({
  ConnectionDetailDialog: (props: unknown) => {
    mocks.detail(props);
    return null;
  },
}));

const { ClaudeProviderSection } = await import('./ClaudeProviderSection');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
  mocks.del.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function provider(id: string, enabled: boolean): ProviderWithHealth {
  return {
    id,
    name: `配置 ${id}`,
    type: 'third_party',
    enabled,
    weight: 1,
    anthropicBaseUrl: `https://${id}.example.test`,
    anthropicModel: `${id}-model`,
    anthropicAuthMode: 'bearer',
    hasAnthropicAuthToken: true,
    hasAnthropicApiKey: false,
    hasClaudeCodeOauthToken: false,
    hasClaudeOAuthCredentials: false,
    hasCodexOAuthCredentials: false,
    models: [{ id: `${id}-model` }],
    presetId: null,
    lastTest: null,
    health: null,
  } as ProviderWithHealth;
}

function listing(defaultModelConfigId: string | null) {
  return {
    providers: [provider('a', true), provider('b', false)],
    balancing: {
      strategy: 'round-robin',
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    },
    enabledCount: 1,
    defaultModelConfigId,
  };
}

async function render() {
  await act(async () => {
    root?.render(
      <ClaudeProviderSection
        setNotice={mocks.setNotice}
        setError={mocks.setError}
      />,
    );
  });
}

const defaultButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === '默认',
  );

describe('ClaudeProviderSection default model', () => {
  test('choosing a configuration saves it and reloads the badge', async () => {
    mocks.get
      .mockResolvedValueOnce(listing(null))
      .mockResolvedValueOnce(listing('a'));
    mocks.put.mockResolvedValue({ defaultModelConfigId: 'a' });
    await render();

    await act(async () => defaultButtons()[0].click());

    expect(mocks.put).toHaveBeenCalledWith(
      '/api/config/claude/default',
      { modelConfigId: 'a' },
      120_000,
    );
    expect(mocks.setNotice).toHaveBeenCalledWith('已将「配置 a」设为默认模型');
    expect(defaultButtons()[0].getAttribute('aria-pressed')).toBe('true');
  });

  test('choosing a disabled configuration tells that it was switched on', async () => {
    mocks.get
      .mockResolvedValueOnce(listing(null))
      .mockResolvedValueOnce(listing('b'));
    mocks.put.mockResolvedValue({ defaultModelConfigId: 'b' });
    await render();

    await act(async () => defaultButtons()[1].click());

    expect(mocks.setNotice).toHaveBeenCalledWith(
      '已将「配置 b」设为默认模型，并同时启用',
    );
  });

  test('pressing the current default again clears it', async () => {
    mocks.get
      .mockResolvedValueOnce(listing('a'))
      .mockResolvedValueOnce(listing(null));
    mocks.put.mockResolvedValue({ defaultModelConfigId: null });
    await render();
    expect(defaultButtons()[0].getAttribute('aria-pressed')).toBe('true');

    await act(async () => defaultButtons()[0].click());

    expect(mocks.put).toHaveBeenCalledWith(
      '/api/config/claude/default',
      { modelConfigId: null },
      120_000,
    );
    expect(mocks.setNotice).toHaveBeenCalledWith(
      expect.stringContaining('已取消默认模型「配置 a」'),
    );
    expect(defaultButtons()[0].getAttribute('aria-pressed')).toBe('false');
  });

  test('a refused change reports the reason and reloads what is stored', async () => {
    mocks.get
      .mockResolvedValueOnce(listing(null))
      .mockResolvedValueOnce(listing(null));
    mocks.put.mockRejectedValue(new Error('该模型配置还没有可用的凭据'));
    await render();

    await act(async () => defaultButtons()[0].click());

    expect(mocks.setError).toHaveBeenCalledWith('该模型配置还没有可用的凭据');
    expect(mocks.setNotice).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  async function deleteRow(index: number) {
    await act(async () =>
      document
        .querySelectorAll<HTMLButtonElement>('button[aria-label="更多操作"]')
        [
          index
        ].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((node) => node.textContent?.includes('删除'));
    await act(async () => item!.click());
  }

  const confirmText = () => document.body.textContent ?? '';

  test('deleting the default warns first and says afterwards that it was cleared', async () => {
    mocks.get
      .mockResolvedValueOnce(listing('a'))
      .mockResolvedValueOnce(listing(null));
    mocks.del.mockResolvedValue({ ok: true, defaultCleared: true });
    await render();

    await deleteRow(0);
    expect(confirmText()).toContain('确认删除模型配置「配置 a」');
    expect(confirmText()).toContain('它是当前默认模型');
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '确认删除')!
        .click(),
    );

    expect(mocks.del).toHaveBeenCalledWith('/api/config/claude/providers/a');
    expect(mocks.setNotice).toHaveBeenCalledWith(
      expect.stringContaining('它是默认模型'),
    );
  });

  test('deleting another configuration does not mention the default', async () => {
    mocks.get
      .mockResolvedValueOnce(listing('a'))
      .mockResolvedValueOnce(listing('a'));
    mocks.del.mockResolvedValue({ ok: true, defaultCleared: false });
    await render();

    await deleteRow(1);
    expect(confirmText()).toContain('确认删除模型配置「配置 b」');
    expect(confirmText()).not.toContain('它是当前默认模型');
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '确认删除')!
        .click(),
    );

    expect(mocks.setNotice).toHaveBeenCalledWith('已删除模型配置「配置 b」');
  });
});

describe('ClaudeProviderSection connections', () => {
  const lastProps = (mock: typeof mocks.wizard) =>
    mock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

  test('adding opens the wizard with the enabled count, and a saved connection reloads the list', async () => {
    mocks.get.mockResolvedValue(listing(null));
    await render();
    expect(lastProps(mocks.wizard).open).toBe(false);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('添加模型连接'))!
        .click(),
    );
    const props = lastProps(mocks.wizard);
    expect(props.open).toBe(true);
    expect(props.enabledCount).toBe(1);

    mocks.get.mockClear();
    await act(async () =>
      (props.onClose as (result: unknown) => void)({
        saved: { id: 'n', name: '新连接' },
        verified: false,
        created: null,
      }),
    );
    expect(mocks.setNotice).toHaveBeenCalledWith(
      '已添加模型连接「新连接」，尚未验证',
    );
    expect(mocks.get).toHaveBeenCalledWith('/api/config/claude/providers');
    expect(lastProps(mocks.wizard).open).toBe(false);
  });

  test('leaving the wizard after an OAuth login says the connection exists', async () => {
    mocks.get.mockResolvedValue(listing(null));
    await render();
    await act(async () =>
      (lastProps(mocks.wizard).onClose as (result: unknown) => void)({
        saved: null,
        verified: false,
        created: { id: 'c', name: '官方 Claude (OAuth)' },
      }),
    );
    expect(mocks.setNotice).toHaveBeenCalledWith(
      expect.stringContaining('已创建模型连接「官方 Claude (OAuth)」'),
    );
  });

  test('a row opens its detail with the fresh record', async () => {
    mocks.get.mockResolvedValue(listing(null));
    await render();
    expect(lastProps(mocks.detail).provider).toBeNull();
    await act(async () =>
      (
        document.querySelectorAll('[data-slot="list-row"]')[1] as HTMLElement
      ).click(),
    );
    expect((lastProps(mocks.detail).provider as ProviderWithHealth).id).toBe(
      'b',
    );
  });

  test('the row test stores the result and reports a failure with its next step', async () => {
    mocks.get.mockResolvedValue(listing(null));
    mocks.post.mockResolvedValue({
      ok: false,
      probes: [{ model: 'a-model', ok: false, status: 402, latencyMs: 30 }],
      code: 'QUOTA_EXCEEDED',
    });
    await render();
    await act(async () =>
      document
        .querySelectorAll<HTMLButtonElement>('button[aria-label="更多操作"]')[0]
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((node) => node.textContent?.includes('测试连接'))!
        .click(),
    );
    expect(mocks.post).toHaveBeenCalledWith(
      '/api/config/claude/providers/test',
      { providerId: 'a' },
      60_000,
    );
    expect(mocks.setError).toHaveBeenCalledWith(
      expect.stringContaining('「配置 a」余额或额度不足'),
    );
  });

  test('weights are editable under the weighted strategy and saved per connection', async () => {
    const weighted = {
      ...listing(null),
      providers: [provider('a', true), provider('b', true)],
      balancing: {
        strategy: 'weighted-round-robin',
        unhealthyThreshold: 3,
        recoveryIntervalMs: 300_000,
      },
    };
    mocks.get.mockResolvedValue(weighted);
    mocks.patch.mockResolvedValue({ provider: provider('b', true) });
    await render();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-controls="balancing-settings-panel"]',
        )!
        .click(),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="「配置 b」的权重"]',
    )!;
    expect(input.value).toBe('1');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '250');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.focus();
      input.blur();
    });
    // Clamped to the server's 1–100 range.
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/config/claude/providers/b',
      { weight: 100 },
      120_000,
    );
  });
});
