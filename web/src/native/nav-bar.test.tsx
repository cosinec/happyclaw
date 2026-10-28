// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { applyNativeLayout } from './layout';
import {
  currentNativeNavBar,
  subscribeNativeNavBar,
  useNativeNavBar,
  type NativeNavBarSpec,
} from './nav-bar';
import { buildTabDeclarations, describeRoute } from './navigation';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Page({ spec }: { spec: NativeNavBarSpec | null }) {
  useNativeNavBar(spec);
  return null;
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
});

describe('useNativeNavBar', () => {
  test('registers while active and always calls the latest callback', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeNavBar(listener);
    const first = vi.fn();
    const second = vi.fn();

    await act(async () => root.render(<Page spec={null} />));
    expect(currentNativeNavBar()).toBeNull();

    await act(async () =>
      root.render(<Page spec={{ title: '详情', onBack: first }} />),
    );
    expect(currentNativeNavBar()?.title).toBe('详情');
    expect(listener).toHaveBeenCalled();

    // A new closure with the same visible state does not need re-announcing,
    // but the bar must still call it.
    await act(async () =>
      root.render(<Page spec={{ title: '详情', onBack: second }} />),
    );
    currentNativeNavBar()?.onBack?.();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    await act(async () => root.render(<Page spec={null} />));
    expect(currentNativeNavBar()).toBeNull();
    unsubscribe();
  });

  test('the innermost declaration wins and unmount restores the outer one', async () => {
    await act(async () =>
      root.render(
        <>
          <Page spec={{ title: '外层' }} />
          <Page spec={{ title: '内层' }} />
        </>,
      ),
    );
    expect(currentNativeNavBar()?.title).toBe('内层');
    await act(async () => root.render(<Page spec={{ title: '外层' }} />));
    expect(currentNativeNavBar()?.title).toBe('外层');
  });
});

describe('native navigation bar declaration', () => {
  const decl = buildTabDeclarations(false);

  test('tab pages show a title, chat keeps its own header', () => {
    expect(describeRoute('/tasks', decl, false).nav).toEqual({
      visible: true,
      title: '任务',
      back: false,
      action: null,
    });
    expect(describeRoute('/chat', decl, false).nav.visible).toBe(false);
    expect(describeRoute('/chat/main', decl, true).nav.visible).toBe(false);
    expect(describeRoute('/login', decl, false).nav.visible).toBe(false);
  });

  test('pushed routes get a back button', () => {
    expect(describeRoute('/users', decl, false)).toMatchObject({
      tabBar: false,
      nav: { visible: true, title: '用户管理', back: true },
    });
  });

  test('a page override sets title, back and the trailing action', () => {
    const route = describeRoute('/memory', decl, false, {
      title: '记忆详情',
      onBack: () => {},
      action: { symbol: 'list.bullet', title: '分区', onPress: () => {} },
    });
    expect(route.nav).toEqual({
      visible: true,
      title: '记忆详情',
      back: true,
      action: { id: 'page', title: '分区', symbol: 'list.bullet' },
    });
    // An override without a title keeps the route's title.
    expect(describeRoute('/settings', decl, false, {}).nav.title).toBe('设置');
  });

  test('the html attribute follows the reported top inset', () => {
    const html = document.createElement('html');
    const layout = (top: number) => ({
      contentInsets: { top, right: 0, bottom: 0, left: 0 },
      safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
      keyboard: 0,
    });
    applyNativeLayout(layout(103), html);
    expect(html.dataset.nativeNav).toBe('visible');
    expect(html.style.getPropertyValue('--native-top')).toBe('103px');
    applyNativeLayout(layout(0), html);
    expect(html.dataset.nativeNav).toBeUndefined();
  });
});
