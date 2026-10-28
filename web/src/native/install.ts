import type { createBrowserRouter } from 'react-router-dom';
import { useBillingStore } from '../stores/billing';
import { setNativeBridge } from './bridge';
import {
  activateNativeChrome,
  applyNativeLayout,
  releaseNativeChrome,
} from './layout';
import { currentNativeNavBar, subscribeNativeNavBar } from './nav-bar';
import { emitNativeShortcut } from './shortcuts';
import {
  buildTabDeclarations,
  describeRoute,
  findDeclaration,
  PUSHED_ROUTES,
} from './navigation';
import { BridgeSession } from './session';

type AppRouter = ReturnType<typeof createBrowserRouter>;

/** react-router stores its history index in history.state. */
function canGoBack() {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

/** Radix dialog, sheet and alert dialog content (components/ui). */
const OPEN_MODAL_SELECTOR = [
  'dialog-content',
  'sheet-content',
  'alert-dialog-content',
]
  .map((slot) => `[data-slot="${slot}"][data-state="open"]`)
  .join(',');

function webModalOpen() {
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

function currentScheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Palette tokens may be hex, rgb() or oklch(); painting one pixel lets the
 * browser resolve any CSS color to sRGB for the shell.
 */
function cssColorHex(token: string): string | undefined {
  const css = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  const context = document.createElement('canvas').getContext('2d');
  if (!css || !context) return undefined;
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function currentTheme() {
  return {
    scheme: currentScheme(),
    background: cssColorHex('--background'),
    accent: cssColorHex('--primary'),
  };
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

  let modal = false;
  const sendRoute = () =>
    session.send(
      'route.changed',
      describeRoute(
        router.state.location.pathname,
        declarations,
        canGoBack(),
        currentNativeNavBar(),
        modal,
      ),
    );

  const session = new BridgeSession({
    host,
    capabilities: [
      'layout',
      'tabs',
      'confirm',
      'menu',
      'haptic',
      'theme',
      'navbar',
      'shortcuts',
    ],
    build: import.meta.env.VITE_BUILD_ID || import.meta.env.MODE,
    onCommit: () => {
      activateNativeChrome();
      session.send('chrome.tabs', declarations);
      sendRoute();
      let theme = currentTheme();
      session.send('theme.changed', theme);

      teardown.push(router.subscribe(sendRoute));
      teardown.push(subscribeNativeNavBar(sendRoute));
      teardown.push(
        useBillingStore.subscribe((state, previous) => {
          if (state.billingEnabled === previous.billingEnabled) return;
          declarations = buildTabDeclarations(state.billingEnabled);
          session.send('chrome.tabs', declarations);
          sendRoute();
        }),
      );
      // Scheme and palette both live in <html> classes.
      const themeObserver = new MutationObserver(() => {
        const next = currentTheme();
        if (
          next.scheme === theme.scheme &&
          next.background === theme.background &&
          next.accent === theme.accent
        )
          return;
        theme = next;
        session.send('theme.changed', theme);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      });
      teardown.push(() => themeObserver.disconnect());

      // Radix portals mount on <body> and flip data-state on open/close.
      // Observing body's own children plus data-state changes keeps streamed
      // message text out of the callback. One observer per target/options
      // pair: re-observing the same node would replace its options.
      const syncModal = () => {
        const open = webModalOpen();
        if (open === modal) return;
        modal = open;
        sendRoute();
      };
      const portals = new MutationObserver(syncModal);
      const states = new MutationObserver(syncModal);
      portals.observe(document.body, { childList: true });
      states.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-state'],
      });
      teardown.push(() => {
        portals.disconnect();
        states.disconnect();
      });
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
    const page = currentNativeNavBar();
    if (page?.onBack) {
      page.onBack();
      return;
    }
    if (canGoBack()) {
      void router.navigate(-1);
      return;
    }
    const parent = PUSHED_ROUTES[router.state.location.pathname]?.parent;
    if (parent) void router.navigate(parent, { replace: true });
  });
  session.on('app.shortcut', ({ id }) => emitNativeShortcut(id));
  session.on('nav.action', ({ id }) => {
    if (id === 'page') currentNativeNavBar()?.action?.onPress();
  });

  window.__happyclawNativeReceive = (message) => session.receive(message);
  setNativeBridge(session);
  session.start();
  return session;
}
