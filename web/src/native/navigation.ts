import { filterNavItems } from '../components/layout/nav-items';
import { navBarActions, type NativeNavBarSpec } from './nav-bar';
import type {
  NavActionDeclaration,
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
 * The chat list and an open conversation keep their web headers unless the
 * page declares a native bar itself (phones, via useNativeNavBar).
 */
function routeOwnsHeader(pathname: string) {
  return matchesPrefix(pathname, '/chat');
}

/** `nav.action` id of a page's trailing button; the first keeps `page`. */
export function navActionId(index: number) {
  return index === 0 ? 'page' : `page:${index}`;
}

export function navActionIndex(id: string): number | null {
  if (id === 'page') return 0;
  const match = /^page:(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

function declareActions(spec: NativeNavBarSpec): NavActionDeclaration[] {
  return navBarActions(spec).map((action, index) => ({
    id: navActionId(index),
    title: action.title,
    symbol: action.symbol,
    ...(action.menu && {
      menu: action.menu.map((section, sectionIndex) => ({
        id: `section:${sectionIndex}`,
        title: '',
        inline: true,
        children: section.map((item) => ({
          id: item.id,
          title: item.title,
          symbol: item.symbol,
          destructive: item.destructive,
        })),
      })),
    }),
  }));
}

/**
 * `drawer`: the shell draws a menu button for the web's navigation drawer
 * (phones, after the web's own phone layout), so no tab bar is declared and
 * every top-level bar leads with that button.
 */
export function describeRoute(
  pathname: string,
  declarations: { tabs: TabDeclaration[]; more: TabDeclaration[] },
  canGoBack: boolean,
  override: NativeNavBarSpec | null = null,
  modal = false,
  drawer = false,
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
    const actions = declareActions(override);
    nav = {
      visible: true,
      title: override.title ?? title,
      back: nav.back || !!override.onBack,
      action: actions[0] ?? null,
      ...(actions.length > 1 && { actions }),
    };
  }
  if (drawer && nav.visible && !nav.back) nav.menu = true;

  return {
    path: pathname,
    title,
    tabId: match?.id ?? null,
    canGoBack,
    tabBar: !drawer && !!match && !CONVERSATION_ROUTE.test(pathname),
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
