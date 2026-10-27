import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type {
  BalancingConfig,
  ProviderWithHealth,
  ProvidersListResponse,
  ProviderHealthStatus,
} from './types';
import { getErrorMessage } from './types';
import { ProviderList } from './ProviderList';
import { AddModelWizardDialog } from './AddModelWizard';
import { ConnectionDetailDialog } from './ConnectionDetailDialog';
import { BalancingSettings } from './BalancingSettings';
import {
  PROVIDERS_API,
  errorCopy,
  testConnection,
  testOutcome,
} from './model-connections';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { SettingsSection } from './SettingsLayout';

interface ClaudeProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function createBalancingMutationQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function enqueue<T>(request: () => Promise<T>): Promise<T> {
    const operation = tail.then(request);
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

export function ClaudeProviderSection({
  setNotice,
  setError,
}: ClaudeProviderSectionProps) {
  const [providers, setProviders] = useState<ProviderWithHealth[]>([]);
  const enabledCount = providers.filter((provider) => provider.enabled).length;
  const [defaultModelConfigId, setDefaultModelConfigId] = useState<
    string | null
  >(null);
  const [balancing, setBalancing] = useState<BalancingConfig | null>(null);
  const balancingRef = useRef<BalancingConfig | null>(null);
  const balancingRevisionRef = useRef(0);
  const balancingPendingRef = useRef(0);
  const balancingQueueRef = useRef<ReturnType<
    typeof createBalancingMutationQueue
  > | null>(null);
  balancingQueueRef.current ??= createBalancingMutationQueue();

  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [balancingSaving, setBalancingSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  // 添加向导与连接详情；详情跟随列表刷新，按 id 取最新数据
  const [wizardOpen, setWizardOpen] = useState(false);
  const [managingId, setManagingId] = useState<string | null>(null);
  const managing =
    providers.find((provider) => provider.id === managingId) ?? null;

  // 确认对话框
  const [pendingDeleteProvider, setPendingDeleteProvider] =
    useState<ProviderWithHealth | null>(null);

  // ─── 加载提供商列表 ──────────────────────────────────────────
  const loadProviders = useCallback(async () => {
    try {
      const data = await api.get<ProvidersListResponse>(
        '/api/config/claude/providers',
      );
      setProviders(data.providers);
      setDefaultModelConfigId(data.defaultModelConfigId ?? null);
      balancingRef.current = data.balancing;
      setBalancing(data.balancing);
    } catch (err) {
      setError(getErrorMessage(err, '加载模型配置列表失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // ─── 健康状态轮询（启用 >= 2 个提供商时，仅页面可见时） ──────
  const pollHealth = useCallback(async () => {
    try {
      const data = await api.get<{ statuses: ProviderHealthStatus[] }>(
        '/api/config/claude/providers/health',
      );
      setProviders((prev) =>
        prev.map((p) => {
          const updated = data.statuses.find((s) => s.profileId === p.id);
          return updated ? { ...p, health: updated } : p;
        }),
      );
    } catch {
      // 静默忽略
    }
  }, []);
  useVisibleInterval(pollHealth, 10000, enabledCount >= 2);

  // ─── 切换提供商启用/禁用 ──────────────────────────────────────
  const handleToggle = useCallback(
    async (provider: ProviderWithHealth) => {
      setTogglingId(provider.id);
      try {
        await api.post(
          `/api/config/claude/providers/${provider.id}/toggle`,
          { enabled: !provider.enabled },
          120_000,
        );
        await loadProviders();
        setNotice(
          provider.enabled
            ? `已禁用「${provider.name}」`
            : `已启用「${provider.name}」`,
        );
      } catch (err) {
        // A 503 can mean the target state was persisted but runtime teardown
        // failed afterward. Reload instead of leaving a stale toggle that a
        // user might click again and accidentally reverse.
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '切换模型配置状态失败'));
      } finally {
        setTogglingId(null);
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 设为默认 / 取消默认（再次点击当前默认即取消）─────────────────
  const handleSetDefault = useCallback(
    async (provider: ProviderWithHealth) => {
      const clearing = provider.id === defaultModelConfigId;
      setTogglingId(provider.id);
      try {
        await api.put(
          '/api/config/claude/default',
          { modelConfigId: clearing ? null : provider.id },
          120_000,
        );
        await loadProviders();
        setNotice(
          clearing
            ? `已取消默认模型「${provider.name}」，未手动选择的对话恢复为在已启用配置间自动轮换`
            : provider.enabled
              ? `已将「${provider.name}」设为默认模型`
              : `已将「${provider.name}」设为默认模型，并同时启用`,
        );
      } catch (err) {
        // A 503 can mean the choice was persisted but runtime teardown failed
        // afterward: reload so the badge shows what is really stored.
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '设置默认模型失败'));
      } finally {
        setTogglingId(null);
      }
    },
    [defaultModelConfigId, loadProviders, setNotice, setError],
  );

  // ─── 重置健康状态 ─────────────────────────────────────────────
  const handleResetHealth = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post(
          `/api/config/claude/providers/${provider.id}/reset-health`,
        );
        await loadProviders();
        setNotice('健康状态已重置');
      } catch (err) {
        setError(getErrorMessage(err, '重置健康状态失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 删除提供商 ───────────────────────────────────────────────
  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDeleteProvider) return;

    const provider = pendingDeleteProvider;
    setDeletingId(provider.id);
    setPendingDeleteProvider(null);

    try {
      const result = await api.delete<{ defaultCleared?: boolean }>(
        `/api/config/claude/providers/${provider.id}`,
      );
      setNotice(
        result?.defaultCleared
          ? `已删除模型配置「${provider.name}」；它是默认模型，未手动选择的对话已恢复为在已启用配置间自动轮换`
          : `已删除模型配置「${provider.name}」`,
      );
      await loadProviders();
    } catch (err) {
      setError(getErrorMessage(err, '删除模型配置失败'));
    } finally {
      setDeletingId(null);
    }
  }, [pendingDeleteProvider, loadProviders, setNotice, setError]);

  // ─── 复制第三方提供商（服务端连同密钥一起复制，默认停用）─────────
  const handleDuplicate = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        const copy = await api.post<ProviderWithHealth>(
          `/api/config/claude/providers/${provider.id}/duplicate`,
        );
        await loadProviders();
        setNotice(`已复制模型配置「${provider.name}」，可直接修改后启用`);
        // Same vendor, different settings is the common case: open the copy.
        setManagingId(copy.id);
      } catch (err) {
        setError(getErrorMessage(err, '复制模型配置失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 更新负载均衡设置 ─────────────────────────────────────────
  const handleBalancingChange = useCallback(
    async (updates: Partial<BalancingConfig>) => {
      const current = balancingRef.current;
      if (!current) return;
      const next = { ...current, ...updates };
      const revision = ++balancingRevisionRef.current;
      balancingRef.current = next;
      setBalancing(next);
      balancingPendingRef.current += 1;
      setBalancingSaving(true);

      try {
        // Serialize full-snapshot PUTs so the server cannot persist them in a
        // different order. The revision guard also prevents a stale response
        // from replacing a newer optimistic value in the UI.
        const saved = await balancingQueueRef.current!(() =>
          api.put<BalancingConfig>('/api/config/claude/balancing', next),
        );
        if (revision === balancingRevisionRef.current) {
          balancingRef.current = saved;
          setBalancing(saved);
          setNotice('负载均衡设置已更新');
        }
      } catch (err) {
        if (revision === balancingRevisionRef.current) {
          await loadProviders().catch(() => {});
          setError(getErrorMessage(err, '更新负载均衡设置失败'));
        }
      } finally {
        balancingPendingRef.current = Math.max(
          0,
          balancingPendingRef.current - 1,
        );
        if (balancingPendingRef.current === 0) {
          setBalancingSaving(false);
        }
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 测试连接（服务端记录 lastTest）────────────────────────────
  const handleTest = useCallback(
    async (provider: ProviderWithHealth) => {
      setTestingId(provider.id);
      try {
        const outcome = testOutcome(
          await testConnection({ providerId: provider.id }),
        );
        if (outcome.ok) {
          setNotice(`「${provider.name}」连接成功`);
        } else {
          const copy = errorCopy(outcome.code);
          setError(`「${provider.name}」${copy.title}：${copy.hint}`);
        }
      } catch (err) {
        setError(getErrorMessage(err, '测试连接失败'));
      } finally {
        setTestingId(null);
        await loadProviders().catch(() => {});
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 加权轮询的权重 ───────────────────────────────────────────
  const handleWeightChange = useCallback(
    async (providerId: string, weight: number) => {
      try {
        await api.patch(`${PROVIDERS_API}/${providerId}`, { weight }, 120_000);
        await loadProviders();
        setNotice('权重已更新');
      } catch (err) {
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '更新权重失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  const handleAdd = useCallback(() => setWizardOpen(true), []);

  const busy =
    loading || togglingId !== null || deletingId !== null || balancingSaving;

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 提供商列表 */}
      <SettingsSection
        title="模型连接"
        description={`${providers.length} 个连接；每个连接可以提供多个模型，聊天和智能体按「连接 · 模型」选择。`}
        actions={
          providers.length > 0 && (
            <Button onClick={handleAdd} disabled={busy}>
              <Plus />
              添加模型连接
            </Button>
          )
        }
      >
        <ProviderList
          providers={providers}
          defaultModelConfigId={defaultModelConfigId}
          onManage={(p) => setManagingId(p.id)}
          onTest={(p) => void handleTest(p)}
          testingId={testingId}
          onDelete={(p) => setPendingDeleteProvider(p)}
          onToggle={handleToggle}
          onSetDefault={handleSetDefault}
          onResetHealth={handleResetHealth}
          onDuplicate={handleDuplicate}
          onAdd={handleAdd}
          togglingId={togglingId}
          deletingId={deletingId}
          disabled={busy}
        />

        {/* 负载均衡设置：配置了多个模型时展示（池只在 >=2 启用时生效） */}
        {balancing && providers.length >= 2 && (
          <BalancingSettings
            balancing={balancing}
            hasDefault={defaultModelConfigId !== null}
            onChange={handleBalancingChange}
            pool={providers.filter((provider) => provider.enabled)}
            onWeightChange={(id, weight) => void handleWeightChange(id, weight)}
            disabled={busy}
            saving={balancingSaving}
          />
        )}
      </SettingsSection>

      <AddModelWizardDialog
        open={wizardOpen}
        enabledCount={enabledCount}
        onClose={({ saved, verified, created }) => {
          setWizardOpen(false);
          if (saved) {
            setNotice(
              verified
                ? `已添加模型连接「${saved.name}」`
                : `已添加模型连接「${saved.name}」，尚未验证`,
            );
          } else if (created) {
            setNotice(
              `已创建模型连接「${created.name}」，可以在列表里继续配置`,
            );
          }
          if (saved || created) void loadProviders();
        }}
      />

      <ConnectionDetailDialog
        provider={managing}
        onClose={() => setManagingId(null)}
        onChanged={() => void loadProviders()}
        setNotice={setNotice}
        setError={setError}
      />

      {/* 确认删除对话框 */}
      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => setPendingDeleteProvider(null)}
        onConfirm={handleDeleteConfirm}
        title="删除模型配置"
        message={
          pendingDeleteProvider
            ? `确认删除模型配置「${pendingDeleteProvider.name}」？${
                pendingDeleteProvider.id === defaultModelConfigId
                  ? '它是当前默认模型，删除后未手动选择的对话会恢复为在已启用配置间自动轮换。'
                  : ''
              }`
            : '确认删除该模型配置？'
        }
        confirmText="确认删除"
        confirmVariant="danger"
        loading={deletingId !== null}
      />
    </div>
  );
}
