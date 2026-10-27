/**
 * Canonical source. Build step copies this file to:
 *   - src/model-providers.ts
 *   - web/src/lib/model-providers.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 */

/**
 * What the server and the Web agree on about model connections: the vendor
 * presets a connection can start from, the models a connection offers, how a
 * vendor's model list is read, and how an upstream failure is classified.
 * Everything here is data or a pure function.
 *
 * The preset catalog, the model list parsing and the error classification are
 * adapted from cindy (https://github.com/makecindy/cindy, Apache-2.0, commit
 * 7be4c57d7b: packages/model-providers/catalog/providers.json,
 * packages/model-providers/src/modelDiscovery.ts and
 * apps/desktop/src/shared/providerErrors.ts). Modified for HappyClaw: only the
 * Anthropic Messages endpoints Claude Code can use are kept, and the copy is
 * HappyClaw's own. See THIRD_PARTY_NOTICES.md.
 */

// ─── Models of a connection ────────────────────────────────────

/** Reasoning efforts Claude Code accepts as CLAUDE_CODE_EFFORT_LEVEL. */
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/**
 * One model a connection offers. `id` is exactly what Claude Code is given as
 * ANTHROPIC_MODEL; a trailing `[1m]` asks for the 1M context window.
 */
export interface ProviderModelEntry {
  id: string;
  /** Left out of the chat picker; an explicit binding may still name it. */
  hidden?: boolean;
  /** Effort this model runs at unless the Agent sets its own. */
  effort?: ModelEffort;
}

export const MAX_PROVIDER_MODELS = 100;
export const MAX_PROVIDER_MODEL_ID_LENGTH = 200;

const ONE_MILLION_SUFFIX = '[1m]';
const ONE_MILLION_SUFFIX_RE = /(?:\[1m\])+$/i;

/** Context windows at or above this run with the `[1m]` suffix. */
export const ONE_MILLION_CONTEXT = 1_000_000;

export function splitOneMillionSuffix(id: string): {
  model: string;
  oneMillion: boolean;
} {
  const trimmed = id.trim();
  return {
    model: trimmed.replace(ONE_MILLION_SUFFIX_RE, '').trim(),
    oneMillion: ONE_MILLION_SUFFIX_RE.test(trimmed),
  };
}

export function withOneMillionSuffix(
  model: string,
  oneMillion: boolean,
): string {
  const base = splitOneMillionSuffix(model).model;
  return oneMillion && base ? `${base}${ONE_MILLION_SUFFIX}` : base;
}

/** Whether `id` can be handed to Claude Code as a model name. */
export function isValidModelId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_PROVIDER_MODEL_ID_LENGTH &&
    // No whitespace or control characters: the id lands in an env file.
    !/[\s\u0000-\u001f\u007f]/.test(id)
  );
}

/**
 * Reads a model list from untrusted input (a request body, a stored file):
 * trims ids, drops invalid and duplicate ones, keeps only known fields, caps
 * the length. Returns null when the input is not a list at all.
 */
export function normalizeProviderModels(
  input: unknown,
): ProviderModelEntry[] | null {
  if (!Array.isArray(input)) return null;
  const out: ProviderModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_PROVIDER_MODELS) break;
    const record =
      typeof raw === 'string'
        ? { id: raw }
        : raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : null;
    if (!record || typeof record.id !== 'string') continue;
    const id = record.id.trim();
    if (!isValidModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const entry: ProviderModelEntry = { id };
    if (record.hidden === true) entry.hidden = true;
    if (
      typeof record.effort === 'string' &&
      (MODEL_EFFORTS as readonly string[]).includes(record.effort)
    ) {
      entry.effort = record.effort as ModelEffort;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The models a connection offers. A connection saved before it had a list
 * offers its one model; a pass-through connection (no model) offers none and
 * lets the client pick. The default model is always in the list and never
 * hidden, since the connection runs on it when nothing else is chosen.
 */
export function effectiveProviderModels(provider: {
  anthropicModel: string;
  models?: readonly ProviderModelEntry[] | null;
}): ProviderModelEntry[] {
  const models = normalizeProviderModels(provider.models ?? []) ?? [];
  const defaultModel = provider.anthropicModel.trim();
  if (!defaultModel) return models;
  const index = models.findIndex((entry) => entry.id === defaultModel);
  if (index < 0) return [{ id: defaultModel }, ...models];
  if (models[index].hidden) {
    const { hidden: _hidden, ...visible } = models[index];
    models[index] = visible;
  }
  return models;
}

/**
 * Adds the newly discovered ids to a list without touching what is there.
 * New models come in hidden, so a refresh never changes the chat picker by
 * itself; the user shows the ones they want.
 */
export function mergeDiscoveredModels(
  existing: readonly ProviderModelEntry[],
  discoveredIds: readonly string[],
): { models: ProviderModelEntry[]; added: string[] } {
  const known = new Set(
    existing.map((entry) => splitOneMillionSuffix(entry.id).model),
  );
  const added: string[] = [];
  for (const raw of discoveredIds) {
    const id = raw.trim();
    if (!isValidModelId(id) || known.has(splitOneMillionSuffix(id).model)) {
      continue;
    }
    known.add(splitOneMillionSuffix(id).model);
    added.push(id);
  }
  const room = Math.max(0, MAX_PROVIDER_MODELS - existing.length);
  const kept = added.slice(0, room);
  return {
    models: [...existing, ...kept.map((id) => ({ id, hidden: true }))],
    added: kept,
  };
}

// ─── Connection tests ──────────────────────────────────────────

/** The outcome of the last connection test, kept with the connection. */
export interface ProviderTestRecord {
  ok: boolean;
  /** Null when the test passed. */
  code: ProviderErrorCode | null;
  /** HTTP status of the failing request; null for network errors. */
  status: number | null;
  /** The model the test ran on; null for account checks (subscriptions). */
  model: string | null;
  latencyMs: number | null;
  /** ISO time the test finished. */
  at: string;
}

/** A model a vendor's list endpoint returned. */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

// ─── Presets ───────────────────────────────────────────────────

export interface ModelPresetModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

/**
 * A vendor's Anthropic-compatible endpoint. Every preset takes its key as
 * `Authorization: Bearer`; the server still falls back to `x-api-key` when a
 * key is refused, and records whichever the endpoint accepted.
 */
export interface ModelPreset {
  id: string;
  name: string;
  nameEn: string;
  /** Only orders the list; every preset stays available everywhere. */
  region: 'cn' | 'global' | 'any';
  baseUrl: string;
  /** Model list endpoint, when it is not `<baseUrl>/v1/models`. */
  modelsUrl?: string;
  /** Where the vendor hands out keys. */
  keyUrl?: string;
  docsUrl?: string;
  /** Models known to work; all of them are offered by a new connection. */
  models: readonly ModelPresetModel[];
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameEn: 'OpenRouter',
    region: 'global',
    baseUrl: 'https://openrouter.ai/api',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl:
      'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    models: [
      { id: 'z-ai/glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576 },
      { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
      {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1_048_576,
      },
      { id: 'qwen/qwen3.8-27b', name: 'Qwen3.8 27B', contextWindow: 1_000_000 },
      {
        id: 'qwen/qwen3.8-2.4t-a95b',
        name: 'Qwen3.8 2.4T A95B',
        contextWindow: 1_048_576,
      },
      {
        id: 'qwen/qwen3.8-flash',
        name: 'Qwen3.8 Flash',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    region: 'any',
    baseUrl: 'https://api.deepseek.com/anthropic',
    modelsUrl: 'https://api.deepseek.com/models',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/guides/anthropic_api',
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek V4.1 Flash',
        contextWindow: 1_048_576,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'zhipu-glm-cn',
    name: '智谱 GLM（中国大陆）',
    nameEn: 'Zhipu GLM (China)',
    region: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/claude',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
    ],
  },
  {
    id: 'zhipu-glm-global',
    name: 'Z.ai GLM (Global)',
    nameEn: 'Z.ai GLM (Global)',
    region: 'global',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/devpack/tool/claude',
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
    ],
  },
  {
    id: 'moonshot-kimi-cn',
    name: 'Kimi (Moonshot 中国大陆)',
    nameEn: 'Kimi (Moonshot China)',
    region: 'cn',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    modelsUrl: 'https://api.moonshot.cn/v1/models',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs/guide/agent-support',
    models: [
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_048_576 },
      {
        id: 'kimi-k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: 1_048_576,
      },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
      {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
      },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
    ],
  },
  {
    id: 'moonshot-kimi-global',
    name: 'Kimi (Moonshot Global)',
    nameEn: 'Kimi (Moonshot Global)',
    region: 'global',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    docsUrl: 'https://platform.moonshot.ai/docs/guide/agent-support',
    models: [
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_048_576 },
      {
        id: 'kimi-k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: 1_048_576,
      },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
      {
        id: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
      },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
    ],
  },
  {
    id: 'moonshot-kimi-code',
    name: 'Kimi Code（编程计划包月）',
    nameEn: 'Kimi Code (coding plan)',
    region: 'any',
    baseUrl: 'https://api.kimi.com/coding',
    keyUrl: 'https://www.kimi.com/code/console',
    docsUrl: 'https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents',
    models: [
      { id: 'k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 262_144 },
      {
        id: 'k3.1-pro-highspeed',
        name: 'Kimi K3.1 Pro Highspeed',
        contextWindow: 1_048_576,
      },
      {
        id: 'kimi-for-coding',
        name: 'Kimi K2.8 Preview',
        contextWindow: 1_048_576,
      },
      {
        id: 'kimi-for-coding-highspeed',
        name: 'Kimi K2.7 Code HighSpeed',
        contextWindow: 262_144,
      },
      { id: 'k3', name: 'Kimi K3', contextWindow: 262_144 },
      { id: 'k3-256k', name: 'Kimi K3 (256K)', contextWindow: 262_144 },
    ],
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax（中国大陆）',
    nameEn: 'MiniMax (China)',
    region: 'cn',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    keyUrl:
      'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    docsUrl:
      'https://platform.minimaxi.com/docs/api-reference/responses-create',
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        name: 'MiniMax M3.1 Flash',
        contextWindow: 1_000_000,
      },
      { id: 'MiniMax-M3', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.7-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2', contextWindow: 204_800 },
    ],
  },
  {
    id: 'minimax-global',
    name: 'MiniMax (Global)',
    nameEn: 'MiniMax (Global)',
    region: 'global',
    baseUrl: 'https://api.minimax.io/anthropic',
    keyUrl:
      'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/responses-create',
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        name: 'MiniMax M3.1 Flash',
        contextWindow: 1_000_000,
      },
      { id: 'MiniMax-M3', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.7-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1', contextWindow: 204_800 },
      { id: 'MiniMax-M2.1-highspeed', contextWindow: 204_800 },
      { id: 'MiniMax-M2', contextWindow: 204_800 },
    ],
  },
  {
    id: 'aliyun-bailian-coding',
    name: '阿里云百炼 Coding Plan（包月）',
    nameEn: 'Alibaba Cloud Bailian Coding Plan',
    region: 'cn',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    modelsUrl: 'https://coding.dashscope.aliyuncs.com/v1/models',
    keyUrl:
      'https://bailian.console.aliyun.com/cn-beijing/?tab=plan#/efm/subscription/coding-plan',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
    models: [
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', contextWindow: 983_616 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 229_376 },
      { id: 'glm-5', name: 'GLM-5', contextWindow: 169_984 },
      { id: 'MiniMax-M2.5', contextWindow: 196_608 },
      {
        id: 'qwen3-coder-next',
        name: 'Qwen3 Coder Next',
        contextWindow: 204_800,
      },
      {
        id: 'qwen3-coder-plus',
        name: 'Qwen3-Coder-Plus',
        contextWindow: 997_952,
      },
    ],
  },
  {
    id: 'aliyun-bailian-token-plan-cn',
    name: '阿里云百炼 Token Plan（个人版）',
    nameEn: 'Alibaba Cloud Bailian Token Plan (Personal)',
    region: 'cn',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    modelsUrl:
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
    keyUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
    docsUrl:
      'https://help.aliyun.com/zh/model-studio/token-plan-personal-overview',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 983_616 },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 983_616 },
      { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: 983_616 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', contextWindow: 983_616 },
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1_000_000,
      },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576 },
    ],
  },
  {
    id: 'aliyun-bailian-token-plan-team-cn',
    name: '阿里云百炼 Token Plan（团队版）',
    nameEn: 'Alibaba Cloud Bailian Token Plan (Team)',
    region: 'cn',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    modelsUrl:
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
    keyUrl:
      'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/enterprise',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-team-overview',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 983_616 },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 983_616 },
      { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: 983_616 },
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', contextWindow: 983_616 },
      { id: 'qwen3.6-flash', name: 'Qwen3.6-Flash', contextWindow: 983_616 },
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextWindow: 1_000_000,
      },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        contextWindow: 1_000_000,
      },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 229_376 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 229_376 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 229_376 },
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_048_576 },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 169_984 },
      { id: 'glm-5', name: 'GLM-5', contextWindow: 169_984 },
      { id: 'MiniMax-M2.5', contextWindow: 196_608 },
    ],
  },
  {
    id: 'longcat',
    name: 'LongCat',
    nameEn: 'LongCat',
    region: 'any',
    baseUrl: 'https://api.longcat.chat/anthropic',
    modelsUrl: 'https://api.longcat.chat/openai/v1/models',
    keyUrl: 'https://longcat.chat/platform/api_keys',
    docsUrl: 'https://longcat.chat/platform/docs/zh/',
    models: [
      { id: 'LongCat-2.0', name: 'LongCat 2.0', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'zhipu-coding-plan-cn',
    name: '智谱 GLM Coding Plan（中国大陆）',
    nameEn: 'Zhipu GLM Coding Plan (China)',
    region: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start',
    models: [
      { id: 'glm-5.3[1m]', name: 'GLM-5.3 (1M)', contextWindow: 1_000_000 },
      {
        id: 'glm-5.3-flash[1m]',
        name: 'GLM-5.3-Flash (1M)',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'zai-coding-plan-global',
    name: 'Z.ai GLM Coding Plan (Global)',
    nameEn: 'Z.ai GLM Coding Plan (Global)',
    region: 'global',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/devpack/overview',
    models: [
      { id: 'glm-5.3[1m]', name: 'GLM-5.3 (1M)', contextWindow: 1_000_000 },
      {
        id: 'glm-5.3-flash[1m]',
        name: 'GLM-5.3-Flash (1M)',
        contextWindow: 1_000_000,
      },
    ],
  },
  {
    id: 'xiaomi-mimo-api-cn',
    name: '小米 MiMo API（按量）',
    nameEn: 'Xiaomi MiMo API (pay as you go)',
    region: 'cn',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    keyUrl: 'https://platform.xiaomimimo.com/',
    docsUrl:
      'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', contextWindow: 1_048_576 },
      {
        id: 'mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        contextWindow: 1_048_576,
      },
      {
        id: 'mimo-v2.6-pro-ultraspeed',
        name: 'MiMo-V2.6-Pro-UltraSpeed',
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'xiaomi-mimo-token-plan-cn',
    name: '小米 MiMo Token Plan（包月）',
    nameEn: 'Xiaomi MiMo Token Plan',
    region: 'cn',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    keyUrl: 'https://platform.xiaomimimo.com/token-plan',
    docsUrl:
      'https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call',
    models: [
      { id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', contextWindow: 1_048_576 },
      {
        id: 'mimo-v2.6-flash',
        name: 'MiMo-V2.6-Flash',
        contextWindow: 1_048_576,
      },
    ],
  },
  {
    id: 'volcengine-agent-plan',
    name: '火山方舟 Agent Plan',
    nameEn: 'Volcengine Ark Agent Plan',
    region: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan',
    keyUrl: 'https://console.volcengine.com/ark/',
    docsUrl: 'https://docs.volcengine.com/docs/82379/2373738',
    models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
  },
  {
    id: 'volcengine-coding-plan',
    name: '火山方舟 Coding Plan',
    nameEn: 'Volcengine Ark Coding Plan',
    region: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    keyUrl: 'https://console.volcengine.com/ark/',
    docsUrl: 'https://www.volcengine.com/docs/82379/1925114',
    models: [{ id: 'ark-code-latest', name: 'Ark Code Latest' }],
  },
  {
    id: 'tencentcloud-coding-plan',
    name: '腾讯云 Coding Plan',
    nameEn: 'Tencent Cloud Coding Plan',
    region: 'cn',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
    keyUrl: 'https://console.cloud.tencent.com/',
    docsUrl: 'https://cloud.tencent.com/document/product/1823/130092',
    models: [
      { id: 'tc-code-latest', name: 'Tencent Code Latest' },
      { id: 'glm-5', name: 'GLM-5' },
    ],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    nameEn: 'OpenCode Go',
    region: 'global',
    baseUrl: 'https://opencode.ai/zen/go',
    modelsUrl: 'https://opencode.ai/zen/go/v1/models',
    keyUrl: 'https://opencode.ai/auth',
    docsUrl: 'https://opencode.ai/docs/go/',
    models: [
      { id: 'minimax-m3', name: 'MiniMax M3' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
      { id: 'minimax-m2.5', name: 'MiniMax M2.5' },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
    ],
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    nameEn: 'Vercel AI Gateway',
    region: 'global',
    baseUrl: 'https://ai-gateway.vercel.sh',
    modelsUrl: 'https://ai-gateway.vercel.sh/v1/models',
    keyUrl:
      'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys',
    docsUrl: 'https://vercel.com/docs/ai-gateway/coding-agents',
    models: [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (Vercel)' },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4 (Vercel)' },
      { id: 'xai/grok-4.5', name: 'Grok 4.5 (Vercel)' },
    ],
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 Step Plan',
    nameEn: 'StepFun Step Plan',
    region: 'cn',
    baseUrl: 'https://api.stepfun.com/step_plan',
    models: [{ id: 'step-3.7-flash' }],
  },
];

export function getModelPreset(
  id: string | null | undefined,
): ModelPreset | null {
  if (!id) return null;
  return MODEL_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The id a preset model is offered under: 1M-window models get `[1m]`. */
export function presetModelEntryId(model: ModelPresetModel): string {
  return withOneMillionSuffix(
    model.id,
    splitOneMillionSuffix(model.id).oneMillion ||
      (model.contextWindow ?? 0) >= ONE_MILLION_CONTEXT,
  );
}

/** Presets listed for a region first, the rest after, each in catalog order. */
export function sortPresetsForRegion(
  region: 'cn' | 'global',
): readonly ModelPreset[] {
  const rank = (preset: ModelPreset) =>
    preset.region === region ? 0 : preset.region === 'any' ? 1 : 2;
  return [...MODEL_PRESETS].sort((a, b) => rank(a) - rank(b));
}

// ─── Endpoints ─────────────────────────────────────────────────

/**
 * The comparable form of a base URL: lower-case scheme and host, no query,
 * fragment or trailing slash. Returns '' for anything that is not an
 * http(s) URL.
 */
export function normalizeProviderBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * Presets whose endpoint is exactly this URL. Several presets may share one
 * endpoint (a vendor's pay-as-you-go and plan keys), so this is a list; a
 * caller suggests a preset only when exactly one matches.
 */
export function findPresetsByBaseUrl(raw: string): ModelPreset[] {
  const normalized = normalizeProviderBaseUrl(raw);
  if (!normalized) return [];
  return MODEL_PRESETS.filter(
    (preset) => normalizeProviderBaseUrl(preset.baseUrl) === normalized,
  );
}

/**
 * Where a connection's models are listed: the preset's own endpoint when the
 * connection still uses the preset's address, else `/models` after a
 * versioned path, else `/v1/models`. A connection on another address never
 * sends its key to the preset vendor.
 */
export function modelsUrlFor(
  baseUrl: string,
  preset?: Pick<ModelPreset, 'baseUrl' | 'modelsUrl'> | null,
): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (!normalized) return '';
  if (
    preset?.modelsUrl &&
    normalizeProviderBaseUrl(preset.baseUrl) === normalized
  ) {
    return preset.modelsUrl;
  }
  return /\/v\d+$/i.test(normalized)
    ? `${normalized}/models`
    : `${normalized}/v1/models`;
}

/** Warn about endpoint paths Claude Code would turn into `/v1/v1/messages`. */
export function describeBaseUrlProblem(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '请输入完整的 http(s):// 地址';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '只支持 http(s) 地址';
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(path) || /\/v1$/i.test(path)) {
    return 'Claude Code 会自动追加 /v1/messages，端点通常不应以 /v1 或 /v1/messages 结尾';
  }
  return null;
}

// ─── Model list responses ──────────────────────────────────────

const MAX_DISCOVERED_MODELS = 500;

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 && Number.isSafeInteger(floored) ? floored : undefined;
}

/**
 * Reads a vendor's "list models" response: `{data: [...]}` (OpenAI and
 * Anthropic), `{models: [...]}`, or a bare array of objects or strings. Ids
 * come from `id`, `slug`, `model_id` or `model_name`; the display name and
 * context window are read when present. Returns null when the shape is not a
 * list at all, so a caller can tell "no models" from "not a model list".
 */
export function parseModelList(json: unknown): DiscoveredModel[] | null {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data as unknown[])
        : Array.isArray((json as { models?: unknown }).models)
          ? ((json as { models: unknown[] }).models as unknown[])
          : null
      : null;
  if (!list) return null;
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= MAX_DISCOVERED_MODELS) break;
    const record =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : null;
    const rawId =
      typeof item === 'string'
        ? item
        : record
          ? [record.id, record.slug, record.model_id, record.model_name].find(
              (value): value is string => typeof value === 'string',
            )
          : undefined;
    const id = rawId?.trim();
    if (!id || !isValidModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const model: DiscoveredModel = { id };
    const name = [record?.display_name, record?.name].find(
      (value): value is string => typeof value === 'string' && !!value.trim(),
    );
    if (name && name.trim() !== id) model.name = name.trim();
    const contextWindow = record
      ? [
          record.context_length,
          record.context_window,
          record.max_context_length,
          record.max_input_tokens,
        ]
          .map(positiveInteger)
          .find((value) => value !== undefined)
      : undefined;
    if (contextWindow) model.contextWindow = contextWindow;
    out.push(model);
  }
  return out;
}

// ─── Upstream errors ───────────────────────────────────────────

export const PROVIDER_ERROR_CODES = [
  'AUTH_INVALID',
  'AUTH_FORBIDDEN',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'MODEL_NOT_FOUND',
  'ENDPOINT_NOT_FOUND',
  'CONTEXT_TOO_LONG',
  'WIRE_INCOMPATIBLE',
  'UPSTREAM_ERROR',
  'UPSTREAM_UNREACHABLE',
  'TIMEOUT',
  'UNKNOWN',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorInput {
  /** HTTP status; absent when the request never got an answer. */
  status?: number;
  /** The error body; only the first few KB are read. */
  bodyText?: string;
  /** A network error code (ECONNREFUSED, ENOTFOUND, TimeoutError, ...). */
  networkErrorCode?: string;
}

export interface ProviderErrorClassification {
  code: ProviderErrorCode;
  /** Whether trying the same request again later may succeed. */
  retryable: boolean;
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ABORT_ERR',
  'TimeoutError',
  'AbortError',
]);

const MODEL_NOT_FOUND_RE =
  /model[^\n]{0,80}(not.{0,4}(found|exist)|does not exist|invalid|unknown|unsupported)|model_not_found|invalid model|模型不存在/i;
const CONTEXT_TOO_LONG_RE =
  /prompt is too long|maximum (?:context|prompt) length|context.{0,20}(length|window).{0,40}(exceed|too)|context_length_exceeded|(?:令牌|token)数.{0,6}超(?:出|过)|超出.{0,6}上下文/i;
const WIRE_RE =
  /(unknown|unexpected|unsupported|extra|unrecognized).{0,16}(field|parameter|argument|inputs?|property|request param)|extra inputs are not permitted|invalid_request_error[^\n]{0,120}(field|param)/i;
// A bad credential, said outright. Not a bare 「令牌」 or "token": gateways
// say 令牌 for a valid key that may not use a model, and max_tokens errors
// contain "invalid ... token".
const AUTH_RE =
  /\binvalid[\s:'"_-]{0,3}(?:(?:x-)?api[\s_-]?key|(?:access|auth|authentication|bearer)?[\s_-]?token)\b|authentication_error|\bunauthorized\b|api key not valid|incorrect api key|(?:令牌|密钥)(?:无效|已过期|不存在|错误)|无效的?(?:令牌|密钥)|鉴权失败|认证失败/i;
const QUOTA_RE =
  /insufficient.{0,20}(balance|quota|credit|funds)|credit balance is too low|quota.{0,20}exceed|exceed.{0,20}quota|余额不足|额度.{0,6}(?:不足|用尽|耗尽|用完)|欠费/i;

/**
 * Classifies one failed upstream request. Network errors decide first, then
 * the status, then the wording of the body. An unknown network error stays
 * UNKNOWN rather than sending the user off to check their network.
 */
export function classifyProviderError(
  input: ProviderErrorInput,
): ProviderErrorClassification {
  const { status, networkErrorCode } = input;
  const body = (input.bodyText ?? '').slice(0, 4096);

  if (networkErrorCode) {
    if (TIMEOUT_CODES.has(networkErrorCode)) {
      return { code: 'TIMEOUT', retryable: true };
    }
    if (UNREACHABLE_CODES.has(networkErrorCode)) {
      return { code: 'UPSTREAM_UNREACHABLE', retryable: true };
    }
    return { code: 'UNKNOWN', retryable: false };
  }
  if (status === undefined) return { code: 'UNKNOWN', retryable: false };

  if (status === 401) {
    // Some gateways answer an exhausted key's quota with 401.
    return {
      code: QUOTA_RE.test(body) ? 'QUOTA_EXCEEDED' : 'AUTH_INVALID',
      retryable: false,
    };
  }
  if (status === 402) return { code: 'QUOTA_EXCEEDED', retryable: false };
  if (status === 403) {
    if (QUOTA_RE.test(body))
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    return {
      code: AUTH_RE.test(body) ? 'AUTH_INVALID' : 'AUTH_FORBIDDEN',
      retryable: false,
    };
  }
  if (status === 429 || status === 529) {
    if (QUOTA_RE.test(body))
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    return { code: 'RATE_LIMITED', retryable: true };
  }
  if (status === 404) {
    return {
      code: MODEL_NOT_FOUND_RE.test(body)
        ? 'MODEL_NOT_FOUND'
        : 'ENDPOINT_NOT_FOUND',
      retryable: false,
    };
  }
  if (status === 400 || status === 422) {
    if (MODEL_NOT_FOUND_RE.test(body)) {
      return { code: 'MODEL_NOT_FOUND', retryable: false };
    }
    if (CONTEXT_TOO_LONG_RE.test(body)) {
      return { code: 'CONTEXT_TOO_LONG', retryable: false };
    }
    if (QUOTA_RE.test(body))
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    if (AUTH_RE.test(body)) return { code: 'AUTH_INVALID', retryable: false };
    if (WIRE_RE.test(body)) {
      return { code: 'WIRE_INCOMPATIBLE', retryable: false };
    }
    return { code: 'UNKNOWN', retryable: false };
  }
  if (status >= 500) return { code: 'UPSTREAM_ERROR', retryable: true };
  return { code: 'UNKNOWN', retryable: false };
}

/** What a user is told about each failure: a title and the next step. */
export const PROVIDER_ERROR_COPY: Record<
  ProviderErrorCode,
  { title: string; hint: string }
> = {
  AUTH_INVALID: {
    title: '密钥无效',
    hint: '检查 API Key 是否完整、未过期，并确认它属于这家服务商。',
  },
  AUTH_FORBIDDEN: {
    title: '没有访问权限',
    hint: '密钥有效，但账号没有开通这个模型或地区。到服务商控制台确认套餐和模型权限。',
  },
  RATE_LIMITED: {
    title: '请求过于频繁',
    hint: '服务商正在限流或过载，稍后再试。',
  },
  QUOTA_EXCEEDED: {
    title: '余额或额度不足',
    hint: '到服务商控制台充值，或查看套餐额度是否用完。',
  },
  MODEL_NOT_FOUND: {
    title: '模型不存在',
    hint: '服务商不认识这个模型名。换一个模型，或重新获取模型列表。',
  },
  ENDPOINT_NOT_FOUND: {
    title: '地址不对',
    hint: '这个地址上没有 Anthropic 兼容接口。核对地址，它通常不以 /v1 结尾。',
  },
  CONTEXT_TOO_LONG: {
    title: '上下文超长',
    hint: '请求超过了模型的上下文上限。',
  },
  WIRE_INCOMPATIBLE: {
    title: '接口不兼容',
    hint: '这个地址不完全兼容 Anthropic Messages 协议，Claude Code 可能无法正常工作。',
  },
  UPSTREAM_ERROR: {
    title: '服务商出错',
    hint: '服务商返回了服务器错误，稍后再试。',
  },
  UPSTREAM_UNREACHABLE: {
    title: '连不上服务商',
    hint: '无法连接这个地址。检查地址拼写，以及服务器能否访问外网。',
  },
  TIMEOUT: {
    title: '连接超时',
    hint: '服务商没有在限定时间内响应，稍后再试。',
  },
  UNKNOWN: {
    title: '未知错误',
    hint: '展开原始信息查看服务商返回的内容。',
  },
};
