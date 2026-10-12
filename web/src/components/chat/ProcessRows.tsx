import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  Bot,
  ChevronRight,
  FileText,
  FolderSearch,
  Globe,
  Loader2,
  MessageSquare,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  StreamingState,
  StreamingTaskRuntimeState,
} from '../../stores/chat';
import {
  cleanToolSummary,
  describeGroup,
  describeStepCall,
  groupProcessSteps,
  hasListedSteps,
  isQuestionStep,
  processSpanMs,
  stepDurationMs,
  summarizeGroup,
  toolCategory,
  visibleSteps,
  type ProcessItem,
  type ToolCategory,
} from '../../lib/process-steps';
import {
  buildTimelineView,
  summarizeSteps,
  type StreamingStep,
} from '../../lib/stream-steps';
import { stripInlineMarkdown } from '../../lib/thinking-text';
import { formatRunElapsed } from '../../lib/run-phase';
import { useTick } from '../../hooks/useTick';
import { formatElapsedMs } from '../../utils/format-elapsed';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { ModelWaitRow } from './ModelWaitRow';
import { STATUS_LABELS, SubAgentBody, subAgentHasBody } from './SubAgentCard';
import { ThinkingBody } from './ThinkingBlock';
import { describeToolName } from './ToolActivityCard';
import { FinalMarkdown } from './StreamingMarkdown';
import { WorkflowRunCard } from './WorkflowRunCard';
import { isWorkflowTask, workflowRunOf } from './workflow-run';

/** A wait between tools shows its placeholder only once it has lasted a moment. */
export const LATER_WAIT_DELAY_MS = 800;

const EMPTY_TASKS: Record<string, StreamingTaskRuntimeState> = {};

// ── one row ─────────────────────────────────────────────────────────────

const ROW_CLASS =
  'flex min-h-7 w-full items-center gap-2 rounded-md px-1 text-left font-sans text-label pointer-coarse:min-h-10';
const ROW_BUTTON_CLASS =
  'cursor-pointer transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none';
const ICON_CLASS = 'size-3.5 shrink-0';

type Tone = 'quiet' | 'active' | 'error';

const ICON_TONE: Record<Tone, string> = {
  quiet: 'text-faint-foreground',
  active: 'text-muted-foreground',
  error: 'text-error',
};

function RowIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: Tone }) {
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        ICON_CLASS,
        ICON_TONE[tone],
        Icon === Loader2 && 'animate-spin motion-reduce:animate-none',
      )}
    />
  );
}

interface RowFrameProps {
  icon: ReactNode;
  label: ReactNode;
  /** The label takes the free width (a title, a line of text); else `detail` does. */
  grow?: boolean;
  /** Second-hand information: what the call was given, why it failed. */
  detail?: ReactNode;
  /** The detail is a command or a path. */
  mono?: boolean;
  /** How long it took, or has taken so far. */
  time?: string;
  tone?: Tone;
  /** The row is going on right now: its label shimmers. */
  running?: boolean;
  /** Spoken after the row, for what the icon shows. */
  status?: string;
  /** The tooltip of the whole row. */
  title?: string;
  /** Present when the row opens: it is then a button. */
  open?: boolean;
  onToggle?: () => void;
  /** The row's own icon is the chevron: it takes no second one at the end. */
  endChevron?: boolean;
  panelId?: string;
  /** What opens under the row. */
  children?: ReactNode;
}

/**
 * Every row of the process timeline has this shape: icon, label, second-hand
 * information that takes what room is left, the time on the right, and a
 * chevron when the row opens. One skeleton for reasoning, tools, notes and
 * groups is what makes the list read as one list.
 */
function RowFrame({
  icon,
  label,
  grow = false,
  detail,
  mono = false,
  time,
  tone = 'quiet',
  running = false,
  status,
  title,
  open = false,
  onToggle,
  endChevron = true,
  panelId,
  children,
}: RowFrameProps) {
  const expandable = onToggle !== undefined;
  const content = (
    <>
      {icon}
      <span
        className={cn(
          grow ? 'min-w-0 flex-1 truncate' : 'shrink-0 font-medium',
          tone === 'quiet' && !running
            ? 'text-muted-foreground'
            : 'text-foreground',
          running && 'shimmer',
        )}
      >
        {label}
      </span>
      {!grow &&
        (detail ? (
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              mono && 'font-mono text-caption',
              tone === 'error'
                ? 'text-error'
                : running
                  ? 'text-muted-foreground'
                  : 'text-faint-foreground',
            )}
          >
            {detail}
          </span>
        ) : (
          <span className="flex-1" />
        ))}
      {time && (
        <span className="shrink-0 text-caption text-faint-foreground tabular-nums">
          {time}
        </span>
      )}
      {/* Rows that do not open keep the chevron's room, so the times line up. */}
      {!endChevron ? null : expandable ? (
        <ChevronRight
          className={cn(
            ICON_CLASS,
            'text-faint-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
          aria-hidden="true"
        />
      ) : (
        <span aria-hidden="true" className={ICON_CLASS} />
      )}
      {status && <span className="sr-only">{status}</span>}
    </>
  );
  return (
    <>
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          title={title}
          className={cn(ROW_CLASS, ROW_BUTTON_CLASS)}
        >
          {content}
        </button>
      ) : (
        <div title={title} className={ROW_CLASS}>
          {content}
        </div>
      )}
      {open && children && (
        // Under the label: the icon and its gap are 26px with the row's padding.
        <div id={panelId} className="mb-1 ml-6.5">
          {children}
        </div>
      )}
    </>
  );
}

/** A running row's time so far; nothing in its first second. */
function elapsedLabel(now: number, at: number): string | undefined {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds >= 1 ? formatRunElapsed(seconds) : undefined;
}

function durationLabel(step: StreamingStep): string | undefined {
  const ms = stepDurationMs(step);
  return ms != null ? formatElapsedMs(ms) || undefined : undefined;
}

// ── reasoning ───────────────────────────────────────────────────────────

interface RowProps<Item = StreamingStep> {
  step: Item;
  open: boolean;
  onToggle: (id: string, next: boolean) => void;
  /** The clock a running row counts by (0 for the rows that are not running). */
  now: number;
  /** The run is producing this card now: what is running here is running. */
  live: boolean;
  groupJid: string;
}

const ThinkingRow = memo(function ThinkingRow({
  step,
  open,
  onToggle,
  now,
  live,
  groupJid,
  thinkingText,
  bodyClassName,
}: RowProps & { thinkingText: boolean; bodyClassName?: string }) {
  const panelId = useId();
  const running = step.status === 'running' && live;
  const text = thinkingText ? (step.text ?? '') : '';
  const title = thinkingText ? step.title : undefined;
  const canOpen = text.trim().length > 0;
  const durationMs =
    step.status === 'running' ? undefined : stepDurationMs(step);
  // The model reasoned, for a while, and returned no summary of it. Say so
  // instead of leaving a row that looks as if it could be opened. Not when the
  // text is only withheld from this view.
  const noSummary =
    thinkingText &&
    step.status !== 'running' &&
    !canOpen &&
    durationMs != null &&
    durationMs >= 1000;
  return (
    <RowFrame
      icon={<RowIcon icon={Sparkles} tone={running ? 'active' : 'quiet'} />}
      label={title || '思考'}
      grow={!!title}
      detail={
        noSummary ? (
          <span
            title="这个模型只返回加密的推理，不提供可读的思考摘要（ChatGPT 订阅的 GPT-6 系列多数如此）。"
            data-hc-no-summary=""
          >
            模型未返回思考内容
          </span>
        ) : undefined
      }
      time={
        running
          ? elapsedLabel(now, step.at)
          : durationMs != null
            ? formatElapsedMs(durationMs) || undefined
            : undefined
      }
      running={running}
      status={running ? '，进行中' : undefined}
      open={open && canOpen}
      onToggle={canOpen ? () => onToggle(step.id, !open) : undefined}
      panelId={panelId}
    >
      <ThinkingBody
        text={text}
        live={running}
        groupJid={groupJid}
        variant="row"
        className={bodyClassName}
      />
    </RowFrame>
  );
});

// ── tools ───────────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  terminal: Terminal,
  file: FileText,
  search: Search,
  web: Globe,
  generic: Wrench,
};

/** A summary that is long enough to be cut short in its row opens to be read. */
const LONG_SUMMARY_CHARS = 80;

const ToolStepRow = memo(function ToolStepRow({
  step,
  open,
  onToggle,
  now,
  live,
}: RowProps) {
  const panelId = useId();
  const name = step.toolName ?? 'unknown';
  const { hint } = describeToolName(name, step.skillName);
  const { verb, param } = describeStepCall(step);
  const summary = cleanToolSummary(step.summary);
  const running = step.status === 'running' && live;
  const failed = step.status === 'error';
  const failure = failed ? step.resultPreview : undefined;
  const longSummary =
    !!summary &&
    (summary.length > LONG_SUMMARY_CHARS || summary.includes('\n'));
  const expandable = !!failure || longSummary;
  const icon = running
    ? Loader2
    : failed
      ? X
      : CATEGORY_ICON[toolCategory(name)];
  return (
    <RowFrame
      icon={
        <RowIcon
          icon={icon}
          tone={failed ? 'error' : running ? 'active' : 'quiet'}
        />
      }
      label={verb}
      detail={failure || param}
      mono={!failure && name === 'Bash'}
      time={
        running
          ? elapsedLabel(now, step.at)
          : step.status === 'running'
            ? undefined
            : durationLabel(step)
      }
      tone={failed ? 'error' : running ? 'active' : 'quiet'}
      running={running}
      status={running ? '，运行中' : failed ? '，失败' : '，已完成'}
      title={summary ?? hint}
      open={open && expandable}
      onToggle={expandable ? () => onToggle(step.id, !open) : undefined}
      panelId={panelId}
    >
      <div className="space-y-1 text-caption break-words">
        {summary && (
          <p
            className={cn(
              'max-h-32 overflow-y-auto overscroll-contain whitespace-pre-wrap text-muted-foreground',
              name === 'Bash' && 'font-mono',
            )}
          >
            {summary}
          </p>
        )}
        {failure && <p className="text-error">{failure}</p>}
      </div>
    </RowFrame>
  );
});

const ReadGroupRow = memo(
  function ReadGroupRow({
    group,
    override,
    onToggle,
    now,
    live,
    groupJid,
    open,
  }: Omit<RowProps<never>, 'step'> & {
    group: Extract<ProcessItem, { type: 'group' }>;
    override: Readonly<Record<string, boolean>>;
  }) {
    const panelId = useId();
    const summary = summarizeGroup(group.steps);
    const running = live && summary.running > 0;
    const failed = summary.failed > 0;
    const span = processSpanMs(group.steps);
    const label = `${describeGroup({ ...summary, running: running ? summary.running : 0 })}${
      failed ? ` · ${summary.failed} 个失败` : ''
    }`;
    return (
      <RowFrame
        icon={
          <RowIcon
            icon={running ? Loader2 : failed ? X : FolderSearch}
            tone={failed ? 'error' : running ? 'active' : 'quiet'}
          />
        }
        label={label}
        grow
        time={
          running
            ? elapsedLabel(now, group.steps[0].at)
            : span != null
              ? formatElapsedMs(span) || undefined
              : undefined
        }
        tone={failed ? 'error' : running ? 'active' : 'quiet'}
        running={running}
        status={running ? '，运行中' : failed ? '，有失败' : '，已完成'}
        open={open}
        onToggle={() => onToggle(group.id, !open)}
        panelId={panelId}
      >
        <div role="list" aria-label="已合并的读取步骤">
          {group.steps.map((step) => (
            <div role="listitem" key={step.id}>
              <ToolStepRow
                step={step}
                open={override[step.id] ?? false}
                onToggle={onToggle}
                now={step.status === 'running' ? now : 0}
                live={live}
                groupJid={groupJid}
              />
            </div>
          ))}
        </div>
      </RowFrame>
    );
  },
  (prev, next) =>
    prev.open === next.open &&
    prev.now === next.now &&
    prev.live === next.live &&
    prev.override === next.override &&
    prev.onToggle === next.onToggle &&
    prev.group.id === next.group.id &&
    prev.group.steps.length === next.group.steps.length &&
    prev.group.steps.every((step, index) => step === next.group.steps[index]),
);

// ── notes and sub-agents ────────────────────────────────────────────────

const TextRow = memo(function TextRow({
  step,
  open,
  onToggle,
  groupJid,
}: RowProps) {
  const panelId = useId();
  const text = step.text ?? '';
  return (
    <RowFrame
      icon={<RowIcon icon={MessageSquare} tone="quiet" />}
      label={open ? '过程说明' : stripInlineMarkdown(text)}
      grow
      open={open}
      onToggle={() => onToggle(step.id, !open)}
      panelId={panelId}
    >
      <div className="max-h-48 overflow-y-auto overscroll-contain text-muted-foreground [&_[data-markdown-root]]:text-label [&_[data-markdown-root]]:text-muted-foreground">
        <FinalMarkdown content={text} variant="docs" groupJid={groupJid} />
      </div>
    </RowFrame>
  );
});

const TaskRow = memo(function TaskRow({
  step,
  task,
  open,
  onToggle,
  now,
  live,
  groupJid,
}: RowProps & { task?: StreamingTaskRuntimeState }) {
  const panelId = useId();
  if (task && isWorkflowTask(task)) {
    return <WorkflowRunCard run={workflowRunOf(task)} />;
  }
  // Without the sub-agent's details (a reconnect rebuilt the step but not the
  // card) it is a row of its own, with nothing to open.
  const status = task?.status ?? step.status;
  const running = live && (status === 'running' || status === 'backgrounded');
  const failed = status === 'error';
  const canOpen = !!task && subAgentHasBody(task);
  const tone: Tone = failed ? 'error' : running ? 'active' : 'quiet';
  const detail = task
    ? [task.subagentType, task.lastToolName, task.latestSummary]
        .filter(Boolean)
        .join(' · ')
    : step.summary;
  return (
    <RowFrame
      icon={<RowIcon icon={running ? Loader2 : failed ? X : Bot} tone={tone} />}
      label={task?.title ?? step.title ?? '子 Agent'}
      detail={detail}
      time={
        running
          ? elapsedLabel(now, step.at)
          : step.status === 'running'
            ? undefined
            : durationLabel(step)
      }
      tone={tone}
      running={running}
      status={`，子 Agent，${task ? STATUS_LABELS[task.status] : failed ? '失败' : '已完成'}`}
      open={open && canOpen}
      onToggle={canOpen ? () => onToggle(step.id, !open) : undefined}
      panelId={panelId}
    >
      {task && (
        <div className="space-y-2 text-caption">
          <SubAgentBody task={task} groupJid={groupJid} inline />
        </div>
      )}
    </RowFrame>
  );
});

// ── older steps ─────────────────────────────────────────────────────────

/** Steps folded out of sight: what they were, and a way to see them. */
function FoldedRow({
  folded,
  dropped,
  open,
  onToggle,
}: {
  folded: StreamingStep[];
  dropped: number;
  open: boolean;
  onToggle: () => void;
}) {
  const sum = summarizeSteps(folded);
  const parts = [`较早 ${folded.length + dropped} 步`];
  if (sum.tools + sum.tasks > 0) parts.push(`${sum.tools + sum.tasks} 个工具`);
  if (sum.thinking > 0) parts.push(`${sum.thinking} 段思考`);
  if (sum.failed > 0) parts.push(`${sum.failed} 个失败`);
  return (
    <RowFrame
      icon={
        <ChevronRight
          aria-hidden="true"
          className={cn(
            ICON_CLASS,
            'text-faint-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      }
      label={<span className="tabular-nums">{parts.join(' · ')}</span>}
      grow
      open={open}
      onToggle={onToggle}
      endChevron={false}
      title="较早的步骤"
    />
  );
}

// ── the list ────────────────────────────────────────────────────────────

export interface ProcessTimelineProps {
  /** The steps to list: what the card shows, the commentary already chosen. */
  steps: StreamingStep[];
  stepsDropped?: number;
  groupJid: string;
  taskStates?: Record<string, StreamingTaskRuntimeState>;
  /** Show reasoning titles and text; off, only that the model reasoned. */
  thinkingText?: boolean;
  /** The run is producing these steps now: what runs here animates and counts. */
  live: boolean;
  /** Extra classes for the open reasoning text of a row. */
  bodyClassName?: string;
  /** Under the list, on the same line down the left. */
  after?: ReactNode;
}

/**
 * The steps of a reply in the order they happened, as rows of one skeleton
 * along a single line down the left. Older steps fold into one row; a run of
 * read-only calls is one row; the step in progress is open and the reader's
 * own opening or closing of a row is never overridden. The answer is not a
 * step of this list: it is the text below it.
 */
export const ProcessTimeline = memo(function ProcessTimeline({
  steps,
  stepsDropped = 0,
  groupJid,
  taskStates = EMPTY_TASKS,
  thinkingText = true,
  live,
  bodyClassName,
  after,
}: ProcessTimelineProps) {
  const view = useMemo(() => buildTimelineView(steps), [steps]);
  // Rows the reader opened or closed themselves; the rest follow the default.
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [foldedOpen, setFoldedOpen] = useState(false);
  const counting = live && view.rows.some((step) => step.status === 'running');
  const now = useTick(counting);
  const onToggle = useCallback((id: string, next: boolean) => {
    setOverride((current) => ({ ...current, [id]: next }));
  }, []);
  // A question put to the reader is a card of its own, not a row.
  const rows = useMemo(
    () => view.rows.filter((step) => !isQuestionStep(step)),
    [view.rows],
  );
  const folded = useMemo(
    () => view.folded.filter((step) => !isQuestionStep(step)),
    [view.folded],
  );
  const items = useMemo(() => groupProcessSteps(rows), [rows]);
  const foldedItems = useMemo(
    () => (foldedOpen ? groupProcessSteps(folded) : []),
    [foldedOpen, folded],
  );

  const defaultOpen = (step: StreamingStep): boolean => {
    if (!live || step.status !== 'running') return false;
    return step.kind === 'thinking' && thinkingText && !!step.text?.trim();
  };

  const renderItem = (item: ProcessItem) => {
    if (item.type === 'group') {
      const open = override[item.id] ?? false;
      return (
        <div role="listitem" key={item.id}>
          <ReadGroupRow
            group={item}
            override={override}
            open={open}
            onToggle={onToggle}
            now={now}
            live={live}
            groupJid={groupJid}
          />
        </div>
      );
    }
    const { step } = item;
    const open = override[step.id] ?? defaultOpen(step);
    const common = {
      step,
      open,
      onToggle,
      now: step.status === 'running' ? now : 0,
      live,
      groupJid,
    };
    let row: ReactNode;
    switch (step.kind) {
      case 'thinking':
        row = (
          <ThinkingRow
            {...common}
            thinkingText={thinkingText}
            bodyClassName={bodyClassName}
          />
        );
        break;
      case 'tool':
        row = <ToolStepRow {...common} />;
        break;
      case 'task':
        row = <TaskRow {...common} task={taskStates[step.taskId ?? '']} />;
        break;
      case 'text':
        row = <TextRow {...common} />;
        break;
    }
    return (
      <div role="listitem" key={step.id}>
        {row}
      </div>
    );
  };

  const hasRows = rows.length > 0 || folded.length > 0;
  if (!hasRows && !after) return null;
  return (
    <div className="border-l-2 border-surface-border pl-3 font-sans">
      {hasRows && (
        <div
          role="list"
          aria-label="处理步骤"
          data-hc-step-timeline=""
          className="space-y-0.5"
        >
          {(folded.length > 0 || stepsDropped > 0) && (
            <div role="listitem">
              <FoldedRow
                folded={folded}
                dropped={stepsDropped}
                open={foldedOpen}
                onToggle={() => setFoldedOpen(!foldedOpen)}
              />
            </div>
          )}
          {foldedItems.map(renderItem)}
          {items.map(renderItem)}
        </div>
      )}
      {after}
    </div>
  );
});

// ── a question for the reader ───────────────────────────────────────────

/**
 * The questions the model has put to the reader and waits on. They are not
 * rows: a card the reader has to answer must not scroll away or fold shut.
 */
export function QuestionCards({
  steps,
  activeTools,
}: {
  steps: readonly StreamingStep[];
  activeTools: StreamingState['activeTools'];
}) {
  const cards = steps
    .filter(isQuestionStep)
    .map((step) => ({
      id: step.id,
      input: activeTools.find((tool) => tool.toolUseId === step.toolUseId)
        ?.toolInput,
    }))
    .filter((card) => card.input);
  if (cards.length === 0) return null;
  return (
    <div className="mt-1 space-y-1.5">
      {cards.map((card) => (
        <AskUserQuestionCard key={card.id} toolInput={card.input ?? {}} />
      ))}
    </div>
  );
}

// ── the list on its own ─────────────────────────────────────────────────

export interface ProcessStepsProps {
  steps: StreamingStep[] | undefined;
  stepsDropped?: number;
  taskStates: Record<string, StreamingTaskRuntimeState>;
  activeTools: StreamingState['activeTools'];
  /** The model's request is out and nothing has come back. */
  waiting: boolean;
  /** When that request began (ms). */
  waitingSince?: number;
  /** Something is on the card already: a wait is then shown only if it lasts. */
  hasContent: boolean;
  groupJid: string;
  /** The run is producing these steps now (not a stopped or settled one). */
  live: boolean;
  /** Show the model's own commentary between steps. */
  commentary?: boolean;
  /** Show reasoning text; off, only that the model reasoned (and how long). */
  thinkingText?: boolean;
}

/**
 * The timeline and the wait for the model, without a header of their own: for
 * the panel of a proactive workspace, which has its own summary line.
 */
export const ProcessSteps = memo(function ProcessSteps({
  steps,
  stepsDropped = 0,
  taskStates,
  activeTools,
  waiting,
  waitingSince,
  hasContent,
  groupJid,
  live,
  commentary = true,
  thinkingText = true,
}: ProcessStepsProps) {
  const shown = useMemo(
    () => visibleSteps(steps ?? [], commentary),
    [steps, commentary],
  );
  const hasRows = hasListedSteps(shown);
  if (!hasRows && !waiting) return null;
  return (
    <>
      {hasRows && (
        <div className="mb-2">
          <ProcessTimeline
            steps={shown}
            stepsDropped={stepsDropped}
            groupJid={groupJid}
            taskStates={taskStates}
            thinkingText={thinkingText}
            live={live}
          />
          <QuestionCards steps={shown} activeTools={activeTools} />
        </div>
      )}
      <ModelWaitRow
        active={live && waiting}
        since={waitingSince}
        delayMs={hasContent ? LATER_WAIT_DELAY_MS : 0}
      />
    </>
  );
});
