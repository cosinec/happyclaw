import type { NativeToWebPayloads } from './protocol';

/**
 * Native chrome is expressed to CSS through one attribute and a few
 * variables on <html>; globals.css keys every override off them so the
 * browser/PWA layout is untouched when the attribute is absent.
 *
 *   data-native-chrome="active"
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
  for (const side of INSET_VARS) root.style.removeProperty(`--native-${side}`);
  root.style.removeProperty('--native-keyboard-occlusion');
}
