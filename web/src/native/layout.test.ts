// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest';
import {
  activateNativeChrome,
  applyNativeLayout,
  releaseNativeChrome,
} from './layout';

describe('native layout variables', () => {
  test('apply, activate and release leave no residue', () => {
    const root = document.createElement('html');
    applyNativeLayout(
      {
        contentInsets: { top: 0, right: 0, bottom: 96.5, left: -3 },
        safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
        keyboard: 300,
      },
      root,
    );
    activateNativeChrome(root);
    expect(root.dataset.nativeChrome).toBe('active');
    expect(root.style.getPropertyValue('--native-bottom')).toBe('96.5px');
    // Negative insets are clamped rather than pulling content offscreen.
    expect(root.style.getPropertyValue('--native-left')).toBe('0px');
    expect(root.style.getPropertyValue('--native-keyboard-occlusion')).toBe(
      '300px',
    );

    releaseNativeChrome(root);
    expect(root.dataset.nativeChrome).toBeUndefined();
    expect(root.style.getPropertyValue('--native-bottom')).toBe('');
  });
});
