import { filterNavItems } from '../components/layout/nav-items';
import type { TabDeclaration, WebToNativePayloads } from './protocol';

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

export function describeRoute(
  pathname: string,
  declarations: { tabs: TabDeclaration[]; more: TabDeclaration[] },
  canGoBack: boolean,
): WebToNativePayloads['route.changed'] {
  const match = [...declarations.tabs, ...declarations.more]
    .filter((entry) => matchesPrefix(pathname, entry.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return {
    path: pathname,
    title: match?.title ?? null,
    tabId: match?.id ?? null,
    canGoBack,
    tabBar: !!match && !CONVERSATION_ROUTE.test(pathname),
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
