import { describe, expect, test } from 'vitest';

import {
  MAX_PROVIDER_MODELS,
  MODEL_PRESETS,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_COPY,
  classifyProviderError,
  describeBaseUrlProblem,
  effectiveProviderModels,
  findPresetsByBaseUrl,
  getModelPreset,
  isValidModelId,
  mergeDiscoveredModels,
  modelsUrlFor,
  normalizeProviderBaseUrl,
  normalizeProviderModels,
  parseModelList,
  presetModelEntryId,
  sortPresetsForRegion,
  splitOneMillionSuffix,
  withOneMillionSuffix,
} from '../shared/model-providers.js';
import { isOneMillionContextModel } from '../src/runtime-config.js';

describe('model ids', () => {
  test('the [1m] suffix splits and joins like the runtime reads it', () => {
    expect(splitOneMillionSuffix(' glm-5.3[1M][1m] ')).toEqual({
      model: 'glm-5.3',
      oneMillion: true,
    });
    expect(withOneMillionSuffix('glm-5.3[1m]', false)).toBe('glm-5.3');
    expect(withOneMillionSuffix('glm-5.3', true)).toBe('glm-5.3[1m]');
    expect(withOneMillionSuffix('', true)).toBe('');
    for (const id of ['glm-5.3[1m]', 'glm-5.3']) {
      expect(isOneMillionContextModel(id)).toBe(
        splitOneMillionSuffix(id).oneMillion,
      );
    }
  });

  test('ids that would break an env file are refused', () => {
    expect(isValidModelId('deepseek-v4-pro')).toBe(true);
    expect(isValidModelId('z-ai/glm-5.2')).toBe(true);
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('a b')).toBe(false);
    expect(isValidModelId('a\nANTHROPIC_BASE_URL=x')).toBe(false);
    expect(isValidModelId('x'.repeat(201))).toBe(false);
  });

  test('untrusted lists keep known fields, drop junk and duplicates', () => {
    expect(
      normalizeProviderModels([
        ' glm-5.3 ',
        { id: 'glm-5.3' },
        { id: 'glm-5.2', hidden: true, effort: 'max', extra: 1 },
        { id: 'glm-5.1', hidden: 'yes', effort: 'ultra' },
        { id: 'bad id' },
        42,
        null,
      ]),
    ).toEqual([
      { id: 'glm-5.3' },
      { id: 'glm-5.2', hidden: true, effort: 'max' },
      { id: 'glm-5.1' },
    ]);
    expect(normalizeProviderModels('glm-5.3')).toBeNull();
    const many = Array.from({ length: MAX_PROVIDER_MODELS + 5 }, (_, i) => ({
      id: `m${i}`,
    }));
    expect(normalizeProviderModels(many)).toHaveLength(MAX_PROVIDER_MODELS);
  });

  test('a connection saved before model lists offers its one model', () => {
    expect(effectiveProviderModels({ anthropicModel: 'glm-5.3' })).toEqual([
      { id: 'glm-5.3' },
    ]);
    expect(effectiveProviderModels({ anthropicModel: '' })).toEqual([]);
  });

  test('the default model is always offered and never hidden', () => {
    expect(
      effectiveProviderModels({
        anthropicModel: 'glm-5.3',
        models: [{ id: 'glm-5.2' }],
      }),
    ).toEqual([{ id: 'glm-5.3' }, { id: 'glm-5.2' }]);
    expect(
      effectiveProviderModels({
        anthropicModel: 'glm-5.3',
        models: [{ id: 'glm-5.2' }, { id: 'glm-5.3', hidden: true }],
      }),
    ).toEqual([{ id: 'glm-5.2' }, { id: 'glm-5.3' }]);
  });

  test('a refresh only adds, and what it adds starts hidden', () => {
    const existing = [{ id: 'glm-5.3[1m]' }, { id: 'glm-5.2', hidden: true }];
    const merged = mergeDiscoveredModels(existing, [
      'glm-5.3',
      'glm-5.2',
      'glm-5.4',
      ' glm-5.4 ',
      'bad id',
    ]);
    expect(merged.added).toEqual(['glm-5.4']);
    expect(merged.models).toEqual([
      ...existing,
      { id: 'glm-5.4', hidden: true },
    ]);
  });

  test('a refresh never grows a list past the cap', () => {
    const existing = Array.from(
      { length: MAX_PROVIDER_MODELS - 1 },
      (_, i) => ({
        id: `m${i}`,
      }),
    );
    const merged = mergeDiscoveredModels(existing, ['n1', 'n2']);
    expect(merged.added).toEqual(['n1']);
    expect(merged.models).toHaveLength(MAX_PROVIDER_MODELS);
  });
});

describe('presets', () => {
  test('every preset is an Anthropic endpoint with usable models', () => {
    const ids = new Set<string>();
    for (const preset of MODEL_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(normalizeProviderBaseUrl(preset.baseUrl)).toMatch(/^https:\/\//);
      expect(describeBaseUrlProblem(preset.baseUrl)).toBeNull();
      expect(preset.models.length).toBeGreaterThan(0);
      for (const model of preset.models) {
        expect(isValidModelId(presetModelEntryId(model))).toBe(true);
      }
      for (const url of [preset.keyUrl, preset.docsUrl, preset.modelsUrl]) {
        if (url) expect(url).toMatch(/^https:\/\//);
      }
    }
  });

  test('1M-window preset models are offered with [1m], once', () => {
    expect(
      presetModelEntryId({ id: 'glm-5.3', contextWindow: 1_048_576 }),
    ).toBe('glm-5.3[1m]');
    expect(
      presetModelEntryId({ id: 'glm-5.3[1m]', contextWindow: 1_000_000 }),
    ).toBe('glm-5.3[1m]');
    expect(
      presetModelEntryId({ id: 'kimi-k2.6', contextWindow: 262_144 }),
    ).toBe('kimi-k2.6');
    expect(presetModelEntryId({ id: 'ark-code-latest' })).toBe(
      'ark-code-latest',
    );
  });

  test('a base URL finds its preset regardless of case and trailing slash', () => {
    expect(
      findPresetsByBaseUrl('HTTPS://API.DEEPSEEK.COM/anthropic/').map(
        (preset) => preset.id,
      ),
    ).toEqual(['deepseek']);
    expect(findPresetsByBaseUrl('https://example.com/anthropic')).toEqual([]);
    expect(findPresetsByBaseUrl('not a url')).toEqual([]);
    expect(getModelPreset('deepseek')?.name).toBe('DeepSeek');
    expect(getModelPreset('nope')).toBeNull();
    expect(getModelPreset(null)).toBeNull();
  });

  test('a shared endpoint matches every preset on it', () => {
    expect(
      findPresetsByBaseUrl('https://open.bigmodel.cn/api/anthropic').length,
    ).toBeGreaterThan(1);
  });

  test('region only orders the list', () => {
    const cn = sortPresetsForRegion('cn');
    const global = sortPresetsForRegion('global');
    expect(cn).toHaveLength(MODEL_PRESETS.length);
    expect(global).toHaveLength(MODEL_PRESETS.length);
    expect(cn[0].region).toBe('cn');
    expect(global[0].region).toBe('global');
  });
});

describe('endpoints', () => {
  test('normalizes for comparison and refuses non-http URLs', () => {
    expect(
      normalizeProviderBaseUrl(' https://Api.Example.com/v1/?a=1#x '),
    ).toBe('https://api.example.com/v1');
    expect(normalizeProviderBaseUrl('ftp://example.com')).toBe('');
    expect(normalizeProviderBaseUrl('')).toBe('');
  });

  test('model lists live under /v1/models unless the path is versioned', () => {
    expect(modelsUrlFor('https://api.example.com/anthropic')).toBe(
      'https://api.example.com/anthropic/v1/models',
    );
    expect(modelsUrlFor('https://api.example.com/')).toBe(
      'https://api.example.com/v1/models',
    );
    expect(modelsUrlFor('https://api.example.com/api/v3')).toBe(
      'https://api.example.com/api/v3/models',
    );
    expect(
      modelsUrlFor(
        'https://api.deepseek.com/anthropic',
        getModelPreset('deepseek'),
      ),
    ).toBe('https://api.deepseek.com/models');
    expect(modelsUrlFor('nope')).toBe('');
  });

  test('warns about paths Claude Code would double', () => {
    expect(describeBaseUrlProblem('https://x.com/v1')).toMatch(/\/v1/);
    expect(describeBaseUrlProblem('https://x.com/v1/messages')).toMatch(/\/v1/);
    expect(describeBaseUrlProblem('https://x.com/anthropic')).toBeNull();
    expect(describeBaseUrlProblem('x.com')).toMatch(/http/);
    expect(describeBaseUrlProblem('')).toBeNull();
  });
});

describe('model list responses', () => {
  test('reads the OpenAI and Anthropic shapes', () => {
    expect(
      parseModelList({
        data: [
          {
            id: 'claude-sonnet-4-6',
            display_name: 'Claude Sonnet 4.6',
            max_input_tokens: 200_000,
          },
          { id: 'glm-5.3', context_length: 1_048_576 },
          { id: 'glm-5.3' },
        ],
      }),
    ).toEqual([
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 200_000,
      },
      { id: 'glm-5.3', contextWindow: 1_048_576 },
    ]);
  });

  test('reads models arrays, bare strings and alternate id fields', () => {
    expect(
      parseModelList({ models: [{ slug: 'a' }, { model_id: 'b', name: 'B' }] }),
    ).toEqual([{ id: 'a' }, { id: 'b', name: 'B' }]);
    expect(parseModelList(['x', 'y', 'x', 'bad id', 3])).toEqual([
      { id: 'x' },
      { id: 'y' },
    ]);
  });

  test('ignores nonsense context windows', () => {
    expect(
      parseModelList({
        data: [
          { id: 'a', context_length: 0.5 },
          { id: 'b', context_length: 1e20 },
          { id: 'c', context_window: '128000' },
        ],
      }),
    ).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  test('tells "not a list" from "an empty list"', () => {
    expect(parseModelList({ data: [] })).toEqual([]);
    expect(parseModelList({ error: 'nope' })).toBeNull();
    expect(parseModelList('html')).toBeNull();
    expect(parseModelList(null)).toBeNull();
  });
});

describe('upstream errors', () => {
  const code = (input: Parameters<typeof classifyProviderError>[0]) =>
    classifyProviderError(input).code;

  test('network errors decide first', () => {
    expect(code({ networkErrorCode: 'ENOTFOUND', status: 401 })).toBe(
      'UPSTREAM_UNREACHABLE',
    );
    expect(code({ networkErrorCode: 'TimeoutError' })).toBe('TIMEOUT');
    expect(code({ networkErrorCode: 'EWHATEVER' })).toBe('UNKNOWN');
    expect(code({})).toBe('UNKNOWN');
  });

  test('statuses map to what the user should do next', () => {
    expect(code({ status: 401 })).toBe('AUTH_INVALID');
    expect(code({ status: 402 })).toBe('QUOTA_EXCEEDED');
    expect(code({ status: 403, bodyText: 'Invalid API key' })).toBe(
      'AUTH_INVALID',
    );
    expect(code({ status: 403, bodyText: 'region not allowed' })).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(code({ status: 429 })).toBe('RATE_LIMITED');
    expect(code({ status: 529 })).toBe('RATE_LIMITED');
    expect(
      code({
        status: 429,
        bodyText: 'insufficient_quota: exceeded your quota',
      }),
    ).toBe('QUOTA_EXCEEDED');
    expect(code({ status: 404, bodyText: 'model: x not found' })).toBe(
      'MODEL_NOT_FOUND',
    );
    expect(code({ status: 404, bodyText: '<html>Not Found</html>' })).toBe(
      'ENDPOINT_NOT_FOUND',
    );
    expect(code({ status: 503 })).toBe('UPSTREAM_ERROR');
    expect(code({ status: 418 })).toBe('UNKNOWN');
  });

  test('400 bodies are read for the actual cause', () => {
    expect(
      code({ status: 400, bodyText: 'The model `x` does not exist' }),
    ).toBe('MODEL_NOT_FOUND');
    expect(
      code({ status: 400, bodyText: 'prompt is too long: 300000 tokens' }),
    ).toBe('CONTEXT_TOO_LONG');
    expect(code({ status: 400, bodyText: '账户余额不足' })).toBe(
      'QUOTA_EXCEEDED',
    );
    expect(code({ status: 400, bodyText: 'authentication_error' })).toBe(
      'AUTH_INVALID',
    );
    expect(
      code({ status: 422, bodyText: 'Extra inputs are not permitted' }),
    ).toBe('WIRE_INCOMPATIBLE');
    expect(code({ status: 400, bodyText: 'bad' })).toBe('UNKNOWN');
  });

  test('only transient failures are retryable', () => {
    expect(classifyProviderError({ status: 429 }).retryable).toBe(true);
    expect(classifyProviderError({ status: 502 }).retryable).toBe(true);
    expect(classifyProviderError({ status: 401 }).retryable).toBe(false);
  });

  test('every code has copy', () => {
    for (const each of PROVIDER_ERROR_CODES) {
      expect(PROVIDER_ERROR_COPY[each].title).toBeTruthy();
      expect(PROVIDER_ERROR_COPY[each].hint).toBeTruthy();
    }
  });
});
