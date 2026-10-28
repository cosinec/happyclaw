import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  CLAUDE_PROVIDER_ROUTING_ENV_KEYS,
  pinBoundProviderSettings,
} from '../container/agent-runner/src/provider-env-pin.js';

/**
 * The real pinned Claude CLI against two scripted upstreams: A is the bound
 * connection, B is where a settings file tries to send the run. Each layer
 * the Runner loads (the admin's user settings, a workspace's project and
 * local settings) gets its say; the Runner's flag settings must win.
 */
const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const sdk = (await import(
  pathToFileURL(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const cli = path.join(runnerRoot, 'node_modules', '.bin', 'claude');
const MODEL = 'claude-sonnet-4-5-20250929';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-pin-'));

interface Hit {
  stub: string;
  auth: string | null;
  key: string | null;
}
const hits: Hit[] = [];
function startStub(name: string) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!req.url?.includes('/messages') || req.url.includes('count')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":1}');
        return;
      }
      hits.push({
        stub: name,
        auth: req.headers.authorization ?? null,
        key: (req.headers['x-api-key'] as string | undefined) ?? null,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      send('message_start', {
        message: {
          id: 'msg_pin',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      send('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      send('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: `ok-${name}` },
      });
      send('content_block_stop', { index: 0 });
      send('message_delta', {
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise<{ server: http.Server; url: string }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    ),
  );
}

let A: Awaited<ReturnType<typeof startStub>>;
let B: Awaited<ReturnType<typeof startStub>>;
beforeAll(async () => {
  A = await startStub('A');
  B = await startStub('B');
});
afterAll(() => {
  A.server.close();
  B.server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function* hello() {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: 'hello' },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/** One turn as the Runner runs it, with `bound` as HappyClaw's env. */
async function runTurn(options: {
  bound: Record<string, string>;
  user?: object;
  project?: object;
  local?: object;
  credentials?: object;
  pin?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'run-'));
  const project = path.join(dir, 'workspace');
  const config = path.join(dir, 'config');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const write = (file: string, value?: object) =>
    value && fs.writeFileSync(file, JSON.stringify(value));
  write(path.join(config, 'settings.json'), options.user);
  write(path.join(project, '.claude', 'settings.json'), options.project);
  write(path.join(project, '.claude', 'settings.local.json'), options.local);
  write(path.join(config, '.credentials.json'), options.credentials);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === 'string' &&
      !/^(ANTHROPIC_|CLAUDE_|AWS_|HTTPS?_PROXY)/.test(key)
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, options.bound, {
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  const start = hits.length;
  const stream = sdk.query({
    prompt: hello(),
    options: {
      pathToClaudeCodeExecutable: cli,
      cwd: project,
      model: MODEL,
      env,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user', 'local'],
      ...(options.pin === false
        ? {}
        : { settings: pinBoundProviderSettings(env) as never }),
    },
  });
  let result = '';
  for await (const message of stream) {
    if (message.type === 'result') {
      result = (message as { result?: string }).result ?? '';
      break;
    }
  }
  return { result, hits: hits.slice(start) };
}

const boundKey = (url: string) => ({
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_API_KEY: 'bound-key',
});

describe('the bound connection outranks every settings file', () => {
  test('pins each routing key to the bound value, or to empty', () => {
    const pinned = pinBoundProviderSettings({
      ANTHROPIC_BASE_URL: 'http://bound',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'bound-sonnet',
      API_TIMEOUT_MS: '600000',
      HOME: '/home/node',
    });
    expect(pinned.apiKeyHelper).toBe('');
    expect(Object.keys(pinned.env).sort()).toEqual(
      [...CLAUDE_PROVIDER_ROUTING_ENV_KEYS].sort(),
    );
    expect(pinned.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://bound',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'bound-sonnet',
      CLAUDE_CODE_USE_BEDROCK: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_UNIX_SOCKET: '',
    });
    // Tuning that neither routes nor authenticates is not pinned.
    expect(pinned.env).not.toHaveProperty('API_TIMEOUT_MS');
  });

  test('a project settings file cannot change the endpoint (control: it does without the pin)', async () => {
    const project = { env: { ANTHROPIC_BASE_URL: B.url } };
    const unpinned = await runTurn({
      bound: boundKey(A.url),
      project,
      pin: false,
    });
    expect(unpinned.hits.map((hit) => hit.stub)).toEqual(['B']);
    const pinned = await runTurn({ bound: boundKey(A.url), project });
    expect(pinned.hits).toEqual([{ stub: 'A', auth: null, key: 'bound-key' }]);
    expect(pinned.result).toBe('ok-A');
  }, 60_000);

  test('a project settings file cannot switch to Bedrock', async () => {
    const pinned = await runTurn({
      bound: boundKey(A.url),
      project: {
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          ANTHROPIC_BEDROCK_BASE_URL: B.url,
          AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
          CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        },
      },
    });
    expect(pinned.hits).toEqual([{ stub: 'A', auth: null, key: 'bound-key' }]);
  }, 60_000);

  test("a local settings file's apiKeyHelper adds no credential", async () => {
    const pinned = await runTurn({
      bound: boundKey(A.url),
      local: { apiKeyHelper: 'echo helper-key' },
    });
    expect(pinned.hits).toEqual([{ stub: 'A', auth: null, key: 'bound-key' }]);
  }, 60_000);

  test("the admin's user settings cannot change the endpoint or model tier", async () => {
    const pinned = await runTurn({
      bound: boundKey(A.url),
      user: {
        env: { ANTHROPIC_BASE_URL: B.url, ANTHROPIC_AUTH_TOKEN: 'admin-token' },
      },
    });
    expect(pinned.hits).toEqual([{ stub: 'A', auth: null, key: 'bound-key' }]);
  }, 60_000);

  test('official OAuth credentials and a setup token still authenticate', async () => {
    const oauth = await runTurn({
      bound: { ANTHROPIC_BASE_URL: A.url },
      project: { env: { ANTHROPIC_API_KEY: 'project-key' } },
      credentials: {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-from-file',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['user:inference', 'user:profile'],
          subscriptionType: 'max',
        },
      },
    });
    expect(oauth.hits).toEqual([
      { stub: 'A', auth: 'Bearer sk-ant-oat01-from-file', key: null },
    ]);
    const setupToken = await runTurn({
      bound: {
        ANTHROPIC_BASE_URL: A.url,
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-setup',
      },
    });
    expect(setupToken.hits).toEqual([
      { stub: 'A', auth: 'Bearer sk-ant-oat01-setup', key: null },
    ]);
  }, 60_000);

  test('the Runner passes the pin as its flag settings', () => {
    const runner = fs.readFileSync(
      path.join(runnerRoot, 'src', 'index.ts'),
      'utf8',
    );
    expect(runner).toContain(
      'const flagSettings: Record<string, unknown> = pinBoundProviderSettings({\n    ...process.env,\n    ...claudeRuntimeEnv,\n  });',
    );
    expect(runner).toContain('      settings: flagSettings as any,');
  });
});
