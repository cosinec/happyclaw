import { create } from 'zustand';
import { getNativeBridge, nativeConfirm } from '../native/bridge';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** `danger` renders a destructive confirm button. */
  variant?: 'primary' | 'danger';
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  pending: PendingConfirm | null;
  settle: (confirmed: boolean) => void;
}

let nextId = 1;

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  settle: (confirmed) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));

/**
 * Promise-based replacement for window.confirm(), rendered by <ConfirmHost/>.
 * A new request cancels any dialog that is still open.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // Inside the iOS shell the confirmation is a native alert; a bridge that
  // drops mid-request counts as cancel rather than confirming anything.
  if (getNativeBridge()?.supports('confirm')) {
    return nativeConfirm({
      title: options.title,
      message: options.message,
      confirmText: options.confirmText,
      cancelText: options.cancelText,
      destructive: options.variant === 'danger',
    }).then((confirmed) => confirmed ?? false);
  }
  return new Promise((resolve) => {
    const previous = useConfirmStore.getState().pending;
    previous?.resolve(false);
    useConfirmStore.setState({
      pending: { ...options, id: nextId++, resolve },
    });
  });
}
