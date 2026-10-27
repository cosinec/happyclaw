import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelConfigOption } from '../../types';

const DEFAULT_MODEL_VALUE = '__default__';

/** Whether the server lists the models an Agent may pin; older ones do not. */
export function hasModelLists(configs: ModelConfigOption[]): boolean {
  return configs.some((config) => Array.isArray(config.models));
}

/**
 * The (configuration, model) fields a save of an Agent changes. A pinned
 * model always travels with its configuration, which the server checks it
 * against; an unchanged model is left out, so an older server never sees it.
 * Nothing is pinned while the configuration is automatic (`configId` null).
 */
export function modelBindingChanges(
  saved: { model_config_id: string | null; model?: string | null },
  configId: string | null,
  model: string | null,
): { model_config_id?: string | null; model?: string | null } {
  const pinned = configId ? model : null;
  const changes: { model_config_id?: string | null; model?: string | null } =
    {};
  if (configId !== saved.model_config_id) changes.model_config_id = configId;
  if (pinned !== (saved.model ?? null)) {
    changes.model = pinned;
    if (pinned) changes.model_config_id = configId;
  }
  return changes;
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
