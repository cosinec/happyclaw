import { nativeHaptic } from '../native/bridge';

const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;

export function lightTap() {
  if (nativeHaptic('light')) return;
  if (canVibrate) navigator.vibrate(10);
}

export function mediumTap() {
  if (nativeHaptic('medium')) return;
  if (canVibrate) navigator.vibrate(20);
}

export function successTap() {
  if (nativeHaptic('success')) return;
  if (canVibrate) navigator.vibrate([10, 50, 20]);
}
