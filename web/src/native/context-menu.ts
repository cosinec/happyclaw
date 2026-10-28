import { useCallback, useLayoutEffect, useRef } from 'react';
import { getNativeBridge } from './bridge';

/**
 * Native long-press menus (iOS shell). An element registers its menu with
 * `useNativeContextMenu()`; on touch-down the current items and the
 * element's visible rect go to the shell, which shows the system menu with
 * the element lifted if the press becomes a long press. Item handlers stay
 * here and run when the shell reports the choice. In a browser, or with a
 * shell that lacks `contextmenu`, nothing is sent and nothing changes.
 */
export interface NativeMenuAction {
  id: string;
  title: string;
  /** SF Symbol name. */
  symbol?: string;
  destructive?: boolean;
  onSelect: () => void;
}

export interface NativeMenuSpec {
  title?: string;
  actions: NativeMenuAction[];
}

let sequence = 0;
let offered: { token: string; actions: NativeMenuAction[] } | null = null;

/** Called by the bridge with `contextmenu.result`. */
export function handleNativeContextMenuResult(token: string, selected: string) {
  if (offered?.token !== token) return;
  const action = offered.actions.find((item) => item.id === selected);
  offered = null;
  action?.onSelect();
}

function visibleRect(element: Element) {
  const rect = element.getBoundingClientRect();
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const right = Math.min(window.innerWidth, rect.right);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Returns a ref callback for the element that owns the menu. `getMenu` is
 * read at touch-down, so it always reflects the current message state.
 */
export function useNativeContextMenu<T extends HTMLElement>(
  getMenu: () => NativeMenuSpec | null,
) {
  const latest = useRef(getMenu);
  useLayoutEffect(() => {
    latest.current = getMenu;
  });

  return useCallback((element: T | null) => {
    if (!element) return;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const bridge = getNativeBridge();
      if (!bridge?.supports('contextmenu')) return;
      const menu = latest.current();
      if (!menu || menu.actions.length === 0) return;
      const token = `m${++sequence}`;
      offered = { token, actions: menu.actions };
      bridge.send('contextmenu.offer', {
        token,
        title: menu.title ?? null,
        rect: visibleRect(element),
        items: menu.actions.map(({ id, title, symbol, destructive }) => ({
          id,
          title,
          symbol,
          destructive,
        })),
      });
    };
    element.dataset.nativeMenu = '';
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      delete element.dataset.nativeMenu;
    };
  }, []);
}
