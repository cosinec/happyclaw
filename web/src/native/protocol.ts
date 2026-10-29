/**
 * HappyClaw native shell bridge protocol (web side).
 *
 * The iOS shell (ios/HappyClaw) hosts this app in a WKWebView and takes over
 * window chrome (tab bar, confirm dialogs, menus, haptics). Only declarations
 * and results cross the bridge — never business data. Permission filtering
 * stays on the web side: the shell renders whatever the web declares.
 *
 * Every message is an envelope `{ v, type, id?, payload }`. `v` is the
 * negotiated protocol version (the hello carries the highest version the web
 * speaks). Request/response pairs share `id`. The Swift mirror lives in
 * ios/HappyClawCore/Sources/HappyClawCore/BridgeProtocol.swift and both sides
 * must change together; ios/README.md documents the wire format.
 */

/** Versions this web build can speak, ascending. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export const CURRENT_PROTOCOL_VERSION = 1;

/** Name of the WKScriptMessageHandler the shell registers. */
export const NATIVE_HANDLER_NAME = 'happyclaw';

export type WebCapability =
  | 'layout'
  | 'tabs'
  | 'confirm'
  | 'menu'
  | 'haptic'
  | 'theme'
  | 'navbar'
  | 'shortcuts';

export type NativeCapability =
  | WebCapability
  | 'contextmenu'
  | 'anchoredmenu'
  | 'drawer'
  | 'share'
  | 'picker'
  | 'passkey';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A tab or overflow entry declared by the web. `symbol` is an SF Symbol. */
export interface TabDeclaration {
  id: string;
  title: string;
  symbol: string;
  path: string;
}

export interface MenuItemDeclaration {
  id: string;
  title: string;
  symbol?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Radio-style choice (theme, palette). */
  checked?: boolean;
  /** A group: a submenu, or with `inline` a titled section. */
  children?: MenuItemDeclaration[];
  inline?: boolean;
}

/** One trailing button in the native navigation bar. */
export interface NavActionDeclaration {
  id: string;
  title: string;
  symbol: string;
  /** The button opens this menu; `nav.action` then names the chosen item. */
  menu?: MenuItemDeclaration[];
}

/**
 * Native navigation bar for the current screen. Pages that keep a rich web
 * header (chat list, open conversation) declare `visible: false`.
 */
export interface NavBarDeclaration {
  visible: boolean;
  title: string | null;
  back: boolean;
  action: NavActionDeclaration | null;
  /** A leading button opening the navigation drawer (shells with `drawer`). */
  menu?: boolean;
  /** Trailing buttons in one group; supersedes `action` where read. */
  actions?: NavActionDeclaration[];
}

export type HapticStyle = 'light' | 'medium' | 'success' | 'warning' | 'error';

export type BridgeErrorCode =
  | 'invalid_message'
  | 'unsupported_type'
  | 'version_unsupported'
  | 'not_ready'
  | 'busy'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Web → Native

export interface WebToNativePayloads {
  'bridge.hello': {
    versions: readonly number[];
    capabilities: WebCapability[];
    client: { name: 'happyclaw-web'; build: string };
  };
  'bridge.ready': { session: string };
  'chrome.tabs': { tabs: TabDeclaration[]; more: TabDeclaration[] };
  'route.changed': {
    path: string;
    title: string | null;
    tabId: string | null;
    canGoBack: boolean;
    tabBar: boolean;
    /** Added in v1 as an optional field; shells without `navbar` ignore it. */
    nav: NavBarDeclaration;
    /**
     * A web dialog or sheet is open. The shell hides its bars meanwhile but
     * keeps reporting the same insets, so the page behind does not shift.
     */
    modal: boolean;
  };
  'theme.changed': {
    scheme: 'light' | 'dark';
    /** Page background as #rrggbb, for native bars that sit over it. */
    background?: string;
    /** Palette accent (--primary) as #rrggbb, tints native controls. */
    accent?: string;
  };
  'confirm.request': {
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    destructive: boolean;
  };
  'menu.request': {
    title: string | null;
    message: string | null;
    items: MenuItemDeclaration[];
    /**
     * The control that opened the menu (viewport CSS pixels). Shells with
     * `anchoredmenu` show a system menu from it; otherwise an action sheet.
     */
    anchor?: { x: number; y: number; width: number; height: number };
  };
  haptic: { style: HapticStyle };
  /**
   * Sent on touch-down over an element with a long-press menu. The shell
   * shows the menu only if the long press lands inside `rect` (viewport CSS
   * pixels) while this offer is fresh; otherwise WebKit keeps the gesture.
   */
  'contextmenu.offer': {
    token: string;
    title: string | null;
    rect: { x: number; y: number; width: number; height: number };
    items: MenuItemDeclaration[];
  };
  'bridge.error': { code: BridgeErrorCode; message: string; ref?: string };
}

// ---------------------------------------------------------------------------
// Native → Web

export interface NativeToWebPayloads {
  'bridge.welcome': {
    session: string;
    version: number;
    capabilities: NativeCapability[];
    shell: { platform: 'ios'; version: string; build: string; os: string };
  };
  'bridge.reject': {
    code: 'version_unsupported';
    message: string;
    supported: number[];
  };
  'layout.update': {
    /** Area covered by native chrome, measured from the web view's edges. */
    contentInsets: Insets;
    /** System safe area of the web view (informational; env() also has it). */
    safeArea: Insets;
    /** Height of the software keyboard overlapping the web view. */
    keyboard: number;
  };
  'nav.select': { tabId: string };
  'nav.back': Record<string, never>;
  /** The bar's leading menu button: open the navigation drawer. */
  'nav.menu': Record<string, never>;
  /** `item`: the entry chosen from the action's menu, when it has one. */
  'nav.action': { id: string; item?: string };
  /** A home-screen quick action the web handles (e.g. `new-conversation`). */
  'app.shortcut': { id: string };
  /** A long-press menu item was chosen (after the menu finished closing). */
  'contextmenu.result': { token: string; selected: string };
  'confirm.result': { confirmed: boolean };
  'menu.result': { selected: string | null };
  'app.lifecycle': { state: 'active' | 'inactive' | 'background' };
  'bridge.error': { code: BridgeErrorCode; message: string; ref?: string };
}

export type WebToNativeType = keyof WebToNativePayloads;
export type NativeToWebType = keyof NativeToWebPayloads;

export interface Envelope<T extends string, P> {
  v: number;
  type: T;
  id?: string;
  payload: P;
}

export type WebToNativeMessage = {
  [K in WebToNativeType]: Envelope<K, WebToNativePayloads[K]>;
}[WebToNativeType];

export type NativeToWebMessage = {
  [K in NativeToWebType]: Envelope<K, NativeToWebPayloads[K]>;
}[NativeToWebType];

// ---------------------------------------------------------------------------
// Validation of inbound (native → web) messages. The shell is trusted code,
// but a version skew must surface as a bridge error, not a crash.

type ParseResult =
  | { ok: true; message: NativeToWebMessage }
  | { ok: false; code: BridgeErrorCode; message: string; ref?: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function isInsets(value: unknown): value is Insets {
  return (
    isObject(value) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.right) &&
    isFiniteNumber(value.bottom) &&
    isFiniteNumber(value.left)
  );
}

const payloadValidators: {
  [K in NativeToWebType]: (payload: Record<string, unknown>) => boolean;
} = {
  'bridge.welcome': (p) =>
    typeof p.session === 'string' &&
    p.session.length > 0 &&
    isFiniteNumber(p.version) &&
    Array.isArray(p.capabilities) &&
    isObject(p.shell),
  'bridge.reject': (p) =>
    typeof p.message === 'string' && Array.isArray(p.supported),
  'layout.update': (p) =>
    isInsets(p.contentInsets) &&
    isInsets(p.safeArea) &&
    isFiniteNumber(p.keyboard),
  'nav.select': (p) => typeof p.tabId === 'string',
  'nav.back': () => true,
  'nav.menu': () => true,
  'nav.action': (p) =>
    typeof p.id === 'string' &&
    (p.item === undefined || p.item === null || typeof p.item === 'string'),
  'app.shortcut': (p) => typeof p.id === 'string',
  'contextmenu.result': (p) =>
    typeof p.token === 'string' && typeof p.selected === 'string',
  'confirm.result': (p) => typeof p.confirmed === 'boolean',
  'menu.result': (p) => p.selected === null || typeof p.selected === 'string',
  'app.lifecycle': (p) =>
    p.state === 'active' || p.state === 'inactive' || p.state === 'background',
  'bridge.error': (p) =>
    typeof p.code === 'string' && typeof p.message === 'string',
};

export function parseNativeMessage(raw: unknown): ParseResult {
  if (!isObject(raw)) {
    return { ok: false, code: 'invalid_message', message: 'not an object' };
  }
  const ref = typeof raw.id === 'string' ? raw.id : undefined;
  if (!isFiniteNumber(raw.v) || typeof raw.type !== 'string') {
    return {
      ok: false,
      code: 'invalid_message',
      message: 'missing v/type',
      ref,
    };
  }
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(raw.v)) {
    return {
      ok: false,
      code: 'version_unsupported',
      message: `protocol v${raw.v} is not supported`,
      ref,
    };
  }
  const validate = payloadValidators[raw.type as NativeToWebType];
  if (!validate) {
    return {
      ok: false,
      code: 'unsupported_type',
      message: `unknown type ${raw.type}`,
      ref,
    };
  }
  const payload = raw.payload ?? {};
  if (!isObject(payload) || !validate(payload)) {
    return {
      ok: false,
      code: 'invalid_message',
      message: `invalid payload for ${raw.type}`,
      ref,
    };
  }
  return { ok: true, message: raw as unknown as NativeToWebMessage };
}
