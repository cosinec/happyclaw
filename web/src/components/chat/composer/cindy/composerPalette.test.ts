/**
 * Source: cindy packages/maker-shared/src/__tests__/composerPalette.test.ts
 * (commit 7be4c57d7b, Apache-2.0; see THIRD_PARTY_NOTICES.md).
 * Modified for HappyClaw: adapted against cindy 7be4c57d7b and runs on
 * Tiptap 3.30.6.
 * Dropped: slash-command merge, `serializeAtResource`, Pi `skill:` alias and agent-resource cases.
 */
import { describe, expect, it } from 'vitest';
import * as composerPalette from './composerPalette';
import { detectComposerTrigger, filterAtResources } from './composerPalette';

describe('shared composer palette model', () => {
  it('detects slash and at triggers only in active token runs', () => {
    expect(detectComposerTrigger('/com')).toEqual({
      kind: 'slash',
      query: 'com',
      from: 0,
    });
    expect(detectComposerTrigger('/compact now')).toEqual({ kind: 'none' });
    expect(detectComposerTrigger('open @app')).toEqual({
      kind: 'at',
      query: 'app',
      from: 5,
    });
    expect(detectComposerTrigger('mail@company')).toEqual({ kind: 'none' });
    expect(detectComposerTrigger('open @app now')).toEqual({ kind: 'none' });
  });

  // Skipped: the port has no text-insertion helpers (`insertSlashCommand` / `insertAtResource`).
  it.skip('inserts selected slash commands and at resources as desktop-compatible text', () => {
    const { insertSlashCommand, insertAtResource } =
      composerPalette as unknown as {
        insertSlashCommand: (
          text: string,
          trigger: unknown,
          command: { name: string },
        ) => string;
        insertAtResource: (
          text: string,
          trigger: unknown,
          item: composerPalette.ComposerAtResourceItem,
        ) => string;
      };
    const slashTrigger = detectComposerTrigger('/com');
    expect(insertSlashCommand('/com', slashTrigger, { name: 'compact' })).toBe(
      '/compact ',
    );

    const atTrigger = detectComposerTrigger('read @ses');
    expect(
      insertAtResource('read @ses', atTrigger, {
        type: 'file',
        name: 'sessions.ts',
        relPath: 'apps/desktop/src/main/localDb/ipc/sessions.ts',
      }),
    ).toBe('read @apps/desktop/src/main/localDb/ipc/sessions.ts ');
  });

  it('ranks @ resources with agents first for empty query and fuzzy path fallback', () => {
    const items = [
      {
        type: 'file' as const,
        name: 'sessions.ts',
        relPath: 'apps/server/src/routes/sessions.ts',
      },
      {
        type: 'dir' as const,
        name: 'routes',
        relPath: 'apps/server/src/routes',
      },
    ];
    expect(filterAtResources(items, '').map((item) => item.name)).toEqual([
      'routes',
      'sessions.ts',
    ]);
    expect(filterAtResources(items, 'asr').map((item) => item.relPath)).toEqual(
      ['apps/server/src/routes', 'apps/server/src/routes/sessions.ts'],
    );
  });
});
