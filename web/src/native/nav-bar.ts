import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Page-level overrides for the native navigation bar.
 *
 * Routes get a default bar from `describeRoute()`; a page that drills down
 * inside one route (a memory detail, the agent creation panel) declares its
 * own title and back action here. The innermost mounted declaration wins.
 * Outside the iOS shell nothing reads this store, so pages can call the hook
 * unconditionally; it carries no bridge code.
 */
export interface NativeNavMenuItem {
  id: string;
  title: string;
  symbol?: string;
  destructive?: boolean;
  onSelect: () => void;
}

/** A trailing button (SF Symbol): pressed, or opening its menu. */
export interface NativeNavAction {
  symbol: string;
  title: string;
  onPress?: () => void;
  /** Shown as a system menu from the button; sections are kept apart. */
  menu?: NativeNavMenuItem[][];
}

export interface NativeNavBarSpec {
  title?: string;
  /** Shows the native back button; called instead of history back. */
  onBack?: () => void;
  /** A single trailing button. */
  action?: NativeNavAction;
  /** Several trailing buttons, grouped; used instead of `action`. */
  actions?: NativeNavAction[];
}

/** The trailing buttons a spec declares, in either form. */
export function navBarActions(spec: NativeNavBarSpec): NativeNavAction[] {
  return spec.actions ?? (spec.action ? [spec.action] : []);
}

interface Entry {
  spec: NativeNavBarSpec;
}

const entries: Entry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function currentNativeNavBar(): NativeNavBarSpec | null {
  return entries.at(-1)?.spec ?? null;
}

export function subscribeNativeNavBar(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pass `null` when the page is in its route's default state. */
export function useNativeNavBar(spec: NativeNavBarSpec | null) {
  const entry = useRef<Entry | null>(null);
  const active = spec !== null;

  // Callbacks are read from the latest render without re-announcing.
  useLayoutEffect(() => {
    if (entry.current && spec) entry.current.spec = spec;
  });

  useEffect(() => {
    if (!active) return;
    const own: Entry = { spec: spec ?? {} };
    entry.current = own;
    entries.push(own);
    notify();
    return () => {
      const index = entries.indexOf(own);
      if (index >= 0) entries.splice(index, 1);
      entry.current = null;
      notify();
    };
    // `spec` is intentionally not a dependency: the layout effect above
    // refreshes it, and the effect below re-announces visible changes.
  }, [active]);

  const title = spec?.title;
  const hasBack = !!spec?.onBack;
  // Everything the shell draws, so a changed menu is announced again.
  const actionKey = spec
    ? JSON.stringify(
        navBarActions(spec).map((action) => [
          action.symbol,
          action.title,
          action.menu?.map((section) =>
            section.map((item) => [item.id, item.title, item.destructive]),
          ),
        ]),
      )
    : '';
  useEffect(() => {
    if (active) notify();
  }, [active, title, hasBack, actionKey]);
}
