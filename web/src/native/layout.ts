import type { NativeToWebPayloads } from './protocol';

/**
 * Native chrome is expressed to CSS through one attribute and a few
 * variables on <html>; globals.css keys every override off them so the
 * browser/PWA layout is untouched when the attribute is absent.
 *
 *   data-native-chrome="active"
 *   data-native-nav="visible"        the native navigation bar is on screen
 *                                    (contentInsets.top > 0); pages hide the
 *                                    title and back button it replaces
 *   --native-top/right/bottom/left   area covered by native chrome
 *   --native-keyboard-occlusion      software keyboard over the web view
 */
const INSET_VARS = ['top', 'right', 'bottom', 'left'] as const;

export function applyNativeLayout(
  layout: NativeToWebPayloads['layout.update'],
  root: HTMLElement = document.documentElement,
) {
  for (const side of INSET_VARS) {
    root.style.setProperty(
      `--native-${side}`,
      `${Math.max(0, layout.contentInsets[side])}px`,
    );
  }
  root.style.setProperty(
    '--native-keyboard-occlusion',
    `${Math.max(0, layout.keyboard)}px`,
  );
  if (layout.contentInsets.top > 0) root.dataset.nativeNav = 'visible';
  else delete root.dataset.nativeNav;
}

export function activateNativeChrome(
  root: HTMLElement = document.documentElement,
) {
  root.dataset.nativeChrome = 'active';
}

export function releaseNativeChrome(
  root: HTMLElement = document.documentElement,
) {
  delete root.dataset.nativeChrome;
  delete root.dataset.nativeNav;
  for (const side of INSET_VARS) root.style.removeProperty(`--native-${side}`);
  root.style.removeProperty('--native-keyboard-occlusion');
}
