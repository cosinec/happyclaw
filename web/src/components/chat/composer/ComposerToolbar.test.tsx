// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ComposerToolbar } from './ComposerToolbar';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

type Props = ComponentProps<typeof ComposerToolbar>;

function render(overrides: Partial<Props>) {
  const props: Props = {
    canAttach: true,
    uploading: false,
    onPickImages: vi.fn(),
    onPickFiles: vi.fn(),
    onPickFolder: vi.fn(),
    onResetSession: vi.fn(),
    onToggleTerminal: vi.fn(),
    showSideStop: false,
    stopping: false,
    stopDisabled: false,
    onStop: vi.fn(),
    send: {
      glyph: 'send',
      disabled: true,
      label: '发送消息',
      onClick: vi.fn(),
      escapeStops: false,
    },
    ...overrides,
  };
  container ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(container);
  act(() => root!.render(<ComposerToolbar {...props} />));
}

/** The + trigger: the first button of the tools. */
const plus = () =>
  container!.querySelector<HTMLButtonElement>('[data-composer-tools] button')!;

async function openMenu() {
  await act(async () => {
    plus().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

/** Open menu items by their text, with whether each is disabled. */
const items = () =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (item) => [item.textContent, item.hasAttribute('data-disabled')],
    ),
  );

describe('the + menu', () => {
  test('is named after what it offers', () => {
    render({});
    expect(plus().getAttribute('aria-label')).toBe('添加文件');

    render({ foldActions: true });
    expect(plus().getAttribute('aria-label')).toBe('更多操作');

    // No attachments here: the menu holds only the folded actions.
    render({ foldActions: true, canAttach: false });
    expect(plus().getAttribute('aria-label')).toBe('更多操作');
  });

  test('without attachments it lists only clear-context and terminal', async () => {
    render({ foldActions: true, canAttach: false });
    await openMenu();
    expect(items()).toEqual({ 清除上下文: false, 终端: false });
  });

  test('an upload in progress still allows adding images', async () => {
    render({ foldActions: true, uploading: true });
    await openMenu();
    expect(items()).toEqual({
      添加图片: false,
      上传文件: true,
      上传文件夹: true,
      清除上下文: false,
      终端: false,
    });
  });

  test('unfolded, an upload in progress disables the menu as before', () => {
    render({ uploading: true });
    expect(plus().disabled).toBe(true);
  });
});
