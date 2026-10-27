import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  ASK_USER_QUESTION_DEFERRED_RESULT,
  RUNNER_DISALLOWED_BUILTIN_TOOLS,
  runnerCanUseTool,
  silenceShadowedCanUseToolWarning,
} from '../container/agent-runner/src/builtin-tool-policy.js';

/**
 * The pinned Claude CLI registers AskUserQuestion only when the host answers
 * permission requests. Drive the real CLI against a scripted upstream: the
 * model asks, the runner's handler answers with the deferred result, and the
 * turn ends with the model's own reply.
 */
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-ask-user-'));
const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdk = (await import(
  pathToFileURL(runnerRequire.resolve('@anthropic-ai/claude-agent-sdk')).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);

const MODEL = 'claude-sonnet-4-5-20250929';
const QUESTION_INPUT = {
  questions: [
    {
      question: '午饭吃什么？',
      header: '午饭',
      multiSelect: false,
      options: [
        { label: '面条', description: '汤面' },
        { label: '米饭', description: '盖饭' },
      ],
    },
  ],
};
const REPLY = '午饭吃什么？可选：面条、米饭。';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

function sseEvents(blocks: Block[], stopReason: string, n: number): object[] {
  const events: object[] = [
    {
      type: 'message_start',
      message: {
        id: `msg_ask_${n}`,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: 'content_block_start',
          index,
          content_block: { ...block, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: 'message_stop' },
  );
  return events;
}

interface AgentRequest {
  tools: string[];
  messages: Array<{ role: string; content: unknown }>;
}

function startUpstream() {
  const agentRequests: AgentRequest[] = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!req.url?.includes('/v1/messages') || req.url.includes('count')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const body = JSON.parse(raw || '{}') as {
        tools?: Array<{ name: string }>;
        messages?: AgentRequest['messages'];
      };
      const n = ++calls;
      let blocks: Block[] = [{ type: 'text', text: 'ok' }];
      let stop = 'end_turn';
      if (body.tools?.length) {
        agentRequests.push({
          tools: body.tools.map((tool) => tool.name),
          messages: body.messages ?? [],
        });
        if (agentRequests.length === 1) {
          blocks = [
            {
              type: 'tool_use',
              id: 'toolu_ask_1',
              name: 'AskUserQuestion',
              input: QUESTION_INPUT,
            },
          ];
          stop = 'tool_use';
        } else {
          blocks = [{ type: 'text', text: REPLY }];
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of sseEvents(blocks, stop, n)) {
        res.write(
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      res.end();
    });
  });
  return new Promise<{
    server: http.Server;
    port: number;
    agentRequests: AgentRequest[];
  }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        agentRequests,
      }),
    ),
  );
}

async function* singleUserMessage(text: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('AskUserQuestion in the runner', () => {
  test('only the shadowed-canUseTool warning is silenced', () => {
    const original = process.listeners('warning');
    const seen = vi.fn();
    process.removeAllListeners('warning');
    process.on('warning', seen);
    try {
      silenceShadowedCanUseToolWarning();
      process.emit(
        'warning',
        Object.assign(new Error('shadowed'), {
          name: 'Warning',
          code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED',
        }),
      );
      const other = Object.assign(new Error('other'), {
        name: 'Warning',
        code: 'OTHER_WARNING',
      });
      process.emit('warning', other);
      expect(seen.mock.calls).toEqual([[other]]);
    } finally {
      process.removeAllListeners('warning');
      for (const listener of original) process.on('warning', listener);
    }
  });

  test('the handler defers AskUserQuestion and allows every other tool', async () => {
    const options = { signal: new AbortController().signal };
    await expect(
      runnerCanUseTool('AskUserQuestion', QUESTION_INPUT, options),
    ).resolves.toEqual({
      behavior: 'deny',
      message: ASK_USER_QUESTION_DEFERRED_RESULT,
    });
    const input = { command: 'ls' };
    await expect(runnerCanUseTool('Bash', input, options)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
  });

  test('the model receives the deferred result and ends the turn with its reply', async () => {
    const upstream = await startUpstream();
    try {
      const stream = runnerSdk.query({
        prompt: singleUserMessage('问我午饭吃什么'),
        options: {
          pathToClaudeCodeExecutable: runnerClaudeExecutable,
          cwd,
          model: MODEL,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            ),
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
            ANTHROPIC_AUTH_TOKEN: 'happyclaw-ask-test',
            ANTHROPIC_API_KEY: '',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          allowedTools: ['Bash', 'Read'],
          disallowedTools: [...RUNNER_DISALLOWED_BUILTIN_TOOLS],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          canUseTool: runnerCanUseTool,
          settingSources: [],
        },
      });
      let result: { subtype?: string; result?: string } | undefined;
      for await (const message of stream) {
        if (message.type === 'result') {
          result = message as typeof result;
          break;
        }
      }

      expect(result).toMatchObject({ subtype: 'success', result: REPLY });
      const [first, second] = upstream.agentRequests;
      expect(first.tools).toContain('AskUserQuestion');
      expect(first.tools).not.toContain('EnterPlanMode');
      expect(first.tools).not.toContain('ExitPlanMode');
      const toolResult = second.messages
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find(
          (
            block,
          ): block is {
            type: string;
            tool_use_id: string;
            is_error?: boolean;
            content: unknown;
          } =>
            (block as { type?: string }).type === 'tool_result' &&
            (block as { tool_use_id?: string }).tool_use_id === 'toolu_ask_1',
        );
      expect(toolResult?.is_error).toBe(true);
      expect(JSON.stringify(toolResult?.content)).toContain(
        ASK_USER_QUESTION_DEFERRED_RESULT,
      );
    } finally {
      upstream.server.close();
    }
  }, 60_000);
});
