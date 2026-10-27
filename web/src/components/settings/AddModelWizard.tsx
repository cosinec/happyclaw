import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  Key,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import {
  describeBaseUrlProblem,
  findPresetsByBaseUrl,
  getModelPreset,
  normalizeProviderBaseUrl,
  sortPresetsForRegion,
  type ModelPreset,
} from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import { api } from '../../api/client';
import type { ProviderEnvImport } from '../../utils/provider-env-import';
import { isOneMillionContextModel } from '../../utils/provider-model';
import {
  codexFallbackEffort,
  codexModelEfforts,
  useCodexCatalog,
} from './codex-catalog';
import { ConnectionTestResult } from './ConnectionTestResult';
import {
  PROVIDERS_API,
  discoverModels,
  requestError,
  testConnection,
  testOutcome,
  type ConnectionDraftBody,
  type ProviderAuthHeader,
  type TestOutcome,
} from './model-connections';
import {
  ModelPicker,
  addCandidates,
  candidateId,
  type DiscoveryState,
  type ModelCandidate,
} from './ModelPicker';
import { OAuthLoginPanel } from './OAuthLoginPanel';
import { ProviderEnvImportPanel } from './ProviderEnvImportPanel';
import {
  EMPTY_PROVIDER_ENV,
  buildProviderCustomEnv,
  type ProviderEnvDraft,
} from './ProviderEnvEditor';
import { SettingsField } from './SettingsLayout';
import type { UnifiedProviderPublic } from './types';

export type WizardSource =
  | { kind: 'claude' }
  | { kind: 'chatgpt' }
  | { kind: 'anthropic_api' }
  | { kind: 'preset'; presetId: string }
  | { kind: 'custom' };

type Step = 'source' | 'connect' | 'models' | 'save';

const STEPS: ReadonlyArray<{ key: Step; label: string }> = [
  { key: 'source', label: '选择来源' },
  { key: 'connect', label: '连接' },
  { key: 'models', label: '选择模型' },
  { key: 'save', label: '测试并保存' },
];

/**
 * Model aliases Claude Code resolves to the newest version. A Claude
 * subscription offers these when its model list cannot be read.
 */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

const OFFICIAL_PASS_THROUGH = {
  label: '不指定（由 Claude Code 选择）',
  hint: 'Claude Code 使用它自己的默认模型；别名会自动解析为最新版本。',
};
const RELAY_PASS_THROUGH = {
  label: '不指定（透传）',
  hint: 'Claude Code 继续请求 Claude 模型名，由中转站自行路由。',
};

const RECOMMENDED: ReadonlyArray<{
  source: WizardSource;
  title: string;
  description: string;
  icon: typeof ShieldCheck;
}> = [
  {
    source: { kind: 'claude' },
    title: 'Claude 订阅',
    description: '用 Claude Pro / Max 账号登录，或粘贴 setup-token',
    icon: ShieldCheck,
  },
  {
    source: { kind: 'chatgpt' },
    title: 'ChatGPT 订阅',
    description: '用 ChatGPT Plus / Pro 账号登录，经内嵌网关运行',
    icon: MessageSquareText,
  },
  {
    source: { kind: 'anthropic_api' },
    title: 'Anthropic API Key',
    description: '按量计费的 Anthropic 官方 API',
    icon: Key,
  },
];

const PRESETS = sortPresetsForRegion('cn');

function sourceKey(source: WizardSource | null): string {
  if (!source) return '';
  return source.kind === 'preset' ? `preset:${source.presetId}` : source.kind;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return '';
  }
}

export interface AddModelWizardProps {
  /** Connections already enabled; decides whether the new one joins the pool. */
  enabledCount: number;
  /** Always enable the new connection (first-run setup needs one enabled). */
  forceEnabled?: boolean;
  /** The connection was saved; `verified` = its test passed. */
  onDone: (provider: UnifiedProviderPublic, verified: boolean) => void;
  /** An OAuth login created the connection before the wizard finished. */
  onConnectionCreated?: (provider: UnifiedProviderPublic) => void;
  /** Absent on the setup page, which has its own way out. */
  onCancel?: () => void;
  /** Inside a dialog the footer sticks to the dialog's bottom edge. */
  layout?: 'dialog' | 'page';
  /** Reports whether a request is in flight, so a host can hold its close. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * The one way to add a model connection: pick where the models come from,
 * connect, choose the models, then test and save. Settings and the first-run
 * setup page share it. The draft survives going back and forth; a response
 * that arrives after its inputs changed is dropped.
 */
export function AddModelWizard({
  enabledCount,
  forceEnabled = false,
  onDone,
  onConnectionCreated,
  onCancel,
  layout = 'dialog',
  onBusyChange,
}: AddModelWizardProps) {
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<WizardSource | null>(null);
  const [presetQuery, setPresetQuery] = useState('');

  // ─── Connection draft ───
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [credentialInput, setCredentialInput] = useState('');
  const [env, setEnv] = useState<ProviderEnvDraft>(EMPTY_PROVIDER_ENV);
  const [importedName, setImportedName] = useState<string | null>(null);
  const [importedAuthMode, setImportedAuthMode] =
    useState<ProviderAuthHeader | null>(null);
  /** Made by an OAuth callback; later steps update it instead of creating. */
  const [created, setCreated] = useState<UnifiedProviderPublic | null>(null);
  const [detected, setDetected] = useState<ModelPreset | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState('');

  // ─── Models ───
  const [candidates, setCandidates] = useState<ModelCandidate[]>([]);
  const [defaultBase, setDefaultBase] = useState('');
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    status: 'idle',
  });
  const [discoveredAuthMode, setDiscoveredAuthMode] =
    useState<ProviderAuthHeader | null>(null);
  const discoveredFor = useRef<string | null>(null);
  const discoverySeq = useRef(0);
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState('');
  const codexCatalog = useCodexCatalog(
    source?.kind === 'chatgpt' && created ? created.id : null,
  );

  // ─── Test and save ───
  const [name, setName] = useState('');
  const [poolChoice, setPoolChoice] = useState<boolean | null>(null);
  const [test, setTest] = useState<{
    signature: string;
    outcome: TestOutcome | null;
    error: string | null;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const testSeq = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const preset =
    source?.kind === 'preset' ? getModelPreset(source.presetId) : null;
  const kind = source?.kind ?? null;
  const thirdParty = kind === 'preset' || kind === 'custom';
  const effectiveBaseUrl = preset ? preset.baseUrl : baseUrl.trim();
  const baseUrlProblem =
    kind === 'custom' ? describeBaseUrlProblem(baseUrl) : null;
  const picked = candidates.filter((candidate) => candidate.picked);
  const defaultCandidate = candidates.find(
    (candidate) => candidate.picked && candidate.base === defaultBase,
  );
  const defaultModelId =
    kind === 'chatgpt'
      ? codexModel
      : defaultCandidate
        ? candidateId(defaultCandidate)
        : '';
  const passThrough =
    kind === 'claude' || kind === 'anthropic_api'
      ? OFFICIAL_PASS_THROUGH
      : kind === 'custom'
        ? RELAY_PASS_THROUGH
        : null;

  // Whatever identifies the credential and endpoint: a change makes the
  // model list and the test result stale.
  const connectionSignature = JSON.stringify([
    sourceKey(source),
    thirdParty ? effectiveBaseUrl : '',
    kind === 'claude' ? '' : apiKey.trim(),
    kind === 'claude' ? credentialInput.trim() : '',
    created?.id ?? '',
  ]);
  const envResult = thirdParty
    ? buildProviderCustomEnv(true, env)
    : { customEnv: {}, error: null };
  const testSignature = JSON.stringify([
    connectionSignature,
    defaultModelId,
    envResult.customEnv,
  ]);
  const latest = useRef({ connectionSignature, testSignature });
  latest.current = { connectionSignature, testSignature };

  useEffect(() => {
    onBusyChange?.(saving);
  }, [saving, onBusyChange]);

  // ─── Source ───
  const chooseSource = (next: WizardSource) => {
    if (sourceKey(next) !== sourceKey(source)) {
      // A different vendor starts from its own models; models typed by hand
      // (or imported) stay, and so does a default the user set among them.
      const manual = candidates.filter(
        (candidate) => candidate.origin === 'manual',
      );
      const nextPreset =
        next.kind === 'preset' ? getModelPreset(next.presetId) : null;
      const nextCandidates = nextPreset
        ? addCandidates(manual, nextPreset.models, 'preset', true)
        : manual;
      setCandidates(nextCandidates);
      const keepDefault = manual.some(
        (candidate) => candidate.picked && candidate.base === defaultBase,
      );
      if (!keepDefault) {
        setDefaultBase(
          nextPreset
            ? (nextCandidates.find((candidate) => candidate.origin === 'preset')
                ?.base ?? '')
            : '',
        );
      }
      setDiscovery({ status: 'idle' });
      discoveredFor.current = null;
    }
    setSource(next);
    setDetected(null);
    setStep('connect');
  };

  // ─── Custom address detection ───
  useEffect(() => {
    setDetected(null);
    if (kind !== 'custom') return;
    const timer = setTimeout(() => {
      const matches = findPresetsByBaseUrl(baseUrl);
      // Several presets may share one endpoint: suggest only a sure match.
      setDetected(
        matches.length === 1 &&
          normalizeProviderBaseUrl(baseUrl) !== dismissedUrl
          ? matches[0]
          : null,
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [kind, baseUrl, dismissedUrl]);

  const applyImport = (imported: ProviderEnvImport) => {
    if (imported.name) setImportedName(imported.name);
    if (imported.baseUrl) setBaseUrl(imported.baseUrl);
    if (imported.token) setApiKey(imported.token);
    if (imported.authMode) setImportedAuthMode(imported.authMode);
    setEnv({
      overrides: imported.envOverrides,
      rows: Object.entries(imported.customEnv).map(([key, value]) => ({
        key,
        value,
      })),
    });
    if (imported.model) {
      const model = imported.model;
      setCandidates((current) => {
        const without = current.filter((candidate) => candidate.base !== model);
        return [
          ...without,
          {
            base: model,
            oneMillion: imported.oneMillionContext,
            picked: true,
            origin: 'manual',
          },
        ];
      });
      setDefaultBase(model);
    }
  };

  // ─── Discovery ───
  const draftBody = (): ConnectionDraftBody | { providerId: string } => {
    if (created) return { providerId: created.id };
    switch (kind) {
      case 'preset':
        return {
          type: 'third_party',
          presetId: preset!.id,
          anthropicBaseUrl: preset!.baseUrl,
          anthropicAuthToken: apiKey.trim(),
        };
      case 'custom':
        return {
          type: 'third_party',
          anthropicBaseUrl: baseUrl.trim(),
          anthropicAuthToken: apiKey.trim(),
        };
      case 'anthropic_api':
        return { type: 'official', anthropicApiKey: apiKey.trim() };
      default:
        return {
          type: 'official',
          claudeCredentialInput: credentialInput.trim(),
        };
    }
  };

  const runDiscovery = () => {
    const signature = connectionSignature;
    const seq = ++discoverySeq.current;
    discoveredFor.current = signature;
    setDiscovery({ status: 'loading' });
    const official = kind === 'claude' || kind === 'anthropic_api';
    const apply = (next: DiscoveryState, extra: () => void = () => {}) => {
      // A slower answer for an earlier draft must not land on this one.
      if (
        seq !== discoverySeq.current ||
        signature !== latest.current.connectionSignature
      ) {
        return;
      }
      setDiscovery(next);
      extra();
    };
    discoverModels(draftBody())
      .then((result) => {
        if (result.ok) {
          apply(
            {
              status: 'done',
              count: result.models.length,
              builtin: result.source === 'builtin',
            },
            () => {
              // Built-in aliases are what a subscription runs: offer them
              // checked. A vendor's own list arrives unchecked.
              setCandidates((current) =>
                addCandidates(
                  current,
                  result.models,
                  'discovered',
                  result.source === 'builtin',
                ),
              );
              setDiscoveredAuthMode(result.authMode ?? null);
            },
          );
          return;
        }
        apply(
          {
            status: 'failed',
            code: result.code,
            message: result.message || null,
          },
          () => {
            if (official) {
              setCandidates((current) =>
                addCandidates(
                  current,
                  CLAUDE_MODEL_ALIASES.map((id) => ({ id })),
                  'discovered',
                  kind === 'claude',
                ),
              );
            }
          },
        );
      })
      .catch((err) => {
        apply({
          status: 'failed',
          code: 'UNKNOWN',
          message: requestError(err, '获取模型列表失败'),
        });
      });
  };

  useEffect(() => {
    if (
      step === 'models' &&
      kind !== 'chatgpt' &&
      discoveredFor.current !== connectionSignature
    ) {
      runDiscovery();
    }
    // runDiscovery reads the current draft; the signature is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, kind, connectionSignature]);

  // A ChatGPT login starts from the model and effort the server gave it.
  useEffect(() => {
    if (kind !== 'chatgpt' || !created) return;
    const model = created.anthropicModel || codexCatalog.defaultModel;
    setCodexModel(model);
    setCodexEffort(
      codexFallbackEffort(
        codexCatalog,
        model,
        created.codexDefaultEffort ||
          created.customEnv?.CODEX_REASONING_EFFORT ||
          codexCatalog.defaultEffort,
      ),
    );
  }, [kind, created, codexCatalog]);

  // ─── Test ───
  const runTest = () => {
    const signature = testSignature;
    const seq = ++testSeq.current;
    setTesting(true);
    setTest(null);
    const body = created
      ? { providerId: created.id }
      : {
          ...(draftBody() as ConnectionDraftBody),
          anthropicModel: defaultModelId,
          ...(thirdParty ? { customEnv: envResult.customEnv } : {}),
        };
    const settle = (outcome: TestOutcome | null, error: string | null) => {
      if (
        seq !== testSeq.current ||
        signature !== latest.current.testSignature
      ) {
        return;
      }
      setTest({ signature, outcome, error });
      setTesting(false);
    };
    testConnection(body)
      .then((result) => settle(testOutcome(result), null))
      .catch((err) => settle(null, requestError(err, '测试连接失败')));
  };

  // One test per draft: entering the last step tests it once, and only a
  // change to the draft (or the user) asks again.
  useEffect(() => {
    if (step !== 'save' || envResult.error) return;
    if (test?.signature === testSignature) return;
    runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, testSignature]);

  const currentTest = test?.signature === testSignature ? test : null;
  const authInvalid = currentTest?.outcome?.code === 'AUTH_INVALID';
  const verified = currentTest?.outcome?.ok === true;

  // ─── Save ───
  const defaultName =
    created?.name ??
    (preset
      ? preset.name
      : kind === 'custom'
        ? importedName || hostnameOf(baseUrl) || '自定义连接'
        : kind === 'anthropic_api'
          ? 'Anthropic API'
          : 'Claude 订阅');
  const poolDefault = created ? created.enabled : enabledCount === 0;
  const poolEnabled = forceEnabled ? true : (poolChoice ?? poolDefault);

  const save = async () => {
    if (authInvalid || testing || saving) return;
    if (envResult.error) {
      setSaveError(envResult.error);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const trimmedName = name.trim() || defaultName;
    const models = picked.map((candidate) => ({ id: candidateId(candidate) }));
    try {
      let provider: UnifiedProviderPublic;
      if (created) {
        const patch: Record<string, unknown> = {};
        if (trimmedName !== created.name) patch.name = trimmedName;
        if (kind === 'chatgpt') {
          if (codexModel && codexModel !== created.anthropicModel) {
            patch.anthropicModel = codexModel;
          }
          const storedEffort =
            created.codexDefaultEffort ||
            created.customEnv?.CODEX_REASONING_EFFORT;
          if (codexEffort && codexEffort !== storedEffort) {
            patch.customEnv = {
              ...created.customEnv,
              CODEX_REASONING_EFFORT: codexEffort,
            };
          }
        } else {
          patch.models = models;
          patch.anthropicModel = defaultModelId;
        }
        provider = created;
        if (Object.keys(patch).length > 0) {
          provider = (
            await api.patch<{ provider: UnifiedProviderPublic }>(
              `${PROVIDERS_API}/${created.id}`,
              patch,
              120_000,
            )
          ).provider;
        }
        if (provider.enabled !== poolEnabled) {
          provider = (
            await api.post<{ provider: UnifiedProviderPublic }>(
              `${PROVIDERS_API}/${created.id}/toggle`,
              { enabled: poolEnabled },
              120_000,
            )
          ).provider;
        }
      } else {
        const authMode =
          currentTest?.outcome?.authMode ??
          discoveredAuthMode ??
          importedAuthMode;
        const body: Record<string, unknown> = {
          name: trimmedName,
          ...(draftBody() as ConnectionDraftBody),
          anthropicModel: defaultModelId,
          models,
        };
        if (thirdParty) {
          body.customEnv = envResult.customEnv;
          if (authMode) body.anthropicAuthMode = authMode;
        }
        if (forceEnabled || poolChoice !== null) body.enabled = poolEnabled;
        provider = await api.post<UnifiedProviderPublic>(PROVIDERS_API, body);
        // The draft test was not stored; test the saved connection so its
        // status is on record.
        await testConnection({ providerId: provider.id }).catch(() => {});
      }
      onDone(provider, verified);
    } catch (err) {
      setSaveError(requestError(err, '保存模型连接失败'));
    } finally {
      setSaving(false);
    }
  };

  // ─── Navigation ───
  const stepIndex = STEPS.findIndex((item) => item.key === step);
  const canLeaveConnect = (() => {
    switch (kind) {
      case 'claude':
        return !!created || !!credentialInput.trim();
      case 'chatgpt':
        return !!created;
      case 'custom':
        return !!normalizeProviderBaseUrl(baseUrl) && !!apiKey.trim();
      case 'preset':
      case 'anthropic_api':
        return !!apiKey.trim();
      default:
        return false;
    }
  })();
  const goBack = () => {
    setSaveError(null);
    if (step === 'connect') setStep('source');
    else if (step === 'models') setStep('connect');
    else if (step === 'save') setStep('models');
  };
  // Once an OAuth login made the connection, the source is settled.
  const canGoBack = step !== 'source' && !(step === 'connect' && created);

  const handleLoggedIn = (provider: UnifiedProviderPublic | null) => {
    if (!provider) {
      setSaveError('登录成功，但没有收到新连接，请在模型配置列表中查看。');
      return;
    }
    setCreated(provider);
    setName((current) => current || provider.name);
    onConnectionCreated?.(provider);
    setStep('models');
  };

  const footer = (
    <>
      {canGoBack && (
        <Button
          variant="ghost"
          onClick={goBack}
          disabled={saving}
          className="sm:mr-auto"
        >
          <ArrowLeft />
          上一步
        </Button>
      )}
      {onCancel && (
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {created ? '稍后再配置' : '取消'}
        </Button>
      )}
      {step === 'connect' && (
        <Button onClick={() => setStep('models')} disabled={!canLeaveConnect}>
          下一步
        </Button>
      )}
      {step === 'models' && (
        <Button
          onClick={() => setStep('save')}
          disabled={kind === 'chatgpt' && !codexModel}
        >
          下一步
        </Button>
      )}
      {step === 'save' && (
        <Button
          onClick={() => void save()}
          disabled={saving || testing || authInvalid}
        >
          {saving && <Loader2 className="animate-spin" />}
          {verified || testing || authInvalid ? '保存' : '仍然保存（未验证）'}
        </Button>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <StepIndicator current={stepIndex} />

      {step === 'source' && (
        <SourceStep
          query={presetQuery}
          onQueryChange={setPresetQuery}
          onChoose={chooseSource}
        />
      )}

      {step === 'connect' && kind === 'claude' && (
        <div className="space-y-4">
          {created ? (
            <LoggedIn provider={created} />
          ) : (
            <>
              <OAuthLoginPanel service="claude" onSuccess={handleLoggedIn} />
              <SettingsField
                label="或粘贴 setup-token / .credentials.json"
                htmlFor="wizard-claude-credential"
                description={
                  <>
                    支持{' '}
                    <code className="rounded bg-muted px-1 font-mono">
                      claude setup-token
                    </code>{' '}
                    的输出，或{' '}
                    <code className="rounded bg-muted px-1 font-mono">
                      cat ~/.claude/.credentials.json
                    </code>{' '}
                    的 JSON 内容。
                  </>
                }
              >
                <Input
                  id="wizard-claude-credential"
                  type="password"
                  value={credentialInput}
                  onChange={(event) => setCredentialInput(event.target.value)}
                  placeholder="粘贴 setup-token 或 .credentials.json 内容"
                  autoComplete="off"
                />
              </SettingsField>
            </>
          )}
        </div>
      )}

      {step === 'connect' && kind === 'chatgpt' && (
        <div className="space-y-4">
          {created ? (
            <LoggedIn provider={created} />
          ) : (
            <OAuthLoginPanel service="chatgpt" onSuccess={handleLoggedIn} />
          )}
        </div>
      )}

      {step === 'connect' && kind === 'anthropic_api' && (
        <KeyField
          value={apiKey}
          onChange={setApiKey}
          label="Anthropic API Key"
          placeholder="sk-ant-api03-..."
          description={
            <>
              在{' '}
              <ExternalAnchor href="https://console.anthropic.com/settings/keys">
                console.anthropic.com
              </ExternalAnchor>{' '}
              创建 API Key。
            </>
          }
        />
      )}

      {step === 'connect' && kind === 'preset' && preset && (
        <div className="space-y-4">
          <SettingsField
            label="服务地址"
            htmlFor="wizard-preset-url"
            description={
              <button
                type="button"
                className="cursor-pointer text-primary-text underline-offset-2 hover:underline"
                onClick={() => {
                  setBaseUrl(preset.baseUrl);
                  setDismissedUrl(normalizeProviderBaseUrl(preset.baseUrl));
                  chooseSource({ kind: 'custom' });
                }}
              >
                地址不一样？改用自定义地址
              </button>
            }
          >
            <Input
              id="wizard-preset-url"
              value={preset.baseUrl}
              readOnly
              className="font-mono text-muted-foreground"
            />
          </SettingsField>
          <KeyField
            value={apiKey}
            onChange={setApiKey}
            label={`${preset.name} API Key`}
            placeholder="粘贴 API Key"
            description={
              <span className="flex flex-wrap gap-x-3">
                {preset.keyUrl && (
                  <ExternalAnchor href={preset.keyUrl}>
                    获取 API Key
                  </ExternalAnchor>
                )}
                {preset.docsUrl && (
                  <ExternalAnchor href={preset.docsUrl}>
                    接入文档
                  </ExternalAnchor>
                )}
              </span>
            }
          />
        </div>
      )}

      {step === 'connect' && kind === 'custom' && (
        <div className="space-y-4">
          <ProviderEnvImportPanel onApply={applyImport} />
          <SettingsField
            label="服务地址"
            htmlFor="wizard-base-url"
            description={
              baseUrlProblem ? (
                <span className="flex gap-1.5 text-warning">
                  <TriangleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {baseUrlProblem}
                </span>
              ) : (
                'Anthropic Messages 兼容接口的地址，Claude Code 会在后面追加 /v1/messages。'
              )
            }
          >
            <Input
              id="wizard-base-url"
              type="url"
              inputMode="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/anthropic"
              autoComplete="off"
              aria-invalid={baseUrlProblem ? true : undefined}
              className="font-mono"
            />
          </SettingsField>
          {detected && (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-lg bg-primary/10 px-3 py-2.5 sm:flex-row sm:items-center"
            >
              <span className="min-w-0 flex-1 text-caption text-foreground">
                看起来是「{detected.name}」。按预设配置会带上它的推荐模型。
              </span>
              <span className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    chooseSource({ kind: 'preset', presetId: detected.id })
                  }
                >
                  按预设配置
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDismissedUrl(normalizeProviderBaseUrl(baseUrl))
                  }
                >
                  继续自定义
                </Button>
              </span>
            </div>
          )}
          <KeyField
            value={apiKey}
            onChange={setApiKey}
            label="API Key"
            placeholder="粘贴 API Key 或 Token"
            description="认证方式会自动识别：先用 Authorization: Bearer，被拒绝时改用 x-api-key。"
          />
        </div>
      )}

      {step === 'models' && kind === 'chatgpt' && (
        <CodexModelStep
          catalog={codexCatalog}
          model={codexModel}
          effort={codexEffort}
          onModelChange={(model) => {
            setCodexModel(model);
            setCodexEffort(
              codexFallbackEffort(codexCatalog, model, codexEffort),
            );
          }}
          onEffortChange={setCodexEffort}
        />
      )}

      {step === 'models' && kind !== 'chatgpt' && (
        <ModelPicker
          candidates={candidates}
          onCandidatesChange={setCandidates}
          defaultBase={defaultBase}
          onDefaultChange={setDefaultBase}
          passThrough={passThrough}
          discovery={discovery}
          onRetryDiscovery={runDiscovery}
        />
      )}

      {step === 'save' && (
        <div className="space-y-4">
          <SettingsField label="名称" htmlFor="wizard-name">
            <Input
              id="wizard-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={defaultName}
              autoComplete="off"
            />
          </SettingsField>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg px-3 py-2.5 text-caption ring-1 ring-surface-border">
            <dt className="text-muted-foreground">来源</dt>
            <dd className="truncate text-foreground">
              {preset?.name ??
                RECOMMENDED.find((item) => item.source.kind === kind)?.title ??
                '自定义地址'}
              {thirdParty && (
                <span className="ml-2 font-mono text-muted-foreground">
                  {effectiveBaseUrl}
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">默认模型</dt>
            <dd className="truncate font-mono text-foreground">
              {defaultModelId || passThrough?.label || '—'}
            </dd>
            {kind !== 'chatgpt' && (
              <>
                <dt className="text-muted-foreground">模型</dt>
                <dd className="text-foreground">{picked.length} 个</dd>
              </>
            )}
            {thirdParty && (
              <>
                <dt className="text-muted-foreground">运行环境</dt>
                <dd className="text-foreground">
                  系统预填 Claude Code 运行环境：Opus / Sonnet / Haiku / 子
                  Agent 跟随默认模型，压缩窗口{' '}
                  {Number(
                    envResult.customEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW ||
                      (isOneMillionContextModel(defaultModelId)
                        ? 1_000_000
                        : 200_000),
                  ).toLocaleString('en-US')}{' '}
                  tokens
                  {Object.keys(envResult.customEnv).length > 0 &&
                    `；另有 ${Object.keys(envResult.customEnv).length} 项导入的环境变量`}
                  。保存后可在连接设置里调整。
                </dd>
              </>
            )}
          </dl>

          {!forceEnabled && (
            <label
              htmlFor="wizard-pool"
              className="flex cursor-pointer items-start justify-between gap-4 rounded-lg px-3 py-2.5 ring-1 ring-surface-border"
            >
              <span className="min-w-0">
                <span className="block text-label text-foreground">
                  加入自动池
                </span>
                <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
                  没有手动选择模型的对话，会在自动池里的连接之间分配。
                  {poolDefault
                    ? '目前没有其他启用的连接，默认加入。'
                    : '已有启用的连接，默认不加入，不改变现有分配。'}
                </span>
              </span>
              <Switch
                id="wizard-pool"
                checked={poolEnabled}
                onCheckedChange={setPoolChoice}
                aria-label="加入自动池"
              />
            </label>
          )}

          <div className="space-y-2">
            <ConnectionTestResult
              outcome={currentTest?.outcome ?? null}
              testing={testing}
              requestError={currentTest?.error ?? null}
            />
            {authInvalid && (
              <p className="text-caption text-error">
                密钥无效时不能保存。返回「连接」修改密钥后再试。
              </p>
            )}
            {currentTest && !testing && (
              <Button variant="ghost" size="sm" onClick={runTest}>
                <RotateCcw />
                重新测试
              </Button>
            )}
          </div>

          {envResult.error && (
            <p role="alert" className="text-caption text-error">
              {envResult.error}
            </p>
          )}
        </div>
      )}

      {saveError && (
        <p role="alert" className="text-caption leading-5 text-error">
          {saveError}
        </p>
      )}

      {step !== 'source' || onCancel ? (
        layout === 'dialog' ? (
          <DialogFooter>{footer}</DialogFooter>
        ) : (
          <div className="flex flex-col-reverse gap-2 border-t border-surface-border pt-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )
      ) : null}
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <ol
      aria-label="添加步骤"
      className="flex items-center gap-1.5 text-caption text-muted-foreground sm:gap-3"
    >
      {STEPS.map((item, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li
            key={item.key}
            aria-current={active ? 'step' : undefined}
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              active && 'font-medium text-foreground',
            )}
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full text-micro ring-1',
                active
                  ? 'bg-primary text-primary-foreground ring-primary'
                  : done
                    ? 'bg-surface-selected text-foreground ring-surface-selected'
                    : 'ring-surface-border',
              )}
            >
              {done ? <Check className="size-3" /> : index + 1}
            </span>
            {/* Phones show only the current step's name. */}
            <span className={cn('truncate', !active && 'max-sm:hidden')}>
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SourceStep({
  query,
  onQueryChange,
  onChoose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onChoose: (source: WizardSource) => void;
}) {
  const needle = query.trim().toLowerCase();
  const presets = needle
    ? PRESETS.filter((preset) =>
        [preset.name, preset.nameEn, preset.baseUrl].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : PRESETS;
  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-labelledby="wizard-recommended">
        <h3
          id="wizard-recommended"
          className="text-label font-medium text-muted-foreground"
        >
          推荐
        </h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {RECOMMENDED.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.source.kind}
                type="button"
                onClick={() => onChoose(item.source)}
                className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-3 text-left ring-1 ring-surface-border transition-colors duration-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:flex-col sm:gap-2"
              >
                <Icon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-label text-foreground">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="wizard-presets">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            id="wizard-presets"
            className="text-label font-medium text-muted-foreground"
          >
            厂商预设
          </h3>
          <div className="relative w-full sm:w-56">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索服务商"
              aria-label="搜索服务商"
              className="pl-8"
            />
          </div>
        </div>
        <div className="max-h-[min(18rem,40dvh)] divide-y divide-surface-border overflow-y-auto overscroll-contain rounded-lg ring-1 ring-surface-border">
          {presets.map((preset) => (
            <div key={preset.id} className="flex items-center gap-2 pr-3">
              <button
                type="button"
                onClick={() =>
                  onChoose({ kind: 'preset', presetId: preset.id })
                }
                className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label text-foreground">
                    {preset.name}
                  </span>
                  <span className="block truncate font-mono text-micro text-muted-foreground">
                    {hostnameOf(preset.baseUrl)}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-faint-foreground"
                  aria-hidden="true"
                />
              </button>
              {preset.keyUrl && (
                <ExternalAnchor
                  href={preset.keyUrl}
                  className="shrink-0 text-caption"
                  label={`获取 ${preset.name} 的 API Key`}
                >
                  获取 API Key
                </ExternalAnchor>
              )}
            </div>
          ))}
          {presets.length === 0 && (
            <p className="px-3 py-4 text-caption text-muted-foreground">
              没有匹配的服务商，可以用下方的自定义兼容地址。
            </p>
          )}
        </div>
      </section>

      <button
        type="button"
        onClick={() => onChoose({ kind: 'custom' })}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left ring-1 ring-surface-border transition-colors duration-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Server
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-label text-foreground">
            自定义兼容地址
          </span>
          <span className="block text-caption text-muted-foreground">
            任何 Anthropic Messages 兼容接口，例如自建中转；支持粘贴 alias 导入
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-faint-foreground"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

function KeyField({
  value,
  onChange,
  label,
  placeholder,
  description,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  description?: ReactNode;
}) {
  return (
    <SettingsField
      label={label}
      htmlFor="wizard-api-key"
      description={description}
    >
      <Input
        id="wizard-api-key"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        className="font-mono"
      />
    </SettingsField>
  );
}

function LoggedIn({ provider }: { provider: UnifiedProviderPublic }) {
  const account =
    provider.claudeOAuthAccountEmail ?? provider.codexOAuthCredentialsEmail;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2.5 text-caption leading-5"
    >
      <Check
        className="mt-0.5 size-4 shrink-0 text-success"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-foreground">
          已登录，连接「{provider.name}」已创建
        </div>
        <div className="text-muted-foreground">
          {account ? `账号 ${account}。` : ''}接下来选择模型并测试。
        </div>
      </div>
    </div>
  );
}

function CodexModelStep({
  catalog,
  model,
  effort,
  onModelChange,
  onEffortChange,
}: {
  catalog: ReturnType<typeof useCodexCatalog>;
  model: string;
  effort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
}) {
  const listed = catalog.models.some((option) => option.value === model);
  const efforts = codexModelEfforts(catalog, model);
  const modelDefaultEffort =
    catalog.models.find((option) => option.value === model)?.defaultEffort ??
    catalog.defaultEffort;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SettingsField
        label="默认模型"
        htmlFor="wizard-codex-model"
        description="对话没有指定模型时使用它；聊天里可以随时切换。"
      >
        <NativeSelect
          id="wizard-codex-model"
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          className="w-full font-mono"
        >
          {!listed && model && (
            <NativeSelectOption value={model}>{model}</NativeSelectOption>
          )}
          {catalog.models.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsField>
      <SettingsField
        label="默认推理档位"
        htmlFor="wizard-codex-effort"
        description="越高越慢但推理越深。"
      >
        <NativeSelect
          id="wizard-codex-effort"
          value={effort}
          onChange={(event) => onEffortChange(event.target.value)}
          className="w-full font-mono"
        >
          {efforts.map((level) => (
            <NativeSelectOption key={level} value={level}>
              {level === modelDefaultEffort ? `${level}（默认）` : level}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </SettingsField>
    </div>
  );
}

function ExternalAnchor({
  href,
  children,
  className,
  label,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 text-primary-text underline-offset-2 hover:underline',
        className,
      )}
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

interface AddModelWizardDialogProps {
  open: boolean;
  enabledCount: number;
  /**
   * The wizard closed. `saved` is the finished connection; `created` one an
   * OAuth login made before the user left.
   */
  onClose: (result: {
    saved: UnifiedProviderPublic | null;
    verified: boolean;
    created: UnifiedProviderPublic | null;
  }) => void;
}

/** The wizard in a dialog, as Settings → 模型配置 opens it. */
export function AddModelWizardDialog({
  open,
  enabledCount,
  onClose,
}: AddModelWizardDialogProps) {
  const [busy, setBusy] = useState(false);
  const created = useRef<UnifiedProviderPublic | null>(null);
  // A fresh wizard (and draft) each time the dialog opens.
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (open) {
      created.current = null;
      setSession((value) => value + 1);
    }
  }, [open]);

  const close = () => {
    if (busy) return;
    onClose({ saved: null, verified: false, created: created.current });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加模型连接</DialogTitle>
          <DialogDescription>
            一个连接对应一份凭据和一个服务地址，可以提供多个模型。
          </DialogDescription>
        </DialogHeader>
        <AddModelWizard
          key={session}
          enabledCount={enabledCount}
          onBusyChange={setBusy}
          onConnectionCreated={(provider) => {
            created.current = provider;
          }}
          onCancel={close}
          onDone={(provider, verified) =>
            onClose({ saved: provider, verified, created: null })
          }
        />
      </DialogContent>
    </Dialog>
  );
}
