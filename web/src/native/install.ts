import type { createBrowserRouter } from 'react-router-dom';
import { useBillingStore } from '../stores/billing';
import { setNativeBridge } from './bridge';
import {
  activateNativeChrome,
  applyNativeLayout,
  releaseNativeChrome,
} from './layout';
import {
  buildTabDeclarations,
  describeRoute,
  findDeclaration,
} from './navigation';
import { BridgeSession } from './session';

type AppRouter = ReturnType<typeof createBrowserRouter>;

/** react-router stores its history index in history.state. */
function canGoBack() {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

function currentScheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Start the native bridge when running inside the HappyClaw iOS shell.
 * In a browser or PWA `window.HappyClawNative` is absent and this is a no-op.
 */
export function installNativeBridge(router: AppRouter) {
  if (typeof window === 'undefined' || window.top !== window) return null;
  const host = window.HappyClawNative;
  if (!host || typeof host.post !== 'function') return null;

  let declarations = buildTabDeclarations(
    useBillingStore.getState().billingEnabled,
  );
  const teardown: Array<() => void> = [];

  const sendRoute = () =>
    session.send(
      'route.changed',
      describeRoute(router.state.location.pathname, declarations, canGoBack()),
    );

  const session = new BridgeSession({
    host,
    capabilities: ['layout', 'tabs', 'confirm', 'menu', 'haptic', 'theme'],
    build: import.meta.env.VITE_BUILD_ID || import.meta.env.MODE,
    onCommit: () => {
      activateNativeChrome();
      session.send('chrome.tabs', declarations);
      sendRoute();
      session.send('theme.changed', { scheme: currentScheme() });

      teardown.push(router.subscribe(sendRoute));
      teardown.push(
        useBillingStore.subscribe((state, previous) => {
          if (state.billingEnabled === previous.billingEnabled) return;
          declarations = buildTabDeclarations(state.billingEnabled);
          session.send('chrome.tabs', declarations);
          sendRoute();
        }),
      );
      const themeObserver = new MutationObserver(() =>
        session.send('theme.changed', { scheme: currentScheme() }),
      );
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
      teardown.push(() => themeObserver.disconnect());
    },
    onRelease: () => {
      for (const dispose of teardown.splice(0)) dispose();
      releaseNativeChrome();
    },
  });

  session.on('layout.update', (layout) => applyNativeLayout(layout));
  session.on('nav.select', ({ tabId }) => {
    const target = findDeclaration(tabId, declarations);
    if (target) void router.navigate(target.path, { replace: true });
  });
  session.on('nav.back', () => {
    if (canGoBack()) void router.navigate(-1);
  });

  window.__happyclawNativeReceive = (message) => session.receive(message);
  setNativeBridge(session);
  session.start();
  return session;
}
