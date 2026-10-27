import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useMcpServersStore } from '../../stores/mcp-servers';
import { useSkillsStore } from '../../stores/skills';
import type {
  AgentEffortLevel,
  AgentProfileRuntimePolicy,
  ModelConfigOption,
} from '../../types';
import { normalizeMcpPolicyReferences } from '../../utils/mcp-servers';
import { PolicyResourcePicker } from '../agents/PolicyResourcePicker';
import { AgentSkillsPolicyEditor } from '../agents/AgentSkillsPolicyEditor';
import { EffectiveCapabilitiesPreview } from '../agents/EffectiveCapabilitiesPreview';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AGENT_EFFORT_OPTIONS,
  buildHostSkillOptions,
  buildManagedSkillOptions,
  buildMcpSelectionOptions,
  getHostSkillPolicy,
  skillSelectionError,
} from '../../utils/agent-runtime-policy';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import { SettingsFormFooter } from './SettingsFormControls';
import { getErrorMessage } from './types';

type CapabilityMode = 'inherit' | 'custom' | 'disabled';

const DEFAULT_MODEL_VALUE = '__default__';

/** Whether the server lists the models an Agent may pin; older ones do not. */
export function hasModelLists(configs: ModelConfigOption[]): boolean {
  return configs.some((config) => Array.isArray(config.models));
}

/** Readable copy for a model the configuration does not offer, else null. */
export function modelBindingErrorMessage(err: unknown): string | null {
  const code =
    err && typeof err === 'object'
      ? (err as { body?: { code?: unknown } }).body?.code
      : undefined;
  return code === 'MODEL_NOT_IN_CONNECTION'
    ? '所选模型已不在该模型配置的模型列表里，请重新选择模型'
    : null;
}

/**
 * The model an Agent runs within its configuration: the configuration's
 * default (null) or one of its models. Hidden models stay listed, since a
 * binding may name them, and a bound model the list lacks stays so the select
 * shows what is saved. Nothing to pick while the configuration is automatic.
 */
export function AgentModelSelect({
  configs,
  configId,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  configs: ModelConfigOption[];
  /** 'inherit' while the configuration is chosen automatically. */
  configId: string;
  value: string | null;
  onChange: (model: string | null) => void;
  ariaLabel: string;
  className?: string;
}) {
  const config =
    configId === 'inherit'
      ? undefined
      : configs.find((item) => item.id === configId);
  const defaultModel = config?.anthropic_model ?? '';
  const models = config?.models ?? [];
  // The first option already stands for the default model.
  const listed = models.filter(
    (model) => model.id !== defaultModel || model.id === value,
  );
  const missing = !!config && !!value && !models.some((m) => m.id === value);
  return (
    <Select
      value={value ?? DEFAULT_MODEL_VALUE}
      onValueChange={(next) =>
        onChange(next === DEFAULT_MODEL_VALUE ? null : next)
      }
      disabled={!config || (listed.length === 0 && !missing)}
    >
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue placeholder="选择模型" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_MODEL_VALUE}>
          {config
            ? `连接默认（${defaultModel || '由中转站决定'}）`
            : '由模型配置决定'}
        </SelectItem>
        {missing && value && (
          <SelectItem value={value}>{value}（不在模型列表里）</SelectItem>
        )}
        {listed.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.id}
            {model.hidden ? '（已隐藏）' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MainAgentCapabilitiesSection() {
  const profiles = useAgentProfilesStore((state) => state.profiles);
  const modelConfigs = useAgentProfilesStore(
    (state) => state.modelConfigs ?? [],
  );
  const defaultModel = modelConfigs.find((item) => item.is_default);
  const profilesLoading = useAgentProfilesStore((state) => state.loading);
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);
  const governance = useAgentProfilesStore((state) =>
    profileKey(state.profiles, state.governanceByProfile),
  );
  const loadProfileGovernance = useAgentProfilesStore(
    (state) => state.loadProfileGovernance,
  );
  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);
  const profile = profiles.find((item) => item.is_default);

  const [skillsMode, setSkillsMode] = useState<CapabilityMode>('inherit');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [hostSkillsMode, setHostSkillsMode] =
    useState<CapabilityMode>('disabled');
  const [hostSkillIds, setHostSkillIds] = useState<string[]>([]);
  const [mcpMode, setMcpMode] = useState<CapabilityMode>('inherit');
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [modelConfigId, setModelConfigId] = useState('inherit');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<AgentEffortLevel>('inherit');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([loadProfiles(), loadSkills(), loadMcpServers()]);
  }, [loadMcpServers, loadProfiles, loadSkills]);

  useEffect(() => {
    if (!profile) return;
    setSkillsMode(profile.runtime_policy.skills.mode);
    setSkillIds(profile.runtime_policy.skills.ids);
    const hostPolicy = getHostSkillPolicy(profile.runtime_policy);
    setHostSkillsMode(hostPolicy.mode);
    setHostSkillIds(hostPolicy.ids);
    setMcpMode(profile.runtime_policy.mcp.mode);
    setMcpIds(normalizeMcpPolicyReferences(profile.runtime_policy.mcp.ids));
    setModelConfigId(profile.model_config_id ?? 'inherit');
    setModel(profile.model ?? null);
    setEffort(profile.runtime_policy.reasoning?.effort ?? 'inherit');
  }, [profile?.id, profile?.updated_at]);

  useEffect(() => {
    if (!profile?.id) return;
    void loadProfileGovernance(profile.id).catch(() => undefined);
  }, [loadProfileGovernance, profile?.id]);

  const skillOptions = useMemo(
    () => buildManagedSkillOptions(skills, skillIds),
    [skillIds, skills],
  );
  const hostSkillOptions = useMemo(
    () => buildHostSkillOptions(skills, hostSkillIds),
    [hostSkillIds, skills],
  );
  const mcpOptions = useMemo(
    () => buildMcpSelectionOptions(mcpServers, mcpIds),
    [mcpIds, mcpServers],
  );

  const persistedHostPolicy = profile
    ? getHostSkillPolicy(profile.runtime_policy)
    : null;
  const managedSkillsError = skillSelectionError(' HappyClaw Skill', {
    mode: skillsMode,
    ids: skillIds,
  });
  const hostSkillsError = skillSelectionError('宿主机 Skill', {
    mode: hostSkillsMode,
    ids: hostSkillIds,
  });
  const capabilityError = managedSkillsError ?? hostSkillsError;
  const persistedModelConfigId =
    modelConfigId === 'inherit' ? null : modelConfigId;
  // An automatic configuration has no model of its own to pin.
  const persistedModel = persistedModelConfigId ? model : null;
  const modelChanged = !!profile && persistedModel !== (profile.model ?? null);

  const dirty =
    !!profile &&
    (persistedModelConfigId !== profile.model_config_id ||
      modelChanged ||
      effort !== (profile.runtime_policy.reasoning?.effort ?? 'inherit') ||
      skillsMode !== profile.runtime_policy.skills.mode ||
      JSON.stringify(skillIds) !==
        JSON.stringify(profile.runtime_policy.skills.ids) ||
      hostSkillsMode !== persistedHostPolicy?.mode ||
      JSON.stringify(hostSkillIds) !==
        JSON.stringify(persistedHostPolicy?.ids ?? []) ||
      mcpMode !== profile.runtime_policy.mcp.mode ||
      JSON.stringify(mcpIds) !==
        JSON.stringify(
          normalizeMcpPolicyReferences(profile.runtime_policy.mcp.ids),
        ));

  const currentRuntimePolicy = useMemo<AgentProfileRuntimePolicy | null>(
    () =>
      profile
        ? {
            ...profile.runtime_policy,
            reasoning: { effort },
            skills: {
              mode: skillsMode,
              ids: skillIds,
              host: { mode: hostSkillsMode, ids: hostSkillIds },
            },
            mcp: { mode: mcpMode, ids: mcpIds },
          }
        : null,
    [
      effort,
      hostSkillIds,
      hostSkillsMode,
      mcpIds,
      mcpMode,
      profile,
      skillIds,
      skillsMode,
    ],
  );

  const save = async () => {
    if (!profile || !dirty || capabilityError) return;
    setSaving(true);
    try {
      await api.patch(`/api/agent-profiles/${encodeURIComponent(profile.id)}`, {
        model_config_id: persistedModelConfigId,
        // Only a change is sent, so an older server never sees the field.
        ...(modelChanged ? { model: persistedModel } : {}),
        runtime_policy: {
          reasoning: { effort },
          skills: {
            mode: skillsMode,
            ids: skillIds,
            host: { mode: hostSkillsMode, ids: hostSkillIds },
          },
          mcp: { mode: mcpMode, ids: mcpIds },
        } satisfies Partial<AgentProfileRuntimePolicy>,
      });
      await loadProfiles();
      toast.success('主 HappyClaw 模型、推理档位与能力已保存');
    } catch (error) {
      toast.error(
        modelBindingErrorMessage(error) ??
          getErrorMessage(error, '保存能力失败'),
      );
    } finally {
      setSaving(false);
    }
  };

  if (profilesLoading && !profile) {
    return (
      <SettingsGroup>
        <div className="flex min-h-28 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </SettingsGroup>
    );
  }

  if (!profile) {
    return (
      <div
        role="alert"
        className="rounded-lg bg-error/10 px-3 py-2.5 text-body text-error"
      >
        无法读取当前管理员的主 HappyClaw 配置。
      </div>
    );
  }

  return (
    <>
      <SettingsSection
        title="模型与系统附加能力"
        description={
          <>
            为主智能体选择完整模型网关环境，并按来源控制 Skills 与 HappyClaw
            附加的 MCP。宿主机 Skills 可独立于宿主机 Prompt 与 Rules 启用。
          </>
        }
      >
        <div className="space-y-6">
          <SettingsGroup>
            <SettingsRow
              label="模型配置"
              description="Home 工作区、主会话、独立会话与定时任务都会继承该选择。自动选择只使用已启用配置；未启用的配置仍可在这里显式使用。"
              control={
                <Select
                  value={modelConfigId}
                  onValueChange={(next) => {
                    setModelConfigId(next);
                    // A model belongs to its configuration.
                    setModel(null);
                  }}
                >
                  <SelectTrigger
                    aria-label="主 HappyClaw 模型配置"
                    className="w-full sm:w-64"
                  >
                    <SelectValue placeholder="选择模型配置" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">
                      {defaultModel
                        ? `跟随默认模型（${defaultModel.name}）`
                        : `自动选择已启用模型（当前 ${modelConfigs.filter((item) => item.enabled).length} 个）`}
                    </SelectItem>
                    {modelConfigs.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                        {model.anthropic_model
                          ? ` · ${model.anthropic_model}`
                          : ''}
                        {!model.enabled ? '（仅显式使用）' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            {hasModelLists(modelConfigs) && (
              <SettingsRow
                label="模型"
                description="在所选模型配置里选择模型；连接默认跟随该配置设为默认的模型。自动选择模型配置时无法指定。"
                control={
                  <AgentModelSelect
                    configs={modelConfigs}
                    configId={modelConfigId}
                    value={model}
                    onChange={setModel}
                    ariaLabel="主 HappyClaw 模型"
                    className="w-full sm:w-64"
                  />
                }
              />
            )}
            <SettingsRow
              label="推理努力档位"
              description="跟随模型配置时保留 Provider 环境或 SDK 默认值；显式档位会覆盖该默认值。"
              control={
                <Select
                  value={effort}
                  onValueChange={(next) => setEffort(next as AgentEffortLevel)}
                >
                  <SelectTrigger
                    aria-label="主 HappyClaw 推理努力档位"
                    className="w-full sm:w-48"
                  >
                    <SelectValue placeholder="选择推理努力档位" />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_EFFORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <CapabilityPicker
              label="HappyClaw MCP"
              value={mcpMode}
              onValueChange={setMcpMode}
              customLabel="只允许所选 MCP"
              disabledLabel="关闭 HappyClaw MCP"
            >
              {mcpMode === 'custom' && (
                <PolicyResourcePicker
                  label="允许目录"
                  options={mcpOptions}
                  selectedIds={mcpIds}
                  onChange={setMcpIds}
                  loading={mcpLoading}
                  error={mcpError}
                  emptyText="没有已启用的 HappyClaw MCP"
                />
              )}
            </CapabilityPicker>
          </SettingsGroup>

          <AgentSkillsPolicyEditor
            managedPolicy={{ mode: skillsMode, ids: skillIds }}
            onManagedModeChange={setSkillsMode}
            onManagedIdsChange={setSkillIds}
            managedOptions={skillOptions}
            hostPolicy={{ mode: hostSkillsMode, ids: hostSkillIds }}
            onHostModeChange={setHostSkillsMode}
            onHostIdsChange={setHostSkillIds}
            hostOptions={hostSkillOptions}
            loading={skillsLoading}
            error={skillsError}
            hostAvailable
            managedError={managedSkillsError}
            hostError={hostSkillsError}
          />
        </div>

        <SettingsFormFooter>
          <Button
            onClick={() => void save()}
            disabled={!dirty || saving || !!capabilityError}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存模型与能力
          </Button>
        </SettingsFormFooter>
      </SettingsSection>

      {currentRuntimePolicy && (
        <ErrorBoundary resetKeys={[profile.id]}>
          <EffectiveCapabilitiesPreview
            profileId={profile.id}
            runtimePolicy={currentRuntimePolicy}
            workspaces={governance?.workspaces ?? []}
          />
        </ErrorBoundary>
      )}
    </>
  );
}

function profileKey(
  profiles: ReturnType<typeof useAgentProfilesStore.getState>['profiles'],
  governanceByProfile: ReturnType<
    typeof useAgentProfilesStore.getState
  >['governanceByProfile'],
) {
  const profile = profiles.find((item) => item.is_default);
  return profile ? governanceByProfile[profile.id] : undefined;
}

function CapabilityPicker({
  label,
  value,
  onValueChange,
  customLabel,
  disabledLabel,
  children,
}: {
  label: string;
  value: CapabilityMode;
  onValueChange: (mode: CapabilityMode) => void;
  customLabel: string;
  disabledLabel: string;
  children: React.ReactNode;
}) {
  return (
    <SettingsRow
      label={label}
      control={
        <Select
          value={value}
          onValueChange={(next) => onValueChange(next as CapabilityMode)}
        >
          <SelectTrigger aria-label={label} className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">使用全部已启用项</SelectItem>
            <SelectItem value="custom">{customLabel}</SelectItem>
            <SelectItem value="disabled">{disabledLabel}</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      {children}
    </SettingsRow>
  );
}
