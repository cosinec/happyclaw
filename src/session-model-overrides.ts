/**
 * What a conversation chose in the chat composer, as a runner launch sees it.
 *
 * Every model configuration offers a list of models, and a conversation may
 * pin one of them; a ChatGPT subscription offers its account catalog instead
 * and also lets the conversation pick a reasoning effort. The choice is stored
 * when it is made (session_model_selections) but can go stale before the next
 * launch: the list or the catalog moves, the plan changes, the person who
 * chose loses a permission. Everything here re-checks it against the world as
 * it is now, and degrades to the configuration's own default instead of
 * failing the turn.
 */
import { logger } from './logger.js';
import {
  getSession,
  getSessionModel,
  getSessionModelSelectionDetail,
  getUserById,
} from './db.js';
import {
  normalizeCodexEffort,
  resolveCodexModel,
} from './codex-gateway/convert-request.js';
import {
  clampCodexEffortWithCatalog,
  codexPickableEfforts,
  resolveCodexDefaultEffort,
  resolveCodexSessionChoice,
} from './codex-gateway/model-catalog.js';
import { listCodexModelsForProvider } from './codex-gateway/model-catalog-sync.js';
import { hasPermission } from './permissions.js';
import {
  findProviderModel,
  providerModels,
  type UnifiedProvider,
} from './runtime-config.js';

type ChatGptProvider = Pick<
  UnifiedProvider,
  'id' | 'anthropicModel' | 'codexOAuthCredentials'
>;

/** A configuration of any kind, with what it offers to pick from. */
type ModelConfiguration = ChatGptProvider &
  Pick<UnifiedProvider, 'anthropicBaseUrl' | 'models'>;

export interface SessionLaunchOverrides {
  /** Upstream model to run on instead of the configuration's own. */
  model?: string;
  /** Reasoning effort to apply, handed to the gateway out of band. */
  effort?: string;
}

/**
 * Whether the person who made a choice may pick efforts above the ceiling,
 * judged by what they may do now rather than when they chose.
 */
export function canChooseBeyondEffortCeiling(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  const user = getUserById(userId);
  return (
    !!user &&
    user.status === 'active' &&
    hasPermission(user, 'manage_system_config')
  );
}

/** The model a ChatGPT configuration runs when nothing else is chosen. */
export function chatGptDefaultModel(
  provider: Pick<UnifiedProvider, 'anthropicModel'>,
): string {
  return resolveCodexModel(undefined, provider.anthropicModel);
}

/**
 * The model and effort this conversation runs on within `provider`, or nothing
 * when it chose none or the choice is gone stale.
 */
export function resolveSessionLaunchOverrides(
  groupFolder: string,
  agentId: string | null | undefined,
  provider: ModelConfiguration,
  options: { warn?: boolean } = {},
): SessionLaunchOverrides {
  const detail = getSessionModelSelectionDetail(groupFolder, agentId);
  if (
    !detail ||
    detail.modelConfigId !== provider.id ||
    (!detail.model && !detail.effort)
  ) {
    return {};
  }
  if (!provider.codexOAuthCredentials) {
    // Only a model is picked here, from the configuration's own list; hidden
    // models count, since hiding only leaves a model out of the picker.
    if (!detail.model) return {};
    if (findProviderModel(provider, detail.model)) {
      return { model: detail.model };
    }
    if (options.warn !== false) {
      logger.warn(
        {
          groupFolder,
          agentId: agentId || null,
          providerId: provider.id,
          model: detail.model,
        },
        'Conversation model is no longer offered by its configuration; following the configuration default',
      );
    }
    return {};
  }
  const { models, source } = listCodexModelsForProvider(provider);
  const choice = resolveCodexSessionChoice({
    catalog: models,
    defaultModel: chatGptDefaultModel(provider),
    model: detail.model,
    effort: detail.effort,
    canExceedCeiling: canChooseBeyondEffortCeiling(detail.updatedBy),
    strict: false,
    authoritative: source === 'live',
  });
  if (choice.problems.length > 0 && options.warn !== false) {
    logger.warn(
      {
        groupFolder,
        agentId: agentId || null,
        providerId: provider.id,
        problems: choice.problems,
      },
      'Conversation model or effort is no longer valid; following the configuration default',
    );
  }
  return {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {}),
  };
}

/**
 * The model an Agent's binding names within `provider`, or nothing when it
 * names none or the configuration no longer offers it: the Agent then runs
 * the configuration's default instead of failing the turn. A ChatGPT model is
 * judged like a stored conversation choice, against the account catalog.
 */
export function resolveAgentLaunchModel(
  provider: ModelConfiguration,
  agentModel: string | null | undefined,
  context: {
    groupFolder: string;
    agentId?: string | null;
    warn?: boolean;
  },
): string | undefined {
  if (!agentModel) return undefined;
  let model: string | null;
  if (provider.codexOAuthCredentials) {
    const { models, source } = listCodexModelsForProvider(provider);
    model = resolveCodexSessionChoice({
      catalog: models,
      defaultModel: chatGptDefaultModel(provider),
      model: agentModel,
      canExceedCeiling: false,
      strict: false,
      authoritative: source === 'live',
    }).model;
  } else {
    model = findProviderModel(provider, agentModel) ? agentModel : null;
  }
  if (!model && context.warn !== false) {
    logger.warn(
      {
        groupFolder: context.groupFolder,
        agentId: context.agentId || null,
        providerId: provider.id,
        model: agentModel,
      },
      'Agent model is no longer offered by its configuration; following the configuration default',
    );
  }
  return model ?? undefined;
}

/**
 * Whether a launch on `effectiveModel` changes the model under a Session that
 * still has an SDK session to resume. Encrypted reasoning only verifies for the
 * model that issued it, so such a session cannot simply continue; sessions of
 * every other configuration follow the same rule, so one SDK session always
 * runs on one model.
 *
 * A session from before models were tracked ran on the configuration's own
 * model; one without an SDK session has nothing to carry over.
 */
export function sessionModelHasChanged(
  groupFolder: string,
  agentId: string | null | undefined,
  effectiveModel: string,
  providerDefaultModel: string,
): boolean {
  const recorded = getSessionModel(groupFolder, agentId);
  if (recorded) return recorded !== effectiveModel;
  return (
    !!getSession(groupFolder, agentId) &&
    providerDefaultModel !== effectiveModel
  );
}

/**
 * The model a ChatGPT launch resolves to. Claude model names (a pool's
 * fallback tier, the SDK's own defaults) are served by the configuration's
 * model, exactly as the gateway maps them.
 */
export function chatGptLaunchModel(
  requestedModel: string | undefined,
  provider: Pick<UnifiedProvider, 'anthropicModel'>,
): string {
  return resolveCodexModel(requestedModel, provider.anthropicModel);
}

// ─── What the chat composer is shown ───────────────────────────────────

/** A model a conversation or an Agent may pick within a configuration. */
export interface ConnectionModelChoice {
  id: string;
  /** Left out of the chat picker; an explicit choice may still name it. */
  hidden: boolean;
}

/**
 * The models a configuration offers to pick from: its own list, or a ChatGPT
 * subscription's account catalog, where nothing is hidden.
 */
export function listConnectionModels(
  provider: ModelConfiguration,
): ConnectionModelChoice[] {
  if (provider.codexOAuthCredentials) {
    return listCodexModelsForProvider(provider).models.map((entry) => ({
      id: entry.value,
      hidden: false,
    }));
  }
  return providerModels(provider).map((entry) => ({
    id: entry.id,
    hidden: entry.hidden === true,
  }));
}

export interface CodexModelChoice {
  /** The upstream model slug. */
  value: string;
  label: string;
  /** Efforts the chooser may pick on this model, low → ultra. */
  efforts: string[];
  /** The effort this model runs at when nothing is picked. */
  defaultEffort: string;
}

/** The models and efforts one ChatGPT login offers a conversation. */
export interface CodexSelectionView {
  /** The configuration's own model: what "default" runs. */
  defaultModel: string;
  defaultEffort: string;
  /** Where the list came from; `live` is the account's own. */
  source: string;
  /** The login was rejected and has to be redone before it can run. */
  needsReauth: boolean;
  models: CodexModelChoice[];
}

/**
 * The picker's view of one ChatGPT login for one chooser. Efforts above the
 * ceiling are left out unless the chooser may pick them, but a default that
 * sits above it is reported as is: it is what the conversation really runs.
 */
export function buildCodexSelectionView(
  provider: ChatGptProvider &
    Pick<UnifiedProvider, 'customEnv' | 'codexOAuthLastRefreshError'>,
  context: { canExceedCeiling: boolean; agentEffort?: string },
): CodexSelectionView {
  const { models, source } = listCodexModelsForProvider(provider);
  const providerEffort = provider.customEnv?.CODEX_REASONING_EFFORT;
  // Without a pick the conversation runs at the Agent's effort when it has
  // one, else the configuration's, as the gateway resolves it.
  const defaultEffortOn = (model: string): string =>
    context.agentEffort
      ? clampCodexEffortWithCatalog(
          models,
          model,
          normalizeCodexEffort(context.agentEffort),
        )!
      : resolveCodexDefaultEffort(models, model, providerEffort);
  const defaultModel = chatGptDefaultModel(provider);
  return {
    defaultModel,
    defaultEffort: defaultEffortOn(defaultModel),
    source,
    needsReauth:
      provider.codexOAuthLastRefreshError?.kind === 'reauth_required',
    models: models.map((entry) => ({
      value: entry.value,
      label: entry.value,
      efforts: codexPickableEfforts(entry.efforts, context.canExceedCeiling),
      defaultEffort: defaultEffortOn(entry.value),
    })),
  };
}

/** The picker's validated reading of what a conversation stored. */
export function readStoredChoice(
  view: CodexSelectionView,
  stored: { model: string | null; effort: string | null },
  canExceedCeiling: boolean,
): { model: string | null; effort: string | null } {
  const { model, effort } = resolveCodexSessionChoice({
    catalog: view.models.map(({ value, label, efforts }) => ({
      value,
      label,
      efforts,
    })),
    defaultModel: view.defaultModel,
    model: stored.model,
    effort: stored.effort,
    canExceedCeiling,
    strict: false,
    authoritative: view.source === 'live',
  });
  return { model, effort };
}

// ─── Making a choice ───────────────────────────────────────────────────

export type SessionChoiceRejectionCode =
  | 'MODEL_SELECTION_UNSUPPORTED'
  | 'MODEL_NOT_IN_CONNECTION'
  | 'MODEL_UNAVAILABLE'
  | 'EFFORT_UNSUPPORTED'
  | 'EFFORT_RESTRICTED';

export interface SessionChoiceRejection {
  error: string;
  code: SessionChoiceRejectionCode;
}

/**
 * Check a model and effort a chooser submits for `provider`. Unlike a stored
 * choice, a new one must be confirmed by the configuration's model list (a
 * ChatGPT subscription: its catalog), and efforts, which only a ChatGPT
 * subscription offers, above the ceiling need the chooser's
 * `manage_system_config`.
 */
export function validateSessionChoice(
  provider: ModelConfiguration,
  requested: { model?: string | null; effort?: string | null },
  chooser: Parameters<typeof hasPermission>[0],
):
  | { ok: true; model: string | null; effort: string | null }
  | { ok: false; rejection: SessionChoiceRejection } {
  if (!provider.codexOAuthCredentials) {
    if (requested.effort) {
      return {
        ok: false,
        rejection: {
          error: '该模型配置不支持选择推理档位',
          code: 'MODEL_SELECTION_UNSUPPORTED',
        },
      };
    }
    const model = requested.model?.trim() || null;
    // Hidden models count: the picker leaves them out, an explicit choice may
    // still name one.
    if (model && !findProviderModel(provider, model)) {
      return {
        ok: false,
        rejection: {
          error: `模型 ${model} 不在该模型配置的模型列表中，请刷新后重新选择`,
          code: 'MODEL_NOT_IN_CONNECTION',
        },
      };
    }
    return { ok: true, model, effort: null };
  }
  const { models, source } = listCodexModelsForProvider(provider);
  const choice = resolveCodexSessionChoice({
    catalog: models,
    defaultModel: chatGptDefaultModel(provider),
    model: requested.model,
    effort: requested.effort,
    canExceedCeiling: hasPermission(chooser, 'manage_system_config'),
    strict: true,
    authoritative: source === 'live',
  });
  const problem = choice.problems[0];
  if (!problem) return { ok: true, model: choice.model, effort: choice.effort };
  switch (problem.kind) {
    case 'model_unavailable':
      return {
        ok: false,
        rejection: {
          error: `该账号当前不可使用模型 ${problem.model}，请刷新后重新选择`,
          code: 'MODEL_UNAVAILABLE',
        },
      };
    case 'effort_unsupported':
      return {
        ok: false,
        rejection: {
          error: `模型 ${problem.model} 不支持推理档位 ${problem.effort}`,
          code: 'EFFORT_UNSUPPORTED',
        },
      };
    case 'effort_restricted':
      return {
        ok: false,
        rejection: {
          error: `推理档位 ${problem.effort} 仅限具备系统配置权限的用户选择`,
          code: 'EFFORT_RESTRICTED',
        },
      };
  }
}
