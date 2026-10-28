/**
 * What one runner output of the main conversation settles: its SDK session,
 * and once its turn completed the context ring, scheduled group-mode task
 * turns included (they run in this conversation).
 */
import { describe, expect, test, vi } from 'vitest';

import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

function settle() {
  const globals: Record<string, any> = {
    sessions: {} as Record<string, string>,
    setSession: vi.fn(),
    setSessionInteractionMode: vi.fn(),
    broadcastContextUsage: vi.fn(async () => {}),
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('settleMainConversationOutput');
  return globals;
}

const group = { folder: 'main-output', name: 'Main' };

describe('settling a main conversation output', () => {
  test('a completed turn refreshes the context ring, whoever started it', () => {
    const globals = settle();
    // A scheduled group-mode task's turn arrives exactly like this one.
    globals.settleMainConversationOutput(
      group,
      {
        status: 'success',
        result: 'done',
        newSessionId: 'sdk-1',
        inputTurnCompleted: true,
      },
      undefined,
      'assistant',
    );
    expect(globals.broadcastContextUsage).toHaveBeenCalledExactlyOnceWith(
      'main-output',
      null,
    );
    expect(globals.sessions['main-output']).toBe('sdk-1');
    expect(globals.setSession).toHaveBeenCalledOnce();
  });

  test('a turn still running, or a failed output, changes nothing of either', () => {
    const globals = settle();
    globals.settleMainConversationOutput(
      group,
      { status: 'stream', result: null, newSessionId: 'sdk-1' },
      undefined,
      'assistant',
    );
    expect(globals.broadcastContextUsage).not.toHaveBeenCalled();
    globals.settleMainConversationOutput(
      group,
      { status: 'error', result: null, newSessionId: 'stale' },
      undefined,
      'assistant',
    );
    expect(globals.sessions['main-output']).toBe('sdk-1');
  });
});
