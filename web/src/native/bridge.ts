import type { BridgeSession } from './session';
import type { HapticStyle, MenuItemDeclaration } from './protocol';

// Holder for the one bridge session of this page. Kept apart from install.ts
// so stores (confirm, haptics) can ask "is the shell active?" without pulling
// in the router wiring.
let current: BridgeSession | null = null;

export function setNativeBridge(session: BridgeSession | null) {
  current = session;
}

export function getNativeBridge() {
  return current;
}

export interface NativeConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

/**
 * Show the confirmation as a native alert. Resolves null when the shell does
 * not handle it, so the caller renders the web dialog instead.
 */
export async function nativeConfirm(
  options: NativeConfirmOptions,
): Promise<boolean | null> {
  const bridge = current;
  if (!bridge?.supports('confirm')) return null;
  const response = await bridge.request('confirm.request', {
    title: options.title,
    message: options.message,
    confirmText: options.confirmText ?? '确认',
    cancelText: options.cancelText ?? '取消',
    destructive: options.destructive ?? false,
  });
  if (response?.type !== 'confirm.result') return false;
  return response.payload.confirmed;
}

/**
 * Open a system menu from `anchor` (iOS shell with `anchoredmenu`).
 * Resolves the chosen item id, null when dismissed, or undefined when the
 * shell cannot do it, so the caller opens its web menu instead.
 */
export async function nativeAnchoredMenu(
  anchor: Element,
  items: MenuItemDeclaration[],
  title: string | null = null,
): Promise<string | null | undefined> {
  const bridge = current;
  if (!bridge?.supports('anchoredmenu')) return undefined;
  const rect = anchor.getBoundingClientRect();
  const response = await bridge.request('menu.request', {
    title,
    message: null,
    items,
    anchor: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
  });
  if (response?.type !== 'menu.result') return null;
  return response.payload.selected;
}

/** Returns false when the shell is not active, so callers can fall back. */
export function nativeHaptic(style: HapticStyle) {
  const bridge = current;
  if (!bridge?.supports('haptic')) return false;
  return bridge.send('haptic', { style });
}
