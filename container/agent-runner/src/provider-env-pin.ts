/**
 * Environment through which Claude Code (2.1.296) picks the endpoint, the
 * credentials or the model tier of its requests. A settings file's `env`
 * outranks the process environment, so an admin's ~/.claude, a workspace's
 * .claude/settings.json or .claude/settings.local.json could otherwise send
 * a run (and the bound connection's key) somewhere else.
 *
 * General-purpose cloud credentials (AWS_ACCESS_KEY_ID, AWS_PROFILE,
 * GOOGLE_APPLICATION_CREDENTIALS) stay out: they route nothing unless a
 * CLAUDE_CODE_USE_* switch below is on, and blanking them would break the
 * agent's own tools that use them.
 */
export const CLAUDE_PROVIDER_ROUTING_ENV_KEYS: readonly string[] = [
  // Which backend serves the requests.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  // Where the requests go.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  // Who they authenticate as.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  // Which model each tier runs.
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * Flag settings (the SDK `settings` option, which outranks the user, project
 * and local settings files) that pin the bound connection: each routing key
 * keeps the value HappyClaw put in the runner's environment, every other one
 * is set empty, which Claude Code reads as unset (the default endpoint and
 * model; OAuth credentials from .credentials.json still apply), and no
 * apiKeyHelper runs.
 */
export function pinBoundProviderSettings(
  env: Readonly<Record<string, string | undefined>>,
): { env: Record<string, string>; apiKeyHelper: string } {
  return {
    env: Object.fromEntries(
      CLAUDE_PROVIDER_ROUTING_ENV_KEYS.map((key) => [key, env[key] ?? '']),
    ),
    apiKeyHelper: '',
  };
}
