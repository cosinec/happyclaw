import { filterNavItems } from '../components/layout/nav-items';
import type { NativeNavBarSpec } from './nav-bar';
import type {
  NavBarDeclaration,
  TabDeclaration,
  WebToNativePayloads,
} from './protocol';

/**
 * Native tab declarations are derived from the same nav metadata the web
 * sidebar and bottom bar use, after the same billing filter, so the shell
 * never sees an entry the web would not show.
 */
export function buildTabDeclarations(billingEnabled: boolean): {
  tabs: TabDeclaration[];
  more: TabDeclaration[];
} {
  const tabs: TabDeclaration[] = [];
  const more: TabDeclaration[] = [];
  for (const item of filterNavItems(billingEnabled)) {
    const declaration: TabDeclaration = {
      id: item.path.slice(1),
      title: item.label,
      symbol: item.native.symbol,
      path: item.path,
    };
    (item.native.placement === 'tab' ? tabs : more).push(declaration);
  }
  return { tabs, more };
}

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Mirrors AppLayout: an open conversation hides the mobile tab bar. */
const CONVERSATION_ROUTE = /^\/chat\/.+/;

/**
 * Routes outside the tab set that the shell presents as pushed screens: a
 * native back button returns to history, or to `parent` on a cold start.
 */
export const PUSHED_ROUTES: Record<string, { title: string; parent: string }> =
  {
    '/users': { title: '用户管理', parent: '/settings' },
    '/monitor': { title: '运行状态', parent: '/settings' },
  };

/**
 * The chat list keeps its brand header and an open conversation its rich
 * session header, so the native bar stays hidden there.
 */
function routeOwnsHeader(pathname: string) {
  return matchesPrefix(pathname, '/chat');
}

export function describeRoute(
  pathname: string,
  declarations: { tabs: TabDeclaration[]; more: TabDeclaration[] },
  canGoBack: boolean,
  override: NativeNavBarSpec | null = null,
  modal = false,
): WebToNativePayloads['route.changed'] {
  const match = [...declarations.tabs, ...declarations.more]
    .filter((entry) => matchesPrefix(pathname, entry.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const pushed = PUSHED_ROUTES[pathname];
  const title = match?.title ?? pushed?.title ?? null;

  let nav: NavBarDeclaration = {
    visible: !!(match || pushed) && !routeOwnsHeader(pathname),
    title,
    back: !!pushed,
    action: null,
  };
  if (override) {
    nav = {
      visible: true,
      title: override.title ?? title,
      back: nav.back || !!override.onBack,
      action: override.action
        ? {
            id: 'page',
            title: override.action.title,
            symbol: override.action.symbol,
          }
        : null,
    };
  }

  return {
    path: pathname,
    title,
    tabId: match?.id ?? null,
    canGoBack,
    tabBar: !!match && !CONVERSATION_ROUTE.test(pathname),
    nav,
    modal,
  };
}

export function findDeclaration(
  tabId: string,
  declarations: { tabs: TabDeclaration[]; more: TabDeclaration[] },
) {
  return [...declarations.tabs, ...declarations.more].find(
    (entry) => entry.id === tabId,
  );
}
