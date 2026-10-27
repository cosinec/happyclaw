import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  Loader2,
  RotateCcw,
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
import { Switch } from '@/components/ui/switch';
import {
  describeBaseUrlProblem,
  findPresetsByBaseUrl,
  getModelPreset,
  normalizeProviderBaseUrl,
  type ModelPreset,
} from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import { api } from '../../api/client';
import type {
  ProviderAuthMode,
  ProviderEnvImport,
} from '../../utils/provider-env-import';
import { buildDefaultProviderEnv } from '../../utils/provider-model';
import {
  codexDefaultsPatch,
  codexFallbackEffort,
  storedCodexEffort,
  useCodexCatalog,
} from './codex-catalog';
import { CodexModelFields } from './CodexModelFields';
import { ConnectionTestResult } from './ConnectionTestResult';
import {
  CONNECTION_KIND_LABELS,
  PROVIDERS_API,
  allowsNoDefaultModel,
  discoverModels,
  isThirdPartyKind,
  testConnection,
  testOutcome,
  updateConnection,
  type ConnectionDraftBody,
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
import { SettingsField } from './SettingsLayout';
import { getErrorMessage, type UnifiedProviderPublic } from './types';
import {
  ExternalAnchor,
  WizardSourceStep,
  hostnameOf,
  type WizardSource,
} from './WizardSourceStep';

type Step = 'source' | 'connect' | 'models' | 'save';

const STEPS: ReadonlyArray<{ key: Step; label: string }> = [
  { key: 'source', label: '选择来源' },
  { key: 'connect', label: '连接' },
  { key: 'models', label: '选择模型' },
  { key: 'save', label: '测试并保存' },
];

/**
 * Model aliases Claude Code resolves to the newest version. An official
 * connection offers these when its model list cannot be read.
 */
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

const OFFICIAL_PASS_THROUGH = {
  label: '不指定（由 Claude Code 选择）',
  hint: 'Claude Code 使用它自己的默认模型；别名会自动解析为最新版本。',
};
const RELAY_PASS_THROUGH = {
  label: '不指定（透传）',
  hint: 'Claude Code 继续请求 Claude 模型名，由中转站自行路由。',
};

function sourceKey(source: WizardSource | null): string {
  if (!source) return '';
  return source.kind === 'preset' ? `preset:${source.presetId}` : source.kind;
}

interface AddModelWizardProps {
  /** Connections already enabled; the new one joins the pool when none is. */
  enabledCount: number;
  /** Offer the 加入自动池 switch (the first-run page always joins). */
  showPoolSwitch?: boolean;
  /** The connection was saved; `verified` = its test passed. */
  onDone: (provider: UnifiedProviderPublic, verified: boolean) => void;
  /** An OAuth login created the connection before the wizard finished. */
  onConnectionCreated?: (provider: UnifiedProviderPublic) => void;
  /** Absent on the setup page, which has its own way out. */
  onCancel?: () => void;
  /** Inside a dialog the footer sticks to the dialog's bottom edge. */
  layout?: 'dialog' | 'page';
  /** Reports whether a save is in flight, so a host can hold its close. */
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
  showPoolSwitch = true,
  onDone,
  onConnectionCreated,
  onCancel,
  layout = 'dialog',
  onBusyChange,
}: AddModelWizardProps) {
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<WizardSource | null>(null);

  // ─── Connection draft ───
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [credentialInput, setCredentialInput] = useState('');
  /** Environment a pasted alias carries; edited later in the detail. */
  const [importedEnv, setImportedEnv] = useState<Record<string, string>>({});
  const [importedName, setImportedName] = useState<string | null>(null);
  const [importedAuthMode, setImportedAuthMode] =
    useState<ProviderAuthMode | null>(null);
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
    useState<ProviderAuthMode | null>(null);
  const discoveredFor = useRef<string | null>(null);
  const discoverySeq = useRef(0);
  const codexCatalog = useCodexCatalog(
    source?.kind === 'chatgpt' && created ? created.id : null,
  );
  /** A ChatGPT login starts from what the server gave it until changed. */
  const [codexPick, setCodexPick] = useState<{
    model: string;
    effort: string;
  } | null>(null);

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
  const thirdParty = isThirdPartyKind(kind);
  const effectiveBaseUrl = preset ? preset.baseUrl : baseUrl.trim();
  const baseUrlProblem =
    kind === 'custom' ? describeBaseUrlProblem(baseUrl) : null;
  const picked = candidates.filter((candidate) => candidate.picked);
  const defaultCandidate = candidates.find(
    (candidate) => candidate.picked && candidate.base === defaultBase,
  );
  const codexModel =
    codexPick?.model ?? (created?.anthropicModel || codexCatalog.defaultModel);
  const codexEffort =
    codexPick?.effort ??
    codexFallbackEffort(
      codexCatalog,
      codexModel,
      (created && storedCodexEffort(created)) || codexCatalog.defaultEffort,
    );
  const defaultModelId =
    kind === 'chatgpt'
      ? codexModel
      : defaultCandidate
        ? candidateId(defaultCandidate)
        : '';
  const passThrough = !allowsNoDefaultModel(kind)
    ? null
    : kind === 'custom'
      ? RELAY_PASS_THROUGH
      : OFFICIAL_PASS_THROUGH;

  // Whatever identifies the credential and endpoint: a change makes the
  // model list and the test result stale.
  const connectionSignature = JSON.stringify([
    sourceKey(source),
    thirdParty ? effectiveBaseUrl : '',
    kind === 'claude_subscription' ? credentialInput.trim() : apiKey.trim(),
    created?.id ?? '',
  ]);
  // A saved connection is tested by id alone, so only the draft's model and
  // environment make a new test worth sending.
  const testSignature = created
    ? connectionSignature
    : JSON.stringify([connectionSignature, defaultModelId, importedEnv]);
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
          nextCandidates.find((candidate) => candidate.origin === 'preset')
            ?.base ?? '',
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
    // Blank prefilled overrides mean "use the default"; never persist them.
    setImportedEnv({
      ...imported.customEnv,
      ...Object.fromEntries(
        Object.entries(imported.envOverrides).filter(([, value]) =>
          value.trim(),
        ),
      ),
    });
    if (imported.model) {
      const model = imported.model;
      setCandidates((current) => [
        ...current.filter((candidate) => candidate.base !== model),
        {
          base: model,
          oneMillion: imported.oneMillionContext,
          picked: true,
          origin: 'manual',
        },
      ]);
      setDefaultBase(model);
    }
  };

  // ─── Discovery ───
  const draftBody = (): ConnectionDraftBody => {
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
    const official = kind === 'claude_subscription' || kind === 'anthropic_api';
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
    discoverModels(created ? { providerId: created.id } : draftBody())
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
                  kind === 'claude_subscription',
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
          message: getErrorMessage(err, '获取模型列表失败'),
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

  // ─── Test ───
  const runTest = () => {
    const signature = testSignature;
    const seq = ++testSeq.current;
    setTesting(true);
    setTest(null);
    const body = created
      ? { providerId: created.id }
      : {
          ...draftBody(),
          anthropicModel: defaultModelId,
          ...(thirdParty ? { customEnv: importedEnv } : {}),
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
      .catch((err) => settle(null, getErrorMessage(err, '测试连接失败')));
  };

  // One test per draft: entering the last step tests it once, and only a
  // change to the draft (or the user) asks again.
  useEffect(() => {
    if (step !== 'save' || test?.signature === testSignature) return;
    runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, testSignature]);

  const currentTest = test?.signature === testSignature ? test : null;
  const authInvalid = currentTest?.outcome?.code === 'AUTH_INVALID';
  const verified = currentTest?.outcome?.ok === true;

  // ─── Save ───
  const defaultName =
    created?.name ??
    preset?.name ??
    (kind === 'custom'
      ? importedName || hostnameOf(baseUrl) || CONNECTION_KIND_LABELS.custom
      : CONNECTION_KIND_LABELS[kind ?? 'custom']);
  // Same rule the server applies: join the pool when nothing else is in it.
  // A connection an OAuth login made already carries the server's choice;
  // the first-run page, without the switch, always joins.
  const poolDefault =
    created && showPoolSwitch ? created.enabled : enabledCount === 0;
  const poolEnabled = poolChoice ?? poolDefault;

  const save = async () => {
    if (authInvalid || testing || saving) return;
    setSaving(true);
    setSaveError(null);
    const trimmedName = name.trim() || defaultName;
    const models = picked.map((candidate) => ({ id: candidateId(candidate) }));
    try {
      let provider: UnifiedProviderPublic;
      if (created) {
        const patch: Record<string, unknown> =
          kind === 'chatgpt'
            ? codexDefaultsPatch(created, codexModel, codexEffort)
            : { models, anthropicModel: defaultModelId };
        if (trimmedName !== created.name) patch.name = trimmedName;
        provider =
          Object.keys(patch).length > 0
            ? await updateConnection(created.id, patch)
            : created;
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
          ...draftBody(),
          anthropicModel: defaultModelId,
          models,
          enabled: poolEnabled,
        };
        if (thirdParty) {
          body.customEnv = importedEnv;
          if (authMode) body.anthropicAuthMode = authMode;
        }
        provider = await api.post<UnifiedProviderPublic>(PROVIDERS_API, body);
        // The draft test was not stored; test the saved connection so its
        // status is on record.
        await testConnection({ providerId: provider.id }).catch(() => {});
      }
      onDone(provider, verified);
    } catch (err) {
      setSaveError(getErrorMessage(err, '保存模型连接失败'));
    } finally {
      setSaving(false);
    }
  };

  // ─── Navigation ───
  const stepIndex = STEPS.findIndex((item) => item.key === step);
  const canLeaveConnect = (() => {
    switch (kind) {
      case 'claude_subscription':
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

  const compactWindow =
    importedEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW ||
    buildDefaultProviderEnv(defaultModelId).find(
      (row) => row.key === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    )?.value;
  const importedCount = Object.keys(importedEnv).length;

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

      {step === 'source' && <WizardSourceStep onChoose={chooseSource} />}

      {step === 'connect' && kind === 'claude_subscription' && (
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
        <CodexModelFields
          catalog={codexCatalog}
          model={codexModel}
          effort={codexEffort}
          onChange={setCodexPick}
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
              {preset?.name ?? CONNECTION_KIND_LABELS[kind ?? 'custom']}
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
                  {Number(compactWindow).toLocaleString('en-US')} tokens
                  {importedCount > 0 &&
                    `；另有 ${importedCount} 项导入的环境变量`}
                  。保存后可在连接设置里调整。
                </dd>
              </>
            )}
          </dl>

          {showPoolSwitch && (
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

/**
 * The wizard in a dialog, as Settings → 模型配置 opens it. The dialog drops
 * its content when closed, so every opening starts a fresh draft.
 */
export function AddModelWizardDialog({
  open,
  enabledCount,
  onClose,
}: AddModelWizardDialogProps) {
  const [busy, setBusy] = useState(false);
  const created = useRef<UnifiedProviderPublic | null>(null);

  const finish = (saved: UnifiedProviderPublic | null, verified: boolean) => {
    const leftBehind = saved ? null : created.current;
    created.current = null;
    onClose({ saved, verified, created: leftBehind });
  };
  const close = () => {
    if (!busy) finish(null, false);
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
          enabledCount={enabledCount}
          onBusyChange={setBusy}
          onConnectionCreated={(provider) => {
            created.current = provider;
          }}
          onCancel={close}
          onDone={finish}
        />
      </DialogContent>
    </Dialog>
  );
}
