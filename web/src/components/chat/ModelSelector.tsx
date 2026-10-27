import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  LayoutGrid,
  Loader2,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { splitOneMillionSuffix } from '@/lib/model-providers';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IconButton } from '@/components/common/IconButton';
import { api } from '../../api/client';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useAuthStore } from '../../stores/auth';
import {
  effortLabel,
  modelBindingErrorMessage,
} from '../settings/model-connections';
import { getErrorMessage } from '../settings/types';

/** One model a ChatGPT login may run, with the efforts this user may pick on it. */
export interface CodexModelChoice {
  value: string;
  label: string;
  /** Low to high; levels the user may not pick are not listed. */
  efforts: string[];
  /** What the model runs at when no effort is picked. */
  defaultEffort: string;
}

export interface CodexSelectionView {
  /** The configuration's own model: what "default" runs. */
  defaultModel: string;
  defaultEffort: string;
  /** `live` is the account's own list; anything else is a fallback. */
  source: string;
  /** The login was rejected and has to be redone before it can run. */
  needsReauth: boolean;
  models: CodexModelChoice[];
}

/** One model of a non-ChatGPT configuration. */
export interface ConnectionModelChoice {
  id: string;
  /** Left out of the menu unless the conversation already runs on it. */
  hidden: boolean;
}

export interface SessionModelOption {
  id: string;
  name: string;
  kind: 'official' | 'third_party' | 'codex';
  enabled: boolean;
  /** The configuration's default model; '' lets a relay decide. */
  model: string;
  /** False when the configuration holds no credential and would fail. */
  usable?: boolean;
  /** Present on ChatGPT configurations: the models and efforts to choose from. */
  codex?: CodexSelectionView;
  /**
   * The models a non-ChatGPT configuration offers, its default included.
   * Older servers send none and the configuration stays a single row.
   */
  models?: ConnectionModelChoice[];
}

export interface SessionModelSelection {
  selectedModelConfigId: string | null;
  /**
   * The model picked within the selected configuration; null follows its
   * default. Older servers do not send this nor the effort.
   */
  selectedModel?: string | null;
  selectedEffort?: string | null;
  default: {
    source: 'agent' | 'default' | 'single' | 'pool' | 'workspace_env' | 'none';
    modelConfigId: string | null;
    enabledCount: number;
    /**
     * The model the default runs on that connection: what a launch with no
     * pick would use. Null for the pool and the workspace override; older
     * servers do not send it.
     */
    model?: string | null;
  };
  options: SessionModelOption[];
}

/** Human label for "what the default resolves to" in this conversation. */
export function describeDefaultModel(selection: SessionModelSelection): string {
  const { source, modelConfigId, enabledCount, model } = selection.default;
  const named = selection.options.find((option) => option.id === modelConfigId);
  switch (source) {
    case 'agent':
    case 'default':
    case 'single':
      // A ChatGPT configuration is named by the model it runs; the others by
      // name and, when known, the model.
      if (named?.codex) return model || named.codex.defaultModel;
      if (!named) return '默认';
      return model ? `${named.name} · ${modelLabel(model)}` : named.name;
    case 'pool':
      return `自动 · ${enabledCount} 个`;
    case 'workspace_env':
      return '工作区环境变量';
    default:
      return '系统默认';
  }
}

function defaultHint(selection: SessionModelSelection): string {
  switch (selection.default.source) {
    case 'agent':
      return '跟随智能体绑定的模型配置';
    case 'default':
      return '使用模型配置里设为默认的模型';
    case 'pool':
      return '未设置默认模型，在已启用的模型配置间自动选择';
    case 'workspace_env':
      return '使用工作区环境变量中的模型网关';
    case 'single':
      return '使用唯一启用的模型配置';
    default:
      return '使用系统设置';
  }
}

/**
 * Why a configuration is listed but cannot be chosen ('' when it can).
 * Whether it is in the automatic pool is left to Settings: an explicit pick
 * ignores the pool.
 */
function optionStatus(option: SessionModelOption): string {
  if (option.usable === false) return '缺少凭据';
  if (option.codex?.needsReauth) return '需重新登录';
  return '';
}

/** A model id for a label, with the 1M context window spelled out. */
function modelLabel(id: string): string {
  const { model, oneMillion } = splitOneMillionSuffix(id);
  return oneMillion ? `${model}（1M）` : model;
}

function ownModel(option: SessionModelOption): string {
  return option.codex ? option.codex.defaultModel : option.model;
}

/**
 * The connection and model the conversation runs on: the pick, or what the
 * default resolves to (the server sends a connection only for an Agent, the
 * global default or a single enabled one). '' when nothing names a model.
 */
function modelInUse(selection: SessionModelSelection): {
  option: SessionModelOption | null;
  model: string;
} {
  const selected = selection.options.find(
    (option) => option.id === selection.selectedModelConfigId,
  );
  if (selected) {
    return {
      option: selected,
      model: selection.selectedModel || ownModel(selected),
    };
  }
  const option =
    selection.options.find(
      (item) => item.id === selection.default.modelConfigId,
    ) ?? null;
  return {
    option,
    model:
      selection.default.model ||
      (option?.codex ? option.codex.defaultModel : ''),
  };
}

const DEFAULT_ROW_KEY = '__default__';

/** One row of the panel: what picking it saves and how it reads. */
interface ModelRow {
  key: string;
  option: SessionModelOption;
  /** The model picking this pins; null follows the connection's own. */
  pick: string | null;
  /** The model shown; '' when a relay decides. */
  id: string;
  note?: string;
}

function rowKey(optionId: string, id: string): string {
  return `${optionId}:${id}`;
}

/**
 * The rows a configuration offers. Hidden models are left out unless
 * `pinned` names one, and a pinned model the list lacks stays too, so the
 * panel shows what is really selected. An older server (no list) gives one
 * row standing for the configuration.
 */
function optionRows(
  option: SessionModelOption,
  pinned: string | null,
): ModelRow[] {
  const defaultModel = ownModel(option);
  const listed = option.codex
    ? option.codex.models.map((model) => ({ id: model.value, hidden: false }))
    : option.models;
  const row = (id: string, note?: string): ModelRow => ({
    key: rowKey(option.id, id),
    option,
    pick: id === defaultModel ? null : id,
    id,
    note,
  });
  if (!listed?.length) return [row(defaultModel)];
  const rows: ModelRow[] = [];
  if (
    pinned &&
    pinned !== defaultModel &&
    !listed.some((model) => model.id === pinned)
  ) {
    rows.push(
      row(pinned, option.codex ? '不在账号的模型列表里' : '不在模型列表里'),
    );
  }
  // A relay without a model of its own still lets the relay decide.
  if (!option.codex && !defaultModel) rows.push(row(''));
  for (const model of listed) {
    if (!model.hidden) rows.push(row(model.id));
    else if (model.id === pinned) rows.push(row(model.id, '已隐藏'));
  }
  return rows;
}

/**
 * The configuration, model and effort the conversation actually runs on, when
 * that is a ChatGPT login the effort control can act on. An automatic pool, a
 * workspace override or another kind of configuration has none.
 */
export function resolveEffortContext(selection: SessionModelSelection): {
  option: SessionModelOption;
  model: CodexModelChoice | null;
  /** Null when the conversation follows the default effort. */
  effort: string | null;
  /** The model to send back with an effort: only an explicit pick. */
  pinnedModel: string | null;
} | null {
  const { option, model } = modelInUse(selection);
  if (!option?.codex) return null;
  const picked = !!selection.selectedModelConfigId;
  return {
    option,
    model: option.codex.models.find((item) => item.value === model) ?? null,
    effort: picked ? (selection.selectedEffort ?? null) : null,
    pinnedModel: picked ? (selection.selectedModel ?? null) : null,
  };
}

/**
 * The composer's model control: plain text at rest, a filled pill on hover
 * or while open. The label truncates; the tooltip carries the full name.
 */
const TRIGGER_CLASS =
  'inline-flex h-[30px] max-w-[240px] min-w-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-label font-medium text-foreground transition-colors duration-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=open]:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:h-10';

interface ModelSelectorProps {
  groupJid: string;
  /** Runtime Session id; null addresses the main conversation. */
  agentId: string | null;
  canChange: boolean;
}

export function ModelSelector({
  groupJid,
  agentId,
  canChange,
}: ModelSelectorProps) {
  const navigate = useNavigate();
  const canManageModels = useAuthStore((s) =>
    s.hasPermission('manage_system_config'),
  );
  // Phones get the same panel in a bottom sheet.
  const phone = useMediaQuery('(max-width: 639px)');
  const [selection, setSelection] = useState<SessionModelSelection | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Focus returns to the button when the panel closes; that alone must not
  // pop the tooltip up over what was just picked. Leaving the button resets it.
  const tooltipMuted = useRef(false);
  const lastRefreshAt = useRef(0);
  // Bumped by every save: a look-up that started before one must not put an
  // older selection back over the saved one.
  const saves = useRef(0);
  const basePath = `/api/groups/${encodeURIComponent(groupJid)}/model-selection`;
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';

  const load = useCallback(async () => {
    try {
      setSelection(await api.get<SessionModelSelection>(`${basePath}${query}`));
    } catch {
      // Older server or no access: the picker simply stays hidden.
      setSelection(null);
    }
  }, [basePath, query]);

  useEffect(() => {
    lastRefreshAt.current = Date.now();
    void load();
  }, [load]);

  // The first list of a ChatGPT login is the global catalog until the server
  // has fetched the account's own: look again when the panel is opened. A
  // failed look keeps what is shown.
  const refreshCatalog = () => {
    if (
      Date.now() - lastRefreshAt.current < 5_000 ||
      !selection?.options.some(
        (option) => option.codex && option.codex.source !== 'live',
      )
    ) {
      return;
    }
    lastRefreshAt.current = Date.now();
    const startedAt = saves.current;
    api
      .get<SessionModelSelection>(`${basePath}${query}`)
      .then((next) => {
        if (saves.current === startedAt) setSelection(next);
      })
      .catch(() => {});
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) tooltipMuted.current = true;
    setTooltipOpen(false);
    setOpen(next);
    if (next) refreshCatalog();
  };

  const save = async (
    body: {
      modelConfigId: string | null;
      model?: string | null;
      effort?: string | null;
    },
    success: (next: SessionModelSelection) => string,
  ) => {
    if (saving) return;
    saves.current += 1;
    setSaving(true);
    try {
      const next = await api.put<SessionModelSelection>(basePath, {
        agentId,
        ...body,
      });
      setSelection(next);
      toast.success(success(next));
    } catch (err) {
      toast.error(
        modelBindingErrorMessage(err) ?? getErrorMessage(err, '切换模型失败'),
      );
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (!selection || selection.options.length === 0) return null;

  const pinnedModel = selection.selectedModelConfigId
    ? (selection.selectedModel ?? null)
    : null;
  const inUse = modelInUse(selection);
  const picked = !!selection.selectedModelConfigId && !!inUse.option;
  const selectedKey =
    picked && inUse.option
      ? rowKey(inUse.option.id, inUse.model)
      : DEFAULT_ROW_KEY;
  const effortContext = resolveEffortContext(selection);
  // The trigger names the model in use, without a 「默认 ·」 prefix.
  const triggerName = inUse.model
    ? splitOneMillionSuffix(inUse.model).model
    : (inUse.option?.name ?? describeDefaultModel(selection));
  const shownEffort = effortContext?.model
    ? (effortContext.effort ?? effortContext.model.defaultEffort)
    : null;
  const fullLabel = inUse.model
    ? [inUse.option?.name, modelLabel(inUse.model)].filter(Boolean).join(' · ')
    : triggerName;
  const tooltip = [
    picked ? fullLabel : `默认 · ${fullLabel}`,
    shownEffort ? `推理档位 ${effortLabel(shownEffort)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const pickRow = (row: ModelRow | null) => {
    const modelConfigId = row ? row.option.id : null;
    const model = row?.pick ?? null;
    if (
      modelConfigId === selection.selectedModelConfigId &&
      model === pinnedModel
    ) {
      return;
    }
    const option = row?.option;
    if (!option?.codex) {
      if (option && model) {
        void save(
          { modelConfigId, model },
          () =>
            `已切换到「${option.name} · ${modelLabel(model)}」，从下一条消息开始生效`,
        );
        return;
      }
      // Exactly the request older servers understand.
      void save({ modelConfigId }, (next) => {
        const chosen = next.options.find((item) => item.id === modelConfigId);
        return chosen
          ? `已切换到「${chosen.name}」，从下一条消息开始生效`
          : '已恢复默认模型，从下一条消息开始生效';
      });
      return;
    }
    // A model keeps the effort picked before only if it has that level;
    // otherwise the conversation returns to the model's default.
    const modelToRun = model ?? option.codex.defaultModel;
    const choice = option.codex.models.find(
      (item) => item.value === modelToRun,
    );
    const keptEffort =
      modelConfigId === selection.selectedModelConfigId
        ? (selection.selectedEffort ?? null)
        : null;
    const effort =
      keptEffort && choice?.efforts.includes(keptEffort) ? keptEffort : null;
    void save({ modelConfigId, model, effort }, () => {
      const base = `已切换到「${option.name} · ${modelToRun}」，从下一条消息开始生效`;
      return keptEffort && !effort && choice
        ? `${base}；该模型不支持 ${effortLabel(keptEffort)}，档位已恢复为默认（${effortLabel(choice.defaultEffort)}）`
        : base;
    });
  };

  const pickEffort = (effort: string | null) => {
    if (!effortContext || effort === effortContext.effort) return;
    void save(
      {
        modelConfigId: effortContext.option.id,
        model: effortContext.pinnedModel,
        effort,
      },
      () =>
        effort
          ? `推理档位已设为${effortLabel(effort)}，从下一个请求开始生效`
          : '已恢复默认推理档位，从下一个请求开始生效',
    );
  };

  const disabled = !canChange || saving;
  const panel = (
    <ModelPanel
      selection={selection}
      pinnedModel={pinnedModel}
      selectedKey={selectedKey}
      effortContext={effortContext}
      disabled={disabled}
      onPick={(row) => {
        handleOpenChange(false);
        pickRow(row);
      }}
      onPickEffort={pickEffort}
      onManage={
        canManageModels
          ? () => {
              handleOpenChange(false);
              navigate('/settings?tab=claude');
            }
          : null
      }
    />
  );

  // Phones open the same panel as a bottom sheet; both roots hand the
  // trigger its open state and popup semantics.
  const Root = phone ? Sheet : Popover;
  const Trigger = phone ? SheetTrigger : PopoverTrigger;
  return (
    <Root open={open} onOpenChange={handleOpenChange}>
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(next) => setTooltipOpen(next && !tooltipMuted.current)}
      >
        <Trigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={`模型：${fullLabel}`}
              // A disabled button gets no tooltip; the title still reads.
              title={disabled ? tooltip : undefined}
              onPointerLeave={() => {
                tooltipMuted.current = false;
              }}
              onBlur={() => {
                tooltipMuted.current = false;
              }}
              className={TRIGGER_CLASS}
            >
              {saving && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
              <span className="min-w-0 truncate">{triggerName}</span>
              {shownEffort && (
                <span className="shrink-0 font-normal text-muted-foreground">
                  {effortLabel(shownEffort)}
                </span>
              )}
              {canChange && (
                <ChevronDown
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </button>
          </TooltipTrigger>
        </Trigger>
        <TooltipContent side="top">{tooltip}</TooltipContent>
      </Tooltip>
      {phone ? (
        <SheetContent
          side="bottom"
          className="gap-0 p-0 data-[side=bottom]:h-[80dvh]"
          // Focus the sheet, not the search field: a phone keyboard would
          // cover the list.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <SheetHeader className="shrink-0 border-b border-surface-border px-4 py-3 pr-12">
            <SheetTitle className="text-title-sm">选择模型</SheetTitle>
            <SheetDescription className="sr-only">
              本会话使用的模型
            </SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      ) : (
        <PopoverContent
          side="top"
          align="start"
          collisionPadding={8}
          aria-label="选择模型"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(460px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-xl p-0"
        >
          {panel}
        </PopoverContent>
      )}
    </Root>
  );
}

interface ModelPanelProps {
  selection: SessionModelSelection;
  /** The model picked within the selected configuration, if any. */
  pinnedModel: string | null;
  selectedKey: string;
  effortContext: ReturnType<typeof resolveEffortContext>;
  disabled: boolean;
  /** Null picks the default. */
  onPick: (row: ModelRow | null) => void;
  onPickEffort: (effort: string | null) => void;
  onManage: (() => void) | null;
}

/**
 * The model panel after cindy's unified selector: a search field, a rail of
 * connections that filters the list, two-line rows with a check on the one
 * in use, the ChatGPT effort under its row, and the way to Settings.
 */
function ModelPanel({
  selection,
  pinnedModel,
  selectedKey,
  effortContext,
  disabled,
  onPick,
  onPickEffort,
  onManage,
}: ModelPanelProps) {
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState<string>('all');
  const listRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  const hasCodex = selection.options.some((option) => option.codex);
  // A search looks through every connection, whatever the rail shows.
  const rows = selection.options
    .filter((option) => needle || rail === 'all' || option.id === rail)
    .flatMap((option) =>
      optionRows(
        option,
        option.id === selection.selectedModelConfigId ? pinnedModel : null,
      ).filter(
        (row) =>
          !needle ||
          row.id.toLowerCase().includes(needle) ||
          option.name.toLowerCase().includes(needle),
      ),
    );
  const showDefault =
    rail === 'all' &&
    (!needle || '默认'.includes(needle) || 'default'.includes(needle));
  const showRail = (id: string) => {
    setRail(id);
    setQuery('');
  };

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-model-row]:not(:disabled)',
      ) ?? []),
    ];
    if (items.length === 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      index < 0
        ? step > 0
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, index + step));
    items[next].focus();
  };

  // The effort belongs to whichever row the conversation runs on.
  const effortStrip = (key: string) =>
    effortContext && key === selectedKey ? (
      <EffortStrip
        context={effortContext}
        disabled={disabled || !!optionStatus(effortContext.option)}
        onPick={onPickEffort}
      />
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={moveFocus}>
      <div className="relative shrink-0 border-b border-surface-border">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型"
          aria-label="搜索模型"
          className="h-10 w-full bg-transparent pr-3 pl-9 text-body text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex h-[min(26rem,60dvh)] min-h-0 flex-1">
        <div
          role="group"
          aria-label="模型配置"
          className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-surface-border py-2"
        >
          <RailButton
            label="全部"
            active={rail === 'all' && !needle}
            onClick={() => showRail('all')}
          >
            <LayoutGrid className="size-4" aria-hidden="true" />
          </RailButton>
          {selection.options.map((option) => (
            <RailButton
              key={option.id}
              label={option.name}
              active={rail === option.id && !needle}
              onClick={() => showRail(option.id)}
            >
              <Monogram option={option} />
            </RailButton>
          ))}
        </div>

        <div
          ref={listRef}
          role="radiogroup"
          aria-label="本会话使用的模型"
          className="min-w-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5"
        >
          {showDefault && (
            <>
              <RowButton
                checked={selectedKey === DEFAULT_ROW_KEY}
                disabled={disabled}
                onClick={() => onPick(null)}
                mark={
                  <MarkTile>
                    <Sparkles className="size-3.5" aria-hidden="true" />
                  </MarkTile>
                }
                title={`默认 · ${describeDefaultModel(selection)}`}
                detail={defaultHint(selection)}
              />
              {effortStrip(DEFAULT_ROW_KEY)}
            </>
          )}
          {rows.map((row) => {
            const { model, oneMillion } = splitOneMillionSuffix(row.id);
            const status = optionStatus(row.option);
            return (
              <div key={row.key}>
                <RowButton
                  checked={row.key === selectedKey}
                  disabled={disabled || !!status}
                  onClick={() => onPick(row)}
                  mark={<Monogram option={row.option} />}
                  title={model || '由中转站决定'}
                  detail={[
                    row.option.name,
                    oneMillion ? '1M 上下文' : null,
                    row.note,
                    status,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
                {effortStrip(row.key)}
              </div>
            );
          })}
          {rows.length === 0 && !showDefault && (
            <p className="px-3 py-6 text-center text-caption text-muted-foreground">
              没有匹配的模型
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-1 border-t border-surface-border px-3 py-2">
        <p className="text-micro leading-4 text-muted-foreground">
          {hasCodex
            ? '切换模型会开启新的底层会话，并自动带上最近的对话记录；只调整推理档位不会。'
            : '切换模型会开启新的底层会话，并自动带上最近的对话记录。'}
        </p>
        {onManage && (
          <button
            type="button"
            onClick={onManage}
            className="-ml-1.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-primary-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Settings2 className="size-3.5" aria-hidden="true" />
            管理模型配置
          </button>
        )}
      </div>
    </div>
  );
}

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      label={label}
      icon={children}
      tooltipSide="right"
      size="icon"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'size-9 rounded-lg',
        active
          ? 'bg-surface-selected text-foreground hover:bg-surface-selected'
          : 'text-muted-foreground',
      )}
    />
  );
}

/** The rounded tile a row's or rail item's mark sits in. */
function MarkTile({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-selected text-caption font-semibold text-muted-foreground"
    >
      {children}
    </span>
  );
}

/**
 * A connection's mark: a letter in a tile. A ChatGPT login reads as G so it
 * does not look like a Claude one; the others take the first letter of their
 * name.
 */
function Monogram({ option }: { option: SessionModelOption }) {
  return (
    <MarkTile>
      {option.kind === 'codex'
        ? 'G'
        : (Array.from(option.name.trim())[0]?.toUpperCase() ?? '?')}
    </MarkTile>
  );
}

function RowButton({
  checked,
  disabled,
  onClick,
  mark,
  title,
  detail,
}: {
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  mark: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-model-row=""
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100 outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        checked && 'bg-surface-selected hover:bg-surface-selected',
      )}
    >
      {mark}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-foreground">
          {title}
        </span>
        <span className="block truncate text-caption text-muted-foreground">
          {detail}
        </span>
      </span>
      {checked && (
        <Check
          className="size-4 shrink-0 text-primary-text"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

/** The reasoning efforts of the ChatGPT model in use, under its row. */
function EffortStrip({
  context,
  disabled,
  onPick,
}: {
  context: NonNullable<ReturnType<typeof resolveEffortContext>>;
  disabled: boolean;
  onPick: (effort: string | null) => void;
}) {
  const choice = context.model;
  if (!choice) {
    return (
      <p className="pr-2 pb-1.5 pl-12 text-micro text-muted-foreground">
        当前模型不在账号的模型列表里，无法设置推理档位
      </p>
    );
  }
  const chips: Array<{ value: string | null; label: string }> = [
    { value: null, label: `默认 · ${effortLabel(choice.defaultEffort)}` },
    ...choice.efforts.map((effort) => ({
      value: effort,
      label: effortLabel(effort),
    })),
  ];
  return (
    <div
      role="radiogroup"
      aria-label="推理档位"
      className="flex flex-wrap gap-1 pr-2 pb-1.5 pl-12"
    >
      {chips.map((chip) => {
        const checked = context.effort === chip.value;
        return (
          <button
            key={chip.value ?? 'default'}
            type="button"
            role="radio"
            aria-checked={checked}
            data-effort={chip.value ?? 'default'}
            disabled={disabled}
            onClick={() => onPick(chip.value)}
            title={chip.value ?? `跟随默认（${choice.defaultEffort}）`}
            className={cn(
              'inline-flex h-6 cursor-pointer items-center rounded-full px-2 text-caption ring-1 transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-8',
              checked
                ? 'bg-surface-selected font-medium text-foreground ring-surface-selected'
                : 'text-muted-foreground ring-surface-border hover:bg-surface-hover hover:text-foreground',
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
