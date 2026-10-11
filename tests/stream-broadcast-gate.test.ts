import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

// A proactive workspace promises the Web never receives the model's answer
// text, and what else it receives depends on its process visibility. That only
// holds if no code path hands a Runner event to the WebSocket without going
// through projectSdkStreamEventForWeb. The system-triggered terminal warmup
// run once did exactly that, found only by running a proactive container
// workspace against the real provider: its raw text, reasoning and usage
// events reached the Web.
const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'index.ts'),
  'utf8',
);

/** The body of a top-level `async function name(` up to the next top-level one. */
function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nasync function ', start + 1);
  const nextSync = source.indexOf('\nfunction ', start + 1);
  const ends = [next, nextSync].filter((index) => index > start);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

describe('Runner events reach the Web only through the projection', () => {
  test('no broadcast hands a raw Runner stream event to the Web', () => {
    expect(source).not.toMatch(
      /broadcastStreamEvent\(\s*[A-Za-z_.]+,\s*(?:result|output)\.streamEvent\b/,
    );
  });

  test('the terminal warmup run projects its events like any other turn', () => {
    const warmup = functionBody('runTerminalWarmup');
    expect(warmup).toContain('projectSdkStreamEventForWeb(');
    // The workspace's mode and level are read where the event arrives: the
    // level can change while the run is alive.
    expect(warmup).toContain('getWorkspaceProcessVisibility(');
    expect(warmup).toContain('getWorkspaceInteractionMode(');
  });
});
