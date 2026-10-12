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
  setNotice: vi.fn(),
  setError: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: { get: mocks.get, put: mocks.put, post: vi.fn(), delete: vi.fn() },
}));
// The editor is not under test; keep its catalog requests out of the way.
vi.mock('./ProviderEditor', () => ({ ProviderEditor: () => null }));

const { ClaudeProviderSection } = await import('./ClaudeProviderSection');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.get.mockReset();
  mocks.put.mockReset();
  mocks.setNotice.mockReset();
  mocks.setError.mockReset();
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
});
