import {
  splitOneMillionSuffix,
  withOneMillionSuffix,
} from '@/lib/model-providers';

export interface DefaultProviderEnvRow {
  key: string;
  value: string;
  source: 'model' | 'context' | 'default';
}

/**
 * Mirrors `isOneMillionContextModel` in src/runtime-config.ts (parity is
 * tested): a third-party provider defaults to a 1M compact window only for an
 * explicit `[1m]` model, since a gateway capped at 200K cannot be detected.
 */
export function isOneMillionContextModel(model: string): boolean {
  return /\[1m\]$/i.test(model.trim());
}

/**
 * The editable defaults prefilled for a third-party connection, derived from
 * its default model (`[1m]` included when it runs with the 1M window).
 */
export function buildDefaultProviderEnv(
  defaultModel: string,
): DefaultProviderEnvRow[] {
  const model = withOneMillionSuffix(
    defaultModel,
    splitOneMillionSuffix(defaultModel).oneMillion,
  );
  return [
    { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: model, source: 'model' },
    { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: model, source: 'model' },
    { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: model, source: 'model' },
    { key: 'CLAUDE_CODE_SUBAGENT_MODEL', value: model, source: 'model' },
    {
      key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      // Same default the backend applies when the provider leaves it unset.
      value: isOneMillionContextModel(model) ? '1000000' : '200000',
      source: 'context',
    },
    {
      key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      value: '1',
      source: 'default',
    },
    { key: 'CLAUDE_CODE_EFFORT_LEVEL', value: 'max', source: 'default' },
    { key: 'CLAUDE_CODE_NO_FLICKER', value: '1', source: 'default' },
    { key: 'API_TIMEOUT_MS', value: '3000000', source: 'default' },
  ];
}
