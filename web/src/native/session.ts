import {
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  parseNativeMessage,
  type NativeCapability,
  type NativeToWebMessage,
  type NativeToWebPayloads,
  type NativeToWebType,
  type WebCapability,
  type WebToNativeMessage,
  type WebToNativePayloads,
  type WebToNativeType,
} from './protocol';

/**
 * Object the shell injects into the top frame at document start. Its presence
 * is the only signal that we run inside the app — never the user agent.
 */
export interface NativeHost {
  platform: 'ios';
  post(message: unknown): void;
}

declare global {
  interface Window {
    HappyClawNative?: NativeHost;
    /** Entry point the shell calls with each native → web envelope. */
    __happyclawNativeReceive?: (message: unknown) => void;
  }
}

/**
 * browser     no shell, or the shell never answered; web chrome stays on
 * negotiating hello sent, waiting for welcome + first layout
 * active      native chrome committed (data-native-chrome="active")
 * rejected    shell refused our protocol version; the shell shows recovery
 */
export type BridgeState = 'browser' | 'negotiating' | 'active' | 'rejected';

type Handler<K extends NativeToWebType> = (
  payload: NativeToWebPayloads[K],
  message: NativeToWebMessage,
) => void;

interface PendingRequest {
  resolve: (message: NativeToWebMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeSessionOptions {
  host: NativeHost;
  capabilities: WebCapability[];
  build: string;
  /** Called once welcome + first layout arrived; must apply native chrome. */
  onCommit: (welcome: NativeToWebPayloads['bridge.welcome']) => void;
  /** Called when the session leaves `active` (reject/teardown). */
  onRelease: () => void;
  handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 4000;

export class BridgeSession {
  state: BridgeState = 'browser';
  sessionId: string | null = null;
  nativeCapabilities = new Set<NativeCapability>();

  private readonly options: BridgeSessionOptions;
  private readonly handlers = new Map<
    NativeToWebType,
    Set<Handler<NativeToWebType>>
  >();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stateListeners = new Set<(state: BridgeState) => void>();
  private welcome: NativeToWebPayloads['bridge.welcome'] | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;

  constructor(options: BridgeSessionOptions) {
    this.options = options;
  }

  start() {
    if (this.state !== 'browser') return;
    this.setState('negotiating');
    this.post({
      v: CURRENT_PROTOCOL_VERSION,
      type: 'bridge.hello',
      payload: {
        versions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: this.options.capabilities,
        client: { name: 'happyclaw-web', build: this.options.build },
      },
    });
    // Fail open: a shell that never answers leaves the full web UI usable.
    this.handshakeTimer = setTimeout(() => {
      if (this.state === 'negotiating') this.setState('browser');
    }, this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  }

  /** Feed one raw native → web envelope. */
  receive(raw: unknown) {
    const parsed = parseNativeMessage(raw);
    if (!parsed.ok) {
      this.sendError(parsed.code, parsed.message, parsed.ref);
      return;
    }
    const message = parsed.message;

    switch (message.type) {
      case 'bridge.welcome':
        this.handleWelcome(message.payload);
        return;
      case 'bridge.reject':
        this.clearHandshakeTimer();
        this.release('rejected');
        return;
      case 'layout.update':
        // The first layout after welcome commits native chrome; layout must
        // exist before the web hides its own chrome, or content would jump.
        if (this.state === 'negotiating' && this.welcome) {
          this.dispatch(message);
          this.commit();
          return;
        }
        break;
      case 'bridge.error':
        if (message.payload.ref) this.settle(message.payload.ref, null);
        break;
      case 'confirm.result':
      case 'menu.result':
        if (message.id) this.settle(message.id, message);
        return;
    }
    this.dispatch(message);
  }

  on<K extends NativeToWebType>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<NativeToWebType>);
    return () => set.delete(handler as Handler<NativeToWebType>);
  }

  onStateChange(listener: (state: BridgeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  supports(capability: NativeCapability) {
    return this.state === 'active' && this.nativeCapabilities.has(capability);
  }

  /** Fire-and-forget declaration. Dropped unless the session is active. */
  send<K extends WebToNativeType>(type: K, payload: WebToNativePayloads[K]) {
    if (this.state !== 'active') return false;
    this.post({ v: CURRENT_PROTOCOL_VERSION, type, payload } as never);
    return true;
  }

  /**
   * Request a native result. Resolves with the matching response, or null if
   * the bridge is not active, the shell reports an error, or it times out —
   * callers then fall back to their web implementation or treat it as cancel.
   */
  request<K extends WebToNativeType>(
    type: K,
    payload: WebToNativePayloads[K],
    timeoutMs = 120_000,
  ): Promise<NativeToWebMessage | null> {
    if (this.state !== 'active') return Promise.resolve(null);
    const id = `w${this.nextRequestId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, null), timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.post({ v: CURRENT_PROTOCOL_VERSION, type, id, payload } as never);
    });
  }

  private handleWelcome(welcome: NativeToWebPayloads['bridge.welcome']) {
    if (this.state !== 'negotiating') return;
    if (
      !(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(
        welcome.version,
      )
    ) {
      this.sendError(
        'version_unsupported',
        `shell chose v${welcome.version}`,
        undefined,
        true,
      );
      this.clearHandshakeTimer();
      this.release('rejected');
      return;
    }
    this.welcome = welcome;
    this.sessionId = welcome.session;
    this.nativeCapabilities = new Set(welcome.capabilities);
  }

  private commit() {
    if (!this.welcome) return;
    this.clearHandshakeTimer();
    this.setState('active');
    this.options.onCommit(this.welcome);
    this.send('bridge.ready', { session: this.welcome.session });
  }

  private release(next: BridgeState) {
    const wasActive = this.state === 'active';
    for (const id of [...this.pending.keys()]) this.settle(id, null);
    this.setState(next);
    if (wasActive) this.options.onRelease();
  }

  private settle(id: string, message: NativeToWebMessage | null) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(message);
  }

  private dispatch(message: NativeToWebMessage) {
    const set = this.handlers.get(message.type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(message.payload as never, message);
      } catch (error) {
        console.error('[native-bridge] handler failed', message.type, error);
      }
    }
  }

  private sendError(
    code: WebToNativePayloads['bridge.error']['code'],
    message: string,
    ref?: string,
    force = false,
  ) {
    // Errors are useful during negotiation too, so they bypass the active gate.
    if (!force && this.state === 'browser') return;
    this.post({
      v: CURRENT_PROTOCOL_VERSION,
      type: 'bridge.error',
      payload: ref ? { code, message, ref } : { code, message },
    });
  }

  private post(message: WebToNativeMessage) {
    try {
      this.options.host.post(message);
    } catch (error) {
      console.error('[native-bridge] post failed', error);
    }
  }

  private setState(state: BridgeState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }
}
