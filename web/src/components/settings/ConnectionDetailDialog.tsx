import { useState, type ReactNode } from 'react';
import {
  Check,
  Loader2,
  Pencil,
  PlugZap,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { IconButton } from '@/components/common/IconButton';
import { describeBaseUrlProblem, getModelPreset } from '@/lib/model-providers';
import { api } from '../../api/client';
import {
  codexFallbackEffort,
  codexModelEfforts,
  useCodexCatalog,
} from './codex-catalog';
import { ConnectionModelList } from './ConnectionModelList';
import { ConnectionTestResult } from './ConnectionTestResult';
import {
  PROVIDERS_API,
  confirmProtocolChange,
  connectionKind,
  connectionKindLabel,
  connectionStatus,
  requestError,
  testConnection,
  testOutcome,
  type TestOutcome,
} from './model-connections';
import { OAuthLoginPanel } from './OAuthLoginPanel';
import {
  ProviderEnvEditor,
  buildProviderCustomEnv,
  splitProviderEnv,
  type ProviderEnvDraft,
} from './ProviderEnvEditor';
import { SettingsField } from './SettingsLayout';
import type { UnifiedProviderPublic } from './types';

interface ConnectionDetailDialogProps {
  /** The connection to manage; null closes the dialog. */
  provider: UnifiedProviderPublic | null;
  onClose: () => void;
  /** Something was saved or tested: reload the list. */
  onChanged: () => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}

/** One connection: its status and test, its models, and its settings. */
export function ConnectionDetailDialog({
  provider,
  onClose,
  ...props
}: ConnectionDetailDialogProps) {
  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent
        className="sm:max-w-2xl"
        // Focus the dialog itself rather than the first button, whose
        // tooltip would otherwise open with the dialog.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        {provider && (
          <ConnectionDetail key={provider.id} provider={provider} {...props} />
        )}
      </DialogContent>
    </Dialog>
  );
}

const STATUS_DOT = {
  success: 'success',
  error: 'error',
  muted: 'muted',
} as const;

function sameEnv(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function ConnectionDetail({
  provider,
  onChanged,
  setNotice,
  setError,
}: Omit<ConnectionDetailDialogProps, 'provider' | 'onClose'> & {
  provider: UnifiedProviderPublic;
}) {
  const kind = connectionKind(provider);
  const thirdParty = kind === 'preset' || kind === 'custom';
  const preset = getModelPreset(provider.presetId);
  const status = connectionStatus(provider);

  // ─── Name ───
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider.name);
  const rename = async () => {
    const next = nameDraft.trim();
    if (!next || next === provider.name) {
      setRenaming(false);
      return;
    }
    try {
      await api.patch(`${PROVIDERS_API}/${provider.id}`, { name: next });
      setRenaming(false);
      onChanged();
    } catch (err) {
      setError(requestError(err, '重命名失败'));
    }
  };

  // ─── Test ───
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{
    outcome: TestOutcome | null;
    error: string | null;
  } | null>(null);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const result = await testConnection({ providerId: provider.id });
      setTest({ outcome: testOutcome(result), error: null });
      onChanged();
    } catch (err) {
      setTest({ outcome: null, error: requestError(err, '测试连接失败') });
    } finally {
      setTesting(false);
    }
  };
  // A connection saved before the auth mode was recorded runs on the old
  // guess; once a test finds the header the endpoint takes, offer to keep it.
  const learnedAuthMode =
    thirdParty &&
    provider.anthropicAuthMode === null &&
    test?.outcome?.ok &&
    test.outcome.authMode
      ? test.outcome.authMode
      : null;
  const saveAuthMode = async () => {
    if (!learnedAuthMode || !(await confirmProtocolChange(provider))) return;
    try {
      await api.patch(
        `${PROVIDERS_API}/${provider.id}`,
        { anthropicAuthMode: learnedAuthMode },
        120_000,
      );
      setNotice('认证方式已保存');
      onChanged();
    } catch (err) {
      setError(requestError(err, '保存认证方式失败'));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <DialogHeader>
        {renaming ? (
          <div className="flex items-center gap-1.5 pr-8">
            <DialogTitle className="sr-only">{provider.name}</DialogTitle>
            <Input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void rename();
                }
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setRenaming(false);
                }
              }}
              aria-label="连接名称"
              autoFocus
            />
            <IconButton
              label="保存名称"
              icon={<Check />}
              onClick={() => void rename()}
            />
            <IconButton
              label="取消重命名"
              icon={<X />}
              onClick={() => {
                setNameDraft(provider.name);
                setRenaming(false);
              }}
            />
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1 pr-8">
            <DialogTitle className="truncate">{provider.name}</DialogTitle>
            <IconButton
              label="重命名"
              icon={<Pencil />}
              onClick={() => setRenaming(true)}
            />
          </div>
        )}
        <DialogDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{connectionKindLabel(provider)}</Badge>
            <Badge variant="outline" dot={STATUS_DOT[status.tone]}>
              {status.label}
            </Badge>
            {thirdParty && provider.anthropicBaseUrl && (
              <span className="min-w-0 truncate font-mono text-caption">
                {provider.anthropicBaseUrl}
              </span>
            )}
          </div>
        </DialogDescription>
      </DialogHeader>

      <section className="space-y-2" aria-label="连接测试">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void runTest()}
            disabled={testing}
          >
            {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
            测试连接
          </Button>
          <span className="text-caption text-muted-foreground">
            {kind === 'claude_subscription' || kind === 'chatgpt'
              ? '检查账号是否可用，不消耗额度。'
              : '发送一条最小请求，可能产生极少费用。'}
          </span>
        </div>
        {status.hint && !test && (
          <p className="text-caption text-muted-foreground">{status.hint}</p>
        )}
        <ConnectionTestResult
          outcome={test?.outcome ?? null}
          testing={testing}
          requestError={test?.error ?? null}
        />
        {learnedAuthMode && (
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            服务商接受{' '}
            {learnedAuthMode === 'bearer'
              ? 'Authorization: Bearer'
              : 'x-api-key'}{' '}
            认证。保存后不再按旧规则猜测。
            <Button
              size="xs"
              variant="outline"
              onClick={() => void saveAuthMode()}
            >
              保存认证方式
            </Button>
          </div>
        )}
      </section>

      {kind === 'chatgpt' ? (
        <CodexDefaults
          provider={provider}
          onChanged={onChanged}
          setNotice={setNotice}
          setError={setError}
        />
      ) : (
        <Section
          title="模型"
          description="打开的模型会出现在聊天的模型选择里；默认模型用于没有指定模型的对话。"
        >
          <ConnectionModelList
            provider={provider}
            allowNoDefault={kind !== 'preset'}
            onSaved={() => onChanged()}
            setNotice={setNotice}
            setError={setError}
          />
        </Section>
      )}

      <ConnectionSettings
        provider={provider}
        kind={kind}
        presetName={preset?.name ?? null}
        onChanged={onChanged}
        setNotice={setNotice}
        setError={setError}
      />
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-label font-medium text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function ReloginAlert({ title, message }: { title: string; message?: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg bg-error/10 px-3 py-2.5 text-caption leading-5 text-error"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {message && <div className="break-words opacity-80">{message}</div>}
      </div>
    </div>
  );
}

/** The ChatGPT login's default model and effort (its catalog is its list). */
function CodexDefaults({
  provider,
  onChanged,
  setNotice,
  setError,
}: {
  provider: UnifiedProviderPublic;
  onChanged: () => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const catalog = useCodexCatalog(provider.id);
  const storedEffort =
    provider.codexDefaultEffort || provider.customEnv?.CODEX_REASONING_EFFORT;
  const [model, setModel] = useState(
    provider.anthropicModel || catalog.defaultModel,
  );
  // The server resolves the effort the gateway really applies, clamped to the
  // model's catalog entry; prefer it over a raw stored value.
  const [effort, setEffort] = useState<string | null>(storedEffort || null);
  const shownEffort = effort ?? catalog.defaultEffort;
  const [saving, setSaving] = useState(false);
  const listed = catalog.models.some((option) => option.value === model);
  const modelEfforts = codexModelEfforts(catalog, model);
  const effortChoices = modelEfforts.includes(shownEffort)
    ? modelEfforts
    : [shownEffort, ...modelEfforts];
  const modelDefaultEffort =
    catalog.models.find((option) => option.value === model)?.defaultEffort ??
    catalog.defaultEffort;
  const dirty =
    model !== provider.anthropicModel ||
    (effort !== null && effort !== storedEffort);

  const save = async () => {
    if (!(await confirmProtocolChange(provider))) return;
    setSaving(true);
    try {
      await api.patch(
        `${PROVIDERS_API}/${provider.id}`,
        {
          anthropicModel: model,
          // customEnv 为整体替换语义：保留其他既有变量，仅更新推理力度。
          customEnv: {
            ...(provider.customEnv ?? {}),
            CODEX_REASONING_EFFORT: shownEffort,
          },
        },
        120_000,
      );
      setNotice('默认模型已保存');
      onChanged();
    } catch (err) {
      setError(requestError(err, '保存默认模型失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="模型"
      description="ChatGPT 订阅的模型来自账号的实时目录，聊天里可以按对话切换；这里设置没有指定时的默认值。"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsField label="默认模型" htmlFor="codex-model-select">
          <NativeSelect
            id="codex-model-select"
            value={model}
            onChange={(event) => {
              const next = event.target.value;
              setModel(next);
              setEffort(codexFallbackEffort(catalog, next, shownEffort));
            }}
            disabled={saving}
            className="w-full font-mono"
          >
            {/* 当前值不在目录里（如旧目录的模型）时保留为额外选项 */}
            {!listed && (
              <NativeSelectOption value={model}>{model}</NativeSelectOption>
            )}
            {catalog.models.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.value === catalog.defaultModel
                  ? `${option.value}·默认`
                  : option.value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsField>
        <SettingsField label="默认推理档位" htmlFor="codex-effort-select">
          <NativeSelect
            id="codex-effort-select"
            value={shownEffort}
            onChange={(event) => setEffort(event.target.value)}
            disabled={saving}
            className="w-full font-mono"
          >
            {effortChoices.map((level) => (
              <NativeSelectOption key={level} value={level}>
                {level === modelDefaultEffort ? `${level}（默认）` : level}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsField>
      </div>
      <Button onClick={() => void save()} disabled={!dirty || saving}>
        {saving && <Loader2 className="animate-spin" />}
        保存默认模型
      </Button>
    </Section>
  );
}

/** Credentials, address and environment: edits here restart runners. */
function ConnectionSettings({
  provider,
  kind,
  presetName,
  onChanged,
  setNotice,
  setError,
}: {
  provider: UnifiedProviderPublic;
  kind: ReturnType<typeof connectionKind>;
  presetName: string | null;
  onChanged: () => void;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const thirdParty = kind === 'preset' || kind === 'custom';
  const [baseUrl, setBaseUrl] = useState(provider.anthropicBaseUrl);
  const [secret, setSecret] = useState('');
  const initialEnv = splitProviderEnv(
    thirdParty,
    provider.customEnv ?? {},
    provider.anthropicModel,
  );
  const [env, setEnv] = useState<ProviderEnvDraft>(initialEnv);
  const [saving, setSaving] = useState(false);
  const baseUrlProblem =
    kind === 'custom' ? describeBaseUrlProblem(baseUrl) : null;

  const built = buildProviderCustomEnv(thirdParty, env);
  const envChanged = !sameEnv(built.customEnv, provider.customEnv ?? {});
  const urlChanged =
    kind === 'custom' && baseUrl.trim() !== provider.anthropicBaseUrl;
  const dirty = urlChanged || !!secret.trim() || envChanged;

  const save = async () => {
    if (built.error) {
      setError(built.error);
      return;
    }
    if (kind === 'custom' && !baseUrl.trim()) {
      setError('请填写服务地址');
      return;
    }
    if (!(await confirmProtocolChange(provider))) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      const secrets: Record<string, unknown> = {};
      if (urlChanged) patch.anthropicBaseUrl = baseUrl.trim();
      if (envChanged) patch.customEnv = built.customEnv;
      if (secret.trim()) {
        if (thirdParty) {
          // The key travels with the other fields: one request, one runner
          // restart, and never an address saved without its key.
          patch.anthropicAuthToken = secret.trim();
        } else if (kind === 'anthropic_api') {
          secrets.anthropicApiKey = secret.trim();
        } else {
          // 服务端解析粘贴原文，并保证官方连接只保留一种凭据
          secrets.claudeCredentialInput = secret.trim();
        }
      }
      if (Object.keys(patch).length > 0) {
        await api.patch(`${PROVIDERS_API}/${provider.id}`, patch, 120_000);
      }
      if (Object.keys(secrets).length > 0) {
        await api.put(
          `${PROVIDERS_API}/${provider.id}/secrets`,
          secrets,
          120_000,
        );
      }
      setSecret('');
      setNotice('连接设置已保存；建议测试一次连接');
      onChanged();
    } catch (err) {
      setError(requestError(err, '保存连接设置失败'));
    } finally {
      setSaving(false);
    }
  };

  const relogin = () => {
    setNotice('登录成功，凭据已更新');
    onChanged();
  };

  return (
    <Section
      title="连接设置"
      description="修改地址、密钥或环境变量会停止正在使用它的会话；下一条消息开启新的 SDK 会话，聊天记录保留。"
    >
      {kind === 'claude_subscription' && (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-surface-border">
          {provider.claudeOAuthNeedsReLogin && (
            <ReloginAlert
              title={
                provider.claudeOAuthLastRefreshError?.kind ===
                'account_mismatch'
                  ? '续期返回了另一个账号，已拒绝写入，请重新登录'
                  : '授权已失效，需要重新登录 Claude'
              }
              message={provider.claudeOAuthLastRefreshError?.message}
            />
          )}
          {provider.hasClaudeOAuthCredentials && (
            <div className="space-y-0.5 text-caption leading-5 text-muted-foreground">
              {(provider.claudeOAuthAccountEmail ||
                provider.claudeOAuthSubscriptionType) && (
                <div className="text-foreground">
                  账号：{provider.claudeOAuthAccountEmail ?? '未知'}
                  {provider.claudeOAuthSubscriptionType
                    ? `（${provider.claudeOAuthSubscriptionType}）`
                    : ''}
                  {provider.claudeOAuthOrganizationName
                    ? ` · ${provider.claudeOAuthOrganizationName}`
                    : ''}
                </div>
              )}
              <div>
                Access Token：
                <span className="font-mono">
                  {provider.claudeOAuthCredentialsAccessTokenMasked || '***'}
                </span>
              </div>
              {provider.claudeOAuthCredentialsExpiresAt && (
                <div>
                  过期时间：
                  {formatTime(provider.claudeOAuthCredentialsExpiresAt)}
                </div>
              )}
              <div>
                HappyClaw 会在过期前自动续期
                {provider.claudeOAuthLastRefreshAt
                  ? `，上次续期 ${formatTime(provider.claudeOAuthLastRefreshAt)}`
                  : ''}
                。
              </div>
            </div>
          )}
          {provider.hasClaudeCodeOauthToken && (
            <div className="text-caption text-muted-foreground">
              Setup Token：
              <span className="font-mono">
                {provider.claudeCodeOauthTokenMasked}
              </span>
            </div>
          )}
          <OAuthLoginPanel
            service="claude"
            targetProviderId={provider.id}
            onSuccess={relogin}
          />
        </div>
      )}

      {kind === 'chatgpt' && (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-surface-border">
          {provider.codexOAuthNeedsReauth && (
            <ReloginAlert
              title="ChatGPT 授权已失效，请重新登录"
              message={provider.codexOAuthLastRefreshError?.message}
            />
          )}
          {(provider.codexOAuthCredentialsEmail ||
            provider.codexOAuthCredentialsExpiresAt) && (
            <div className="space-y-0.5 text-caption leading-5 text-muted-foreground">
              {provider.codexOAuthCredentialsEmail && (
                <div className="text-foreground">
                  账号：{provider.codexOAuthCredentialsEmail}
                  {provider.codexOAuthCredentialsPlanType
                    ? `（${provider.codexOAuthCredentialsPlanType}）`
                    : ''}
                </div>
              )}
              <div>网关会在 token 过期时自动刷新。</div>
            </div>
          )}
          <OAuthLoginPanel
            service="chatgpt"
            targetProviderId={provider.id}
            onSuccess={relogin}
          />
        </div>
      )}

      {kind !== 'chatgpt' && (
        <div className="space-y-4">
          {thirdParty && (
            <SettingsField
              label="服务地址"
              htmlFor="connection-base-url"
              description={
                kind === 'preset' ? (
                  `「${presetName}」预设的地址，不能修改；需要其他地址请添加自定义连接。`
                ) : baseUrlProblem ? (
                  <span className="flex gap-1.5 text-warning">
                    <TriangleAlert
                      className="mt-0.5 size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {baseUrlProblem}
                  </span>
                ) : undefined
              }
            >
              <Input
                id="connection-base-url"
                type="url"
                inputMode="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                readOnly={kind === 'preset'}
                disabled={saving}
                autoComplete="off"
                className="font-mono"
              />
            </SettingsField>
          )}
          <SettingsField
            label={
              kind === 'claude_subscription'
                ? '粘贴新的 setup-token 或 .credentials.json'
                : '更换 API Key'
            }
            htmlFor="connection-secret"
            description={
              thirdParty && provider.hasAnthropicAuthToken
                ? `当前 ${provider.anthropicAuthTokenMasked ?? '已设置'}；留空保留。`
                : kind === 'anthropic_api' && provider.hasAnthropicApiKey
                  ? `当前 ${provider.anthropicApiKeyMasked ?? '已设置'}；留空保留。`
                  : undefined
            }
          >
            <Input
              id="connection-secret"
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              disabled={saving}
              placeholder="留空保留当前凭据"
              autoComplete="new-password"
              className="font-mono"
            />
          </SettingsField>
          <ProviderEnvEditor
            thirdParty={thirdParty}
            defaultModel={provider.anthropicModel}
            value={env}
            onChange={setEnv}
            disabled={saving}
          />
          <Button onClick={() => void save()} disabled={!dirty || saving}>
            {saving && <Loader2 className="animate-spin" />}
            保存连接设置
          </Button>
        </div>
      )}
    </Section>
  );
}
