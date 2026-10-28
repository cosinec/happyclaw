// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setNativeBridge } from './bridge';
import {
  handleNativeContextMenuResult,
  useNativeContextMenu,
  type NativeMenuSpec,
} from './context-menu';
import type { WebToNativePayloads } from './protocol';
import type { BridgeSession } from './session';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Bubble({ menu }: { menu: () => NativeMenuSpec | null }) {
  const ref = useNativeContextMenu<HTMLDivElement>(menu);
  return <div ref={ref} data-testid="bubble" />;
}

function stubBridge(supports: boolean) {
  const sent: Array<{
    type: string;
    payload: WebToNativePayloads['contextmenu.offer'];
  }> = [];
  setNativeBridge({
    supports: (capability: string) => supports && capability === 'contextmenu',
    send: (type: string, payload: WebToNativePayloads['contextmenu.offer']) => {
      sent.push({ type, payload });
      return true;
    },
  } as unknown as BridgeSession);
  return sent;
}

function touch(element: Element) {
  const event = new Event('touchstart', { bubbles: true }) as Event & {
    touches: unknown[];
  };
  Object.defineProperty(event, 'touches', { value: [{}] });
  element.dispatchEvent(event);
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setNativeBridge(null);
});

describe('useNativeContextMenu', () => {
  test('offers the current items on touch-down and runs the chosen one', async () => {
    const sent = stubBridge(true);
    const copy = vi.fn();
    const remove = vi.fn();
    await act(async () =>
      root.render(
        <Bubble
          menu={() => ({
            actions: [
              {
                id: 'copy',
                title: '复制文本',
                symbol: 'doc.on.doc',
                onSelect: copy,
              },
              {
                id: 'delete',
                title: '删除',
                destructive: true,
                onSelect: remove,
              },
            ],
          })}
        />,
      ),
    );
    const bubble = container.querySelector('[data-testid="bubble"]')!;
    expect(bubble.hasAttribute('data-native-menu')).toBe(true);

    touch(bubble);
    expect(sent).toHaveLength(1);
    const offer = sent[0];
    expect(offer.type).toBe('contextmenu.offer');
    // Handlers stay in the page; only declarations cross the bridge.
    expect(offer.payload.items).toEqual([
      {
        id: 'copy',
        title: '复制文本',
        symbol: 'doc.on.doc',
        destructive: undefined,
      },
      { id: 'delete', title: '删除', symbol: undefined, destructive: true },
    ]);

    handleNativeContextMenuResult(offer.payload.token, 'delete');
    expect(remove).toHaveBeenCalledOnce();
    expect(copy).not.toHaveBeenCalled();
    // A token is used at most once.
    handleNativeContextMenuResult(offer.payload.token, 'delete');
    expect(remove).toHaveBeenCalledOnce();
  });

  test('a stale token from an earlier press does nothing', async () => {
    const sent = stubBridge(true);
    const first = vi.fn();
    await act(async () =>
      root.render(
        <Bubble
          menu={() => ({ actions: [{ id: 'a', title: 'A', onSelect: first }] })}
        />,
      ),
    );
    const bubble = container.querySelector('[data-testid="bubble"]')!;
    touch(bubble);
    touch(bubble);
    handleNativeContextMenuResult(sent[0].payload.token, 'a');
    expect(first).not.toHaveBeenCalled();
    handleNativeContextMenuResult(sent[1].payload.token, 'a');
    expect(first).toHaveBeenCalledOnce();
  });

  test('sends nothing without a shell that supports menus, or without items', async () => {
    const sent = stubBridge(false);
    await act(async () =>
      root.render(
        <Bubble
          menu={() => ({
            actions: [{ id: 'a', title: 'A', onSelect: () => {} }],
          })}
        />,
      ),
    );
    touch(container.querySelector('[data-testid="bubble"]')!);
    expect(sent).toHaveLength(0);

    const supported = stubBridge(true);
    await act(async () =>
      root.render(<Bubble menu={() => ({ actions: [] })} />),
    );
    touch(container.querySelector('[data-testid="bubble"]')!);
    expect(supported).toHaveLength(0);
  });
});
