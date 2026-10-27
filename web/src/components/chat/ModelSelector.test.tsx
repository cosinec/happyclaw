// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  SessionModelOption,
  SessionModelSelection,
} from './ModelSelector';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  canManage: false,
}));

vi.mock('../../api/client', () => ({
  api: { get: mocks.get, put: mocks.put },
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ hasPermission: () => mocks.canManage }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { ModelSelector, describeDefaultModel, resolveEffortContext } =
  await import('./ModelSelector');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function selection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
      },
    ],
    ...overrides,
  };
}

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A selection with one ChatGPT login next to a Claude one. */
function chatGptSelection(
  overrides: Partial<SessionModelSelection> = {},
  codex: Partial<NonNullable<SessionModelOption['codex']>> = {},
  option: Partial<SessionModelOption> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅',
        kind: 'codex',
        enabled: true,
        model: 'gpt-6.1-sol',
        usable: true,
        codex: {
          defaultModel: 'gpt-6.1-sol',
          defaultEffort: 'low',
          source: 'live',
          needsReauth: false,
          models: [
            {
              value: 'gpt-6.1-sol',
              label: 'gpt-6.1-sol（主力编码）',
              efforts: FULL,
              defaultEffort: 'low',
            },
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra（旗舰·最强推理）',
              efforts: FULL,
              defaultEffort: 'medium',
            },
            {
              value: 'gpt-5.5',
              label: 'gpt-5.5（遗留）',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
          ...codex,
        },
        ...option,
      },
    ],
    ...overrides,
  };
}

/** Two connections that list their models (a current server). */
function connectionSelection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    selectedModel: null,
    selectedEffort: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
        usable: true,
        models: [
          { id: 'opus', hidden: false },
          { id: 'sonnet', hidden: false },
          { id: 'haiku', hidden: true },
        ],
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
        usable: true,
        models: [
          { id: 'glm-5.3[1m]', hidden: false },
          { id: 'glm-4.6', hidden: false },
        ],
      },
    ],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManage = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(agentId: string | null, canChange = true) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ModelSelector
          groupJid="web:ws"
          agentId={agentId}
          canChange={canChange}
        />
      </MemoryRouter>,
    );
  });
}

async function rerender(canChange = true) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(null, canChange);
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="模型："]',
  );
  if (!button) throw new Error('model selector trigger not rendered');
  return button;
}

async function open() {
  await act(async () => trigger().click());
}

const rows = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-model-row]'),
];
/** The first line of each row: the model (or the default) it stands for. */
const titles = () => rows().map((row) => row.getAttribute('title'));
const row = (title: string) =>
  rows().find((item) => item.getAttribute('title') === title);
const detail = (title: string) =>
  row(title)?.querySelectorAll('span span')[1]?.textContent ?? '';
const checked = () =>
  rows().filter((item) => item.getAttribute('aria-checked') === 'true');

const effortGroup = () =>
  document.querySelector('[role="radiogroup"][aria-label="推理档位"]');
const chips = () => [
  ...(effortGroup()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ??
    []),
];
const chip = (value: string) =>
  document.querySelector<HTMLButtonElement>(`[data-effort="${value}"]`);

const railButton = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `[role="group"][aria-label="模型配置"] button[aria-label="${label}"]`,
  );

async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="搜索模型"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('element not found');
  await act(async () => element.click());
}

describe('describeDefaultModel', () => {
  test('names the configuration the global default resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'default', modelConfigId: 'glm', enabledCount: 3 },
        }),
      ),
    ).toBe('GLM');
  });

  test('names a ChatGPT default by the model it runs', () => {
    expect(
      describeDefaultModel(
        chatGptSelection({
          default: {
            source: 'default',
            modelConfigId: 'chatgpt',
            enabledCount: 2,
          },
        }),
      ),
    ).toBe('gpt-6.1-sol');
  });

  test('names the configuration an Agent or single provider resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'agent', modelConfigId: 'glm', enabledCount: 1 },
        }),
      ),
    ).toBe('GLM');
    expect(describeDefaultModel(selection())).toBe('自动 · 2 个');
  });

  test('adds the model the server says the default runs', () => {
    expect(
      describeDefaultModel(
        selection({
          default: {
            source: 'agent',
            modelConfigId: 'glm',
            enabledCount: 1,
            model: 'glm-5.2[1m]',
          },
        }),
      ),
    ).toBe('GLM · glm-5.2（1M）');
    // A ChatGPT default is named by that model alone.
    expect(
      describeDefaultModel(
        chatGptSelection({
          default: {
            source: 'agent',
            modelConfigId: 'chatgpt',
            enabledCount: 2,
            model: 'gpt-6-astra',
          },
        }),
      ),
    ).toBe('gpt-6-astra');
    // The pool has no model of its own.
    expect(
      describeDefaultModel(
        selection({
          default: {
            source: 'pool',
            modelConfigId: null,
            enabledCount: 2,
            model: null,
          },
        }),
      ),
    ).toBe('自动 · 2 个');
  });

  test('the effort of a followed default is the model the server resolved', () => {
    const context = resolveEffortContext(
      chatGptSelection({
        default: {
          source: 'agent',
          modelConfigId: 'chatgpt',
          enabledCount: 2,
          model: 'gpt-5.5',
        },
      }),
    );
    expect(context?.model?.value).toBe('gpt-5.5');
    expect(context?.pinnedModel).toBeNull();
  });
});

describe('the trigger', () => {
  test('loads the conversation selection and names what the default runs, without a 默认 prefix', async () => {
    mocks.get.mockResolvedValue(selection());
    await render('session-1');
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection?agentId=session-1',
    );
    expect(trigger().textContent).toBe('自动 · 2 个');
    expect(trigger().disabled).toBe(false);

    mocks.get.mockResolvedValue(
      connectionSelection({
        default: {
          source: 'default',
          modelConfigId: 'glm',
          enabledCount: 2,
          model: 'glm-5.3[1m]',
        },
      }),
    );
    await rerender();
    expect(trigger().textContent).toBe('glm-5.3');
    expect(trigger().getAttribute('aria-label')).toBe(
      '模型：GLM · glm-5.3（1M）',
    );
  });

  test('names the picked model and is read-only without Modify', async () => {
    mocks.get.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render(null, false);
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
    );
    expect(trigger().textContent).toBe('glm-5.3');
    expect(trigger().disabled).toBe(true);
    // The full 「连接 · 模型」 is still readable.
    expect(trigger().title).toBe('GLM · glm-5.3（1M）');
  });

  test('is plain text at rest and filled on hover or while open', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    const classes = [...trigger().classList];
    expect(classes).toEqual(
      expect.arrayContaining([
        'h-[30px]',
        'rounded-full',
        'text-label',
        'hover:bg-surface-hover',
        'data-[state=open]:bg-surface-hover',
      ]),
    );
    expect(classes.some((name) => name.startsWith('border'))).toBe(false);
    // The name truncates; the chevron stays.
    expect(trigger().querySelector('.truncate')).not.toBeNull();
    expect(trigger().querySelector('svg')).not.toBeNull();
    await open();
    expect(trigger().getAttribute('data-state')).toBe('open');
  });

  test('shows a ChatGPT effort in muted text after the model', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    await render(null);
    expect(trigger().textContent).toBe('gpt-6-astra高');
    const effort = [...trigger().querySelectorAll('span')].find(
      (span) => span.textContent === '高',
    );
    expect(effort?.className).toContain('text-muted-foreground');
  });

  test('the full label shows in a tooltip', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    await render(null);
    expect(trigger().title).toBe('');
    await act(async () => trigger().focus());
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent,
    ).toContain('GLM · glm-4.6');
  });

  test('closing the panel does not pop the tooltip up over the pick', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    mocks.put.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'sonnet',
      }),
    );
    await render(null);
    await open();
    await click(row('sonnet'));
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    // Leaving and coming back shows it again.
    await act(async () => {
      trigger().dispatchEvent(new PointerEvent('pointerleave'));
      trigger().blur();
    });
    await act(async () => trigger().focus());
    expect(
      document.querySelector('[data-slot="tooltip-content"]')?.textContent,
    ).toContain('Claude 官方 · sonnet');
  });

  test('stays hidden when no model configuration exists', async () => {
    mocks.get.mockResolvedValue(selection({ options: [] }));
    await render(null);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('the panel', () => {
  test('lists the default and every model as two-line rows, the one in use checked', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    await render(null);
    await open();
    expect(titles()).toEqual([
      '默认 · 自动 · 2 个',
      'opus',
      'sonnet',
      'glm-5.3',
      'glm-4.6',
    ]);
    // Second line: the connection, the 1M window, then any note.
    expect(detail('glm-5.3')).toBe('GLM · 1M 上下文');
    expect(detail('opus')).toBe('Claude 官方');
    // Pool membership is Settings' business.
    expect(document.body.textContent).not.toContain('未启用');
    expect(checked().map((item) => item.getAttribute('title'))).toEqual([
      'glm-4.6',
    ]);
    expect(checked()[0].querySelector('svg.lucide-check')).not.toBeNull();
  });

  test('the rail filters by connection and 全部 brings everything back', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    expect(railButton('全部')?.getAttribute('aria-pressed')).toBe('true');
    await click(railButton('GLM'));
    expect(railButton('GLM')?.getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual(['glm-5.3', 'glm-4.6']);
    await click(railButton('全部'));
    expect(titles()).toHaveLength(5);
  });

  test('search looks through every connection, whatever the rail shows', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    await click(railButton('GLM'));
    await search('SON');
    expect(titles()).toEqual(['sonnet']);
    await search('glm');
    // A connection's name matches all of its models.
    expect(titles()).toEqual(['glm-5.3', 'glm-4.6']);
    await search('nothing-like-this');
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).toContain('没有匹配的模型');
  });

  test('offers 管理模型配置 to whoever may manage them', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    expect(document.body.textContent).not.toContain('管理模型配置');

    mocks.canManage = true;
    await rerender();
    await open();
    const manage = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '管理模型配置',
    );
    await click(manage);
    expect(trigger().getAttribute('data-state')).toBe('closed');
  });

  test('a configuration without a credential is shown but not selectable', async () => {
    mocks.get.mockResolvedValue(
      selection({
        options: [
          ...selection().options,
          {
            id: 'copy',
            name: 'GLM (副本)',
            kind: 'third_party',
            enabled: false,
            model: 'glm-5.2',
            usable: false,
          },
        ],
      }),
    );
    await render(null);
    await open();
    expect(detail('glm-5.2')).toContain('缺少凭据');
    expect(row('glm-5.2')?.disabled).toBe(true);
  });

  test('picking a configuration from an older server sends only the configuration', async () => {
    mocks.get.mockResolvedValue(selection());
    mocks.put.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render('session-1');
    await open();
    expect(titles()).toEqual(['默认 · 自动 · 2 个', 'opus', 'glm-5.3']);
    await click(row('glm-5.3'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: 'session-1', modelConfigId: 'glm' },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「GLM」，从下一条消息开始生效',
    );
    expect(trigger().textContent).toBe('glm-5.3');
    // The panel closes once something is picked.
    expect(rows()).toHaveLength(0);
  });
});

describe('models of a configuration', () => {
  test('picking a model of a configuration pins it for the conversation', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    mocks.put.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    await render(null);
    await open();
    await click(row('glm-4.6'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'glm', model: 'glm-4.6' },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「GLM · glm-4.6」，从下一条消息开始生效',
    );
  });

  test('the default model row follows the configuration with the request older servers know', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.6',
      }),
    );
    mocks.put.mockResolvedValue(
      connectionSelection({ selectedModelConfigId: 'glm' }),
    );
    await render(null);
    await open();
    await click(row('glm-5.3'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'glm' },
    );
  });

  test('a hidden model the conversation runs on stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'official',
        selectedModel: 'haiku',
      }),
    );
    await render(null);
    await open();
    expect(titles()).toContain('haiku');
    expect(detail('haiku')).toContain('已隐藏');
    expect(checked().map((item) => item.getAttribute('title'))).toEqual([
      'haiku',
    ]);
  });

  test('a model the list no longer has stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      connectionSelection({
        selectedModelConfigId: 'glm',
        selectedModel: 'glm-4.0',
      }),
    );
    await render(null);
    await open();
    expect(detail('glm-4.0')).toContain('不在模型列表里');
    expect(checked()[0].getAttribute('title')).toBe('glm-4.0');
    // Choosing it again changes nothing.
    await click(checked()[0]);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('a configuration without a credential lists its models disabled', async () => {
    const base = connectionSelection();
    mocks.get.mockResolvedValue({
      ...base,
      options: [base.options[0], { ...base.options[1], usable: false }],
    });
    await render(null);
    await open();
    expect(row('glm-4.6')?.disabled).toBe(true);
    expect(detail('glm-4.6')).toContain('缺少凭据');
    expect(row('sonnet')?.disabled).toBe(false);
  });

  test('a relay without a model of its own lets the relay decide', async () => {
    const base = connectionSelection();
    mocks.get.mockResolvedValue({
      ...base,
      options: [
        base.options[0],
        {
          ...base.options[1],
          model: '',
          models: [{ id: 'glm-4.6', hidden: false }],
        },
      ],
    });
    mocks.put.mockResolvedValue(base);
    await render(null);
    await open();
    await click(row('由中转站决定'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'glm' },
    );
  });

  test('a refused model reads as such and reloads the selection', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    mocks.put.mockRejectedValue({
      status: 400,
      message: 'model not in connection',
      body: { code: 'MODEL_NOT_IN_CONNECTION' },
    });
    await render(null);
    await open();
    await click(row('glm-4.6'));
    expect(mocks.toastError).toHaveBeenCalledWith(
      '所选模型已不在该模型配置的模型列表里，请重新选择模型',
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});

describe('ChatGPT models', () => {
  test('lists a login models by name only', async () => {
    mocks.get.mockResolvedValue(chatGptSelection());
    await render(null);
    await open();
    expect(titles()).toEqual([
      '默认 · 自动 · 2 个',
      'opus',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-5.5',
    ]);
    // The catalog may still carry commentary; the picker never shows it.
    expect(document.body.textContent).not.toMatch(
      /主力编码|旗舰|遗留|配置默认/,
    );
    expect(detail('gpt-6-astra')).toBe('ChatGPT 订阅');
    // Its mark reads G, not the C a Claude connection has.
    expect(railButton('ChatGPT 订阅')?.textContent).toBe('G');
    expect(railButton('Claude 官方')?.textContent).toBe('C');
    expect(document.body.textContent).toContain('只调整推理档位不会');
  });

  test('a stored model the account list lacks stays visible and checked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-unlisted',
      }),
    );
    await render(null);
    await open();
    expect(checked()[0].getAttribute('title')).toBe('gpt-unlisted');
    expect(detail('gpt-unlisted')).toContain('不在账号的模型列表里');
    await click(checked()[0]);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  test('picking a model saves it with the effort it still supports', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6.1-sol',
        selectedEffort: 'high',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    await render('session-1');
    await open();
    await click(row('gpt-6-astra'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: 'session-1',
        modelConfigId: 'chatgpt',
        model: 'gpt-6-astra',
        effort: 'high',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「ChatGPT 订阅 · gpt-6-astra」，从下一条消息开始生效',
    );
  });

  test('a model without the picked effort returns to its default and says so', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6.1-sol',
        selectedEffort: 'max',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
      }),
    );
    await render(null);
    await open();
    await click(row('gpt-5.5'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: null,
        modelConfigId: 'chatgpt',
        model: 'gpt-5.5',
        effort: null,
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('该模型不支持 最高，档位已恢复为默认（中）'),
    );
  });

  test('the default row drops the model and the effort with it', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'high',
      }),
    );
    mocks.put.mockResolvedValue(chatGptSelection());
    await render(null);
    await open();
    await click(row('默认 · 自动 · 2 个'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: null },
    );
    // The configuration's own model is a pick of the configuration alone.
    mocks.put.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await open();
    await click(row('gpt-6.1-sol'));
    expect(mocks.put).toHaveBeenLastCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'chatgpt', model: null, effort: null },
    );
  });

  test('a login that has to be redone cannot be picked', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({}, { needsReauth: true }, {}),
    );
    await render(null);
    await open();
    expect(row('gpt-6-astra')?.disabled).toBe(true);
    expect(detail('gpt-6-astra')).toContain('需重新登录');
    expect(row('opus')?.disabled).toBe(false);
  });

  test('looks again when the panel opens while the list is only a fallback', async () => {
    mocks.get.mockResolvedValue(chatGptSelection({}, { source: 'builtin' }));
    await render(null);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const live = chatGptSelection(
      {},
      {
        source: 'live',
        models: [
          {
            value: 'gpt-7-new',
            label: 'gpt-7-new',
            efforts: FULL,
            defaultEffort: 'medium',
          },
        ],
        defaultModel: 'gpt-7-new',
      },
    );
    mocks.get.mockResolvedValue(live);
    // Within a few seconds of the first load nothing is asked again.
    await open();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      await act(async () => root.unmount());
      root = createRoot(container);
      mocks.get.mockClear();
      mocks.get.mockResolvedValueOnce(
        chatGptSelection({}, { source: 'builtin' }),
      );
      await render(null);
      vi.setSystemTime(Date.now() + 10_000);
      mocks.get.mockResolvedValue(live);
      await open();
      expect(mocks.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('never puts an older selection back over one that was just saved', async () => {
    vi.useFakeTimers();
    try {
      mocks.get.mockResolvedValueOnce(
        chatGptSelection({}, { source: 'builtin' }),
      );
      await render(null);
      vi.setSystemTime(Date.now() + 10_000);
      // The look-up the panel starts is slow; the save overtakes it.
      let answerLookUp!: (value: SessionModelSelection) => void;
      mocks.get.mockReturnValueOnce(
        new Promise<SessionModelSelection>((resolve) => {
          answerLookUp = resolve;
        }),
      );
      mocks.put.mockResolvedValue(
        chatGptSelection({
          selectedModelConfigId: 'chatgpt',
          selectedModel: 'gpt-6-astra',
        }),
      );
      await open();
      await click(row('gpt-6-astra'));
      expect(trigger().textContent).toContain('gpt-6-astra');
      await act(async () => {
        answerLookUp(chatGptSelection({}, { source: 'live' }));
      });
      expect(trigger().textContent).toContain('gpt-6-astra');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reasoning effort', () => {
  test('is not offered without a ChatGPT login, or while the pool picks', async () => {
    mocks.get.mockResolvedValue(connectionSelection());
    await render(null);
    await open();
    expect(effortGroup()).toBeNull();

    mocks.get.mockResolvedValue(chatGptSelection());
    await rerender();
    await open();
    expect(effortGroup()).toBeNull();
    expect(trigger().textContent).toBe('自动 · 2 个');
  });

  test('sits under the model in use, lists its levels low to high and saves a pick', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-5.5',
        selectedEffort: 'high',
      }),
    );
    await render('session-1');
    // Following the model's default level.
    expect(trigger().textContent).toBe('gpt-5.5中');
    await open();
    // Right after the checked row.
    expect(checked()[0].nextElementSibling?.getAttribute('aria-label')).toBe(
      '推理档位',
    );
    expect(chips().map((item) => item.textContent)).toEqual([
      '默认 · 中',
      '低',
      '中',
      '高',
    ]);
    expect(chip('default')?.getAttribute('aria-checked')).toBe('true');
    await click(chip('high'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      {
        agentId: 'session-1',
        modelConfigId: 'chatgpt',
        model: 'gpt-5.5',
        effort: 'high',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '推理档位已设为高，从下一个请求开始生效',
    );
    expect(trigger().textContent).toBe('gpt-5.5高');
    expect(chip('high')?.getAttribute('aria-checked')).toBe('true');
  });

  test('only offers the levels the server lists for this user', async () => {
    const withUltra = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt', selectedModel: 'gpt-6-astra' },
        {
          models: [
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra',
              efforts: withUltra,
              defaultEffort: 'medium',
            },
          ],
        },
      ),
    );
    await render(null);
    await open();
    expect(chip('ultra')).not.toBeNull();

    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-6-astra',
      }),
    );
    await rerender();
    await open();
    expect(chip('ultra')).toBeNull();
  });

  test('the default chip clears a picked effort', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedEffort: 'max',
      }),
    );
    mocks.put.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    await render(null);
    await open();
    await click(chip('default'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'chatgpt', model: null, effort: null },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已恢复默认推理档位，从下一个请求开始生效',
    );
  });

  test('a ChatGPT default sits under the default row and pins the login when set', async () => {
    const defaulted = chatGptSelection({
      default: {
        source: 'default',
        modelConfigId: 'chatgpt',
        enabledCount: 2,
      },
    });
    mocks.get.mockResolvedValue(defaulted);
    mocks.put.mockResolvedValue({
      ...defaulted,
      selectedModelConfigId: 'chatgpt',
      selectedEffort: 'high',
    });
    await render(null);
    expect(trigger().textContent).toBe('gpt-6.1-sol低');
    await open();
    expect(checked().map((item) => item.getAttribute('title'))).toEqual([
      '默认 · gpt-6.1-sol',
    ]);
    expect(document.body.textContent).toContain('使用模型配置里设为默认的模型');
    expect(checked()[0].nextElementSibling?.getAttribute('aria-label')).toBe(
      '推理档位',
    );
    await click(chip('high'));
    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: null, modelConfigId: 'chatgpt', model: null, effort: 'high' },
    );
  });

  test('cannot be changed when the login must be redone', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection(
        { selectedModelConfigId: 'chatgpt' },
        { needsReauth: true },
      ),
    );
    await render(null);
    await open();
    expect(chips().every((item) => item.disabled)).toBe(true);
  });

  test('says why when the model in use is not in the account list', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({
        selectedModelConfigId: 'chatgpt',
        selectedModel: 'gpt-unlisted',
      }),
    );
    await render(null);
    expect(trigger().textContent).toBe('gpt-unlisted');
    await open();
    expect(effortGroup()).toBeNull();
    expect(document.body.textContent).toContain(
      '当前模型不在账号的模型列表里，无法设置推理档位',
    );
  });

  test('a refused pick reloads what the server holds', async () => {
    mocks.get.mockResolvedValue(
      chatGptSelection({ selectedModelConfigId: 'chatgpt' }),
    );
    mocks.put.mockRejectedValue(
      new Error('推理档位 ultra 仅限具备系统配置权限的用户选择'),
    );
    await render(null);
    await open();
    await click(chip('max'));
    expect(mocks.toastError).toHaveBeenCalledWith(
      '推理档位 ultra 仅限具备系统配置权限的用户选择',
    );
    // Picked again from the server's state.
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(trigger().textContent).toBe('gpt-6.1-sol低');
  });
});
