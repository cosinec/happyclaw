import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseNativeMessage } from './protocol';
import { BridgeSession, type NativeHost } from './session';
import {
  buildTabDeclarations,
  describeRoute,
  findDeclaration,
} from './navigation';

const welcome = {
  v: 1,
  type: 'bridge.welcome',
  payload: {
    session: 's1',
    version: 1,
    capabilities: ['layout', 'tabs', 'confirm', 'haptic'],
    shell: { platform: 'ios', version: '0.1.0', build: '1', os: '27.1' },
  },
};

const layout = {
  v: 1,
  type: 'layout.update',
  payload: {
    contentInsets: { top: 0, right: 0, bottom: 96, left: 0 },
    safeArea: { top: 59, right: 0, bottom: 34, left: 0 },
    keyboard: 0,
  },
};

function setup(timeout = 1000) {
  const posted: any[] = [];
  const host: NativeHost = { platform: 'ios', post: (m) => posted.push(m) };
  const onCommit = vi.fn();
  const onRelease = vi.fn();
  const session = new BridgeSession({
    host,
    capabilities: ['layout', 'tabs', 'confirm', 'haptic'],
    build: 'test',
    onCommit,
    onRelease,
    handshakeTimeoutMs: timeout,
  });
  return { session, posted, onCommit, onRelease };
}

describe('parseNativeMessage', () => {
  test('accepts a well-formed message', () => {
    expect(parseNativeMessage(layout).ok).toBe(true);
  });

  test('rejects unknown versions, types and payloads with a ref', () => {
    expect(parseNativeMessage({ ...layout, v: 9, id: 'a' })).toMatchObject({
      ok: false,
      code: 'version_unsupported',
      ref: 'a',
    });
    expect(
      parseNativeMessage({ v: 1, type: 'nope', payload: {} }),
    ).toMatchObject({ ok: false, code: 'unsupported_type' });
    expect(
      parseNativeMessage({
        v: 1,
        type: 'layout.update',
        payload: { contentInsets: { top: 'x' } },
      }),
    ).toMatchObject({ ok: false, code: 'invalid_message' });
    expect(parseNativeMessage('junk')).toMatchObject({ ok: false });
  });
});

describe('BridgeSession handshake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('hello → welcome → layout commits and sends ready', () => {
    const { session, posted, onCommit } = setup();
    session.start();
    expect(posted[0]).toMatchObject({
      v: 1,
      type: 'bridge.hello',
      payload: { versions: [1] },
    });
    expect(session.state).toBe('negotiating');

    session.receive(welcome);
    // Welcome alone must not switch chrome: layout has to exist first.
    expect(session.state).toBe('negotiating');
    expect(onCommit).not.toHaveBeenCalled();

    const layouts: unknown[] = [];
    session.on('layout.update', (p) => layouts.push(p));
    session.receive(layout);
    expect(layouts).toHaveLength(1);
    expect(session.state).toBe('active');
    expect(onCommit).toHaveBeenCalledOnce();
    expect(posted.at(-1)).toMatchObject({
      type: 'bridge.ready',
      payload: { session: 's1' },
    });
    expect(session.supports('confirm')).toBe(true);
    expect(session.supports('share')).toBe(false);
  });

  test('falls back to browser mode when the shell never answers', () => {
    const { session, onCommit } = setup(500);
    session.start();
    vi.advanceTimersByTime(600);
    expect(session.state).toBe('browser');
    session.receive(welcome);
    session.receive(layout);
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('reject and incompatible welcome never commit native chrome', () => {
    const a = setup();
    a.session.start();
    a.session.receive({
      v: 1,
      type: 'bridge.reject',
      payload: { code: 'version_unsupported', message: 'old', supported: [2] },
    });
    expect(a.session.state).toBe('rejected');

    const b = setup();
    b.session.start();
    b.session.receive({
      ...welcome,
      payload: { ...welcome.payload, version: 7 },
    });
    expect(b.session.state).toBe('rejected');
    expect(b.posted.at(-1)).toMatchObject({
      type: 'bridge.error',
      payload: { code: 'version_unsupported' },
    });
    expect(b.onCommit).not.toHaveBeenCalled();
  });

  test('invalid inbound message is reported back, not thrown', () => {
    const { session, posted } = setup();
    session.start();
    session.receive(welcome);
    session.receive(layout);
    session.receive({ v: 1, type: 'confirm.result', id: 'w1', payload: {} });
    expect(posted.at(-1)).toMatchObject({
      type: 'bridge.error',
      payload: { code: 'invalid_message', ref: 'w1' },
    });
  });
});

describe('BridgeSession requests', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function active() {
    const ctx = setup();
    ctx.session.start();
    ctx.session.receive(welcome);
    ctx.session.receive(layout);
    return ctx;
  }

  test('matches results by id', async () => {
    const { session, posted } = active();
    const pending = session.request('confirm.request', {
      title: '删除会话？',
      message: '不可恢复',
      confirmText: '删除',
      cancelText: '取消',
      destructive: true,
    });
    const id = posted.at(-1).id;
    expect(posted.at(-1)).toMatchObject({ type: 'confirm.request' });
    session.receive({
      v: 1,
      type: 'confirm.result',
      id,
      payload: { confirmed: true },
    });
    await expect(pending).resolves.toMatchObject({
      payload: { confirmed: true },
    });
  });

  test('a native error or timeout settles the request as null', async () => {
    const { session, posted } = active();
    const first = session.request('menu.request', {
      title: null,
      message: null,
      items: [{ id: 'a', title: 'A' }],
    });
    session.receive({
      v: 1,
      type: 'bridge.error',
      payload: { code: 'busy', message: 'sheet open', ref: posted.at(-1).id },
    });
    await expect(first).resolves.toBeNull();

    const second = session.request(
      'menu.request',
      { title: null, message: null, items: [] },
      1000,
    );
    vi.advanceTimersByTime(1001);
    await expect(second).resolves.toBeNull();
  });

  test('declarations are dropped outside an active session', async () => {
    const { session, posted } = setup();
    expect(session.send('haptic', { style: 'light' })).toBe(false);
    await expect(
      session.request('confirm.request', {
        title: '',
        message: '',
        confirmText: '',
        cancelText: '',
        destructive: false,
      }),
    ).resolves.toBeNull();
    expect(posted).toHaveLength(0);
  });
});

describe('native navigation mapping', () => {
  test('tabs and overflow follow nav metadata and billing', () => {
    const off = buildTabDeclarations(false);
    expect(off.tabs.map((t) => t.path)).toEqual([
      '/chat',
      '/agent-profiles',
      '/capabilities',
      '/tasks',
    ]);
    expect(off.more.map((t) => t.path)).toEqual([
      '/usage',
      '/memory',
      '/settings',
    ]);
    expect(buildTabDeclarations(true).more.map((t) => t.path)).toContain(
      '/billing',
    );
  });

  test('route description mirrors the mobile tab bar rules', () => {
    const decl = buildTabDeclarations(false);
    expect(describeRoute('/chat', decl, false)).toMatchObject({
      tabId: 'chat',
      tabBar: true,
    });
    // An open conversation hides the tab bar, like AppLayout does.
    expect(describeRoute('/chat/main', decl, true)).toMatchObject({
      tabId: 'chat',
      tabBar: false,
      canGoBack: true,
    });
    expect(describeRoute('/capabilities/mcp', decl, false)).toMatchObject({
      tabId: 'capabilities',
      tabBar: true,
    });
    expect(describeRoute('/memory', decl, false)).toMatchObject({
      tabId: 'memory',
      title: '记忆',
    });
    expect(describeRoute('/login', decl, false)).toMatchObject({
      tabId: null,
      tabBar: false,
    });
    // Prefix matching respects path segments.
    expect(describeRoute('/chatter', decl, false).tabId).toBeNull();
    expect(findDeclaration('tasks', decl)?.path).toBe('/tasks');
  });
});
