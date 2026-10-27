import { useState } from 'react';
import { Loader2, Plus, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  isValidModelId,
  presetModelEntryId,
  splitOneMillionSuffix,
  withOneMillionSuffix,
  type ProviderErrorCode,
} from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import { errorCopy } from './model-connections';

/** One model the wizard may save with the connection. */
export interface ModelCandidate {
  /** Model id without `[1m]`: stays put while the 1M switch flips. */
  base: string;
  oneMillion: boolean;
  picked: boolean;
  name?: string;
  origin: 'preset' | 'discovered' | 'manual';
}

export function candidateId(candidate: ModelCandidate): string {
  return withOneMillionSuffix(candidate.base, candidate.oneMillion);
}

/**
 * Adds models the list does not have yet, leaving the ones it has (and the
 * user's choices on them) alone. A model of a 1M window comes in with `[1m]`.
 */
export function addCandidates(
  existing: readonly ModelCandidate[],
  models: ReadonlyArray<{ id: string; name?: string; contextWindow?: number }>,
  origin: ModelCandidate['origin'],
  picked: boolean,
): ModelCandidate[] {
  const known = new Set(existing.map((candidate) => candidate.base));
  const next = [...existing];
  for (const model of models) {
    const { model: base, oneMillion } = splitOneMillionSuffix(
      presetModelEntryId(model),
    );
    if (!base || known.has(base) || !isValidModelId(base)) continue;
    known.add(base);
    next.push({ base, oneMillion, picked, origin, name: model.name });
  }
  return next;
}

export type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; count: number; builtin: boolean }
  | {
      status: 'failed';
      code: ProviderErrorCode;
      message: string | null;
    };

interface ModelPickerProps {
  candidates: ModelCandidate[];
  onCandidatesChange: (next: ModelCandidate[]) => void;
  /** Base id of the default model; '' = none (pass-through). */
  defaultBase: string;
  onDefaultChange: (base: string) => void;
  /** Offer "no default model", for endpoints that route names themselves. */
  passThrough: { label: string; hint: string } | null;
  discovery: DiscoveryState;
  onRetryDiscovery: () => void;
  disabled?: boolean;
}

const FILTER_THRESHOLD = 12;

/** Step 3 of the wizard: which models the connection offers, and its default. */
export function ModelPicker({
  candidates,
  onCandidatesChange,
  defaultBase,
  onDefaultChange,
  passThrough,
  discovery,
  onRetryDiscovery,
  disabled = false,
}: ModelPickerProps) {
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const picked = candidates.filter((candidate) => candidate.picked);
  const query = filter.trim().toLowerCase();
  const shown = query
    ? candidates.filter(
        (candidate) =>
          candidate.base.toLowerCase().includes(query) ||
          candidate.name?.toLowerCase().includes(query),
      )
    : candidates;

  const update = (base: string, patch: Partial<ModelCandidate>) => {
    const next = candidates.map((candidate) =>
      candidate.base === base ? { ...candidate, ...patch } : candidate,
    );
    onCandidatesChange(next);
    if (patch.picked === undefined) return;
    // The default is always one of the saved models.
    if (patch.picked && !defaultBase && !passThrough) onDefaultChange(base);
    if (!patch.picked && defaultBase === base) {
      const first = next.find((candidate) => candidate.picked);
      onDefaultChange(passThrough ? '' : (first?.base ?? ''));
    }
  };

  const addManual = () => {
    const { model: base, oneMillion } = splitOneMillionSuffix(manual);
    if (!base || !isValidModelId(base)) {
      setManualError('模型名不能为空，也不能包含空格');
      return;
    }
    setManualError(null);
    setManual('');
    const existing = candidates.find((candidate) => candidate.base === base);
    if (existing) {
      update(base, { picked: true, ...(oneMillion ? { oneMillion } : {}) });
      return;
    }
    onCandidatesChange([
      ...candidates,
      { base, oneMillion, picked: true, origin: 'manual' },
    ]);
    if (!defaultBase && !passThrough) onDefaultChange(base);
  };

  return (
    <div className="space-y-3">
      <DiscoveryLine discovery={discovery} onRetry={onRetryDiscovery} />

      {candidates.length > FILTER_THRESHOLD && (
        <Input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`在 ${candidates.length} 个模型中筛选`}
          aria-label="筛选模型"
        />
      )}

      <div
        role="group"
        aria-label="可用模型"
        className="max-h-[min(22rem,45dvh)] divide-y divide-surface-border overflow-y-auto overscroll-contain rounded-lg ring-1 ring-surface-border"
      >
        {passThrough && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
            <input
              type="radio"
              name="wizard-default-model"
              checked={defaultBase === ''}
              onChange={() => onDefaultChange('')}
              disabled={disabled}
              className="size-4 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-label text-foreground">
                {passThrough.label}
              </span>
              <span className="block text-caption text-muted-foreground">
                {passThrough.hint}
              </span>
            </span>
          </label>
        )}
        {shown.map((candidate) => {
          const id = candidateId(candidate);
          const checkboxId = `wizard-model-${candidate.base}`;
          const isDefault = candidate.picked && defaultBase === candidate.base;
          return (
            <div
              key={candidate.base}
              className="flex min-h-11 items-center gap-3 px-3 py-1.5"
            >
              <Checkbox
                id={checkboxId}
                checked={candidate.picked}
                onCheckedChange={(next) =>
                  update(candidate.base, { picked: next === true })
                }
                disabled={disabled}
                aria-label={`使用 ${id}`}
              />
              <label
                htmlFor={checkboxId}
                className="min-w-0 flex-1 cursor-pointer"
              >
                <span className="block truncate font-mono text-caption text-foreground">
                  {id}
                </span>
                {(candidate.name || candidate.origin === 'manual') && (
                  <span className="block truncate text-micro text-muted-foreground">
                    {candidate.name ?? '手动添加'}
                  </span>
                )}
              </label>
              <button
                type="button"
                aria-pressed={candidate.oneMillion}
                aria-label={`${id} 使用 1M 上下文`}
                title="1M 上下文：模型名后加 [1m]"
                onClick={() =>
                  update(candidate.base, { oneMillion: !candidate.oneMillion })
                }
                disabled={disabled}
                className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 font-mono text-micro text-muted-foreground ring-1 ring-surface-border transition-colors duration-100 hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-pressed:bg-surface-selected aria-pressed:text-foreground pointer-coarse:h-8"
              >
                1M
              </button>
              <label
                className={cn(
                  'flex shrink-0 items-center gap-1.5 text-caption',
                  candidate.picked
                    ? 'cursor-pointer text-muted-foreground'
                    : 'cursor-default text-faint-foreground',
                )}
              >
                <input
                  type="radio"
                  name="wizard-default-model"
                  checked={isDefault}
                  onChange={() => onDefaultChange(candidate.base)}
                  disabled={disabled || !candidate.picked}
                  aria-label={`把 ${id} 设为默认模型`}
                  className="size-4 accent-primary"
                />
                <span className="max-sm:sr-only">默认</span>
              </label>
            </div>
          );
        })}
        {candidates.length === 0 && discovery.status !== 'loading' && (
          <p className="px-3 py-4 text-caption text-muted-foreground">
            还没有模型。在下方手动添加，或重新获取模型列表。
          </p>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex gap-2">
          <Input
            value={manual}
            onChange={(event) => {
              setManual(event.target.value);
              setManualError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                addManual();
              }
            }}
            placeholder="手动添加模型名，例如 glm-5.3 或 glm-5.3[1m]"
            aria-label="手动添加模型"
            autoComplete="off"
            disabled={disabled}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            variant="outline"
            onClick={addManual}
            disabled={disabled || !manual.trim()}
          >
            <Plus />
            添加
          </Button>
        </div>
        {manualError && (
          <p role="alert" className="text-caption text-error">
            {manualError}
          </p>
        )}
      </div>

      <p className="text-caption text-muted-foreground">
        已选 {picked.length} 个模型
        {defaultBase
          ? ` · 默认 ${candidateId(
              candidates.find(
                (candidate) => candidate.base === defaultBase,
              ) ?? {
                base: defaultBase,
                oneMillion: false,
                picked: true,
                origin: 'manual',
              },
            )}`
          : passThrough
            ? ' · 不指定默认模型'
            : ''}
      </p>
    </div>
  );
}

function DiscoveryLine({
  discovery,
  onRetry,
}: {
  discovery: DiscoveryState;
  onRetry: () => void;
}) {
  if (discovery.status === 'loading') {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-caption text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        正在获取模型列表…
      </p>
    );
  }
  if (discovery.status === 'done') {
    return (
      <p className="text-caption text-muted-foreground">
        {discovery.builtin
          ? '这类连接使用内置的模型别名。'
          : `从服务商获取到 ${discovery.count} 个模型；新发现的默认不勾选。`}
      </p>
    );
  }
  if (discovery.status !== 'failed') return null;
  const copy = errorCopy(discovery.code);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5"
    >
      <TriangleAlert
        className="mt-0.5 size-3.5 shrink-0 text-warning"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="text-foreground">没能获取模型列表：{copy.title}</div>
        <div className="text-muted-foreground">
          {copy.hint}仍可使用下方的模型或手动添加。
        </div>
        {discovery.message && (
          <div className="mt-0.5 font-mono text-micro break-all text-faint-foreground">
            {discovery.message}
          </div>
        )}
      </div>
      <Button variant="ghost" size="xs" onClick={onRetry} className="shrink-0">
        <RotateCcw />
        重试
      </Button>
    </div>
  );
}
