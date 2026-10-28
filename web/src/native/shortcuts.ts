/**
 * Home-screen quick actions forwarded by the iOS shell (`app.shortcut`).
 *
 * A quick action can launch the app cold: the bridge may deliver it before
 * the screen that handles it is mounted (for example while the login page is
 * showing). The latest undelivered action waits for the first subscriber;
 * outside the shell nothing is ever emitted.
 */
type Listener = (id: string) => void;

const listeners = new Set<Listener>();
let pending: string | null = null;

export function emitNativeShortcut(id: string) {
  if (listeners.size === 0) {
    pending = id;
    return;
  }
  for (const listener of listeners) listener(id);
}

export function subscribeNativeShortcut(listener: Listener) {
  listeners.add(listener);
  if (pending !== null) {
    const id = pending;
    pending = null;
    listener(id);
  }
  return () => {
    listeners.delete(listener);
  };
}
