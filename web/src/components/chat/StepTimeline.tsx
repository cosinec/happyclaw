import { memo, useId, useMemo, useState } from 'react';
import { ChevronRight, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  StreamingState,
  StreamingTaskRuntimeState,
} from '../../stores/chat';
import {
  buildTimelineView,
  summarizeSteps,
  type StreamingStep,
} from '../../lib/stream-steps';
import { stripInlineMarkdown } from '../../lib/thinking-text';
import { useTick } from '../../hooks/useTick';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { FinalMarkdown } from './StreamingMarkdown';
import { ModelWaitRow } from './ModelWaitRow';
import { SubAgentCard } from './SubAgentCard';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolRow } from './ToolActivityCard';
import { WorkflowRunCard } from './WorkflowRunCard';
import { isWorkflowTask, workflowRunOf } from './workflow-run';

/** A wait between tools shows its placeholder only once it has lasted a moment. */
const LATER_WAIT_DELAY_MS = 800;

function stepDurationMs(step: StreamingStep): number | undefined {
  if (step.durationMs != null) return step.durationMs;
  return step.endedAt != null ? Math.max(0, step.endedAt - step.at) : undefined;
}

/** The model's commentary between steps, one muted line until opened. */
function CommentaryRow({
  text,
  open,
  onOpenChange,
  groupJid,
}: {
  text: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupJid: string;
}) {
  const bodyId = useId();
  return (
    <div className="font-sans">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        className="flex min-h-7 w-full cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-left text-label text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-10"
      >
        <MessageSquare
          className="mt-0.5 size-3.5 shrink-0 text-faint-foreground"
          aria-hidden="true"
        />
        <span className={cn('min-w-0 flex-1', !open && 'truncate')}>
          {open ? '' : stripInlineMarkdown(text)}
        </span>
      </button>
      {open && (
        <div
          id={bodyId}
          className="mb-1 ml-6 max-h-48 overflow-y-auto overscroll-contain text-muted-foreground [&_[data-markdown-root]]:text-label [&_[data-markdown-root]]:text-muted-foreground"
        >
          <FinalMarkdown content={text} variant="docs" groupJid={groupJid} />
        </div>
      )}
    </div>
  );
}

/** Steps folded out of sight: what they were, and a way to see them. */
function FoldedSummary({
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
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="-ml-1 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1 font-sans text-caption text-faint-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:h-10"
    >
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 transition-transform duration-150',
          open && 'rotate-90',
        )}
        aria-hidden="true"
      />
      <span className="tabular-nums">{parts.join(' · ')}</span>
    </button>
  );
}

interface StepRowProps {
  step: StreamingStep;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: number;
  live: boolean;
  groupJid: string;
  taskStates: Record<string, StreamingTaskRuntimeState>;
  activeTools: StreamingState['activeTools'];
  thinkingText: boolean;
}

function StepRow({
  step,
  open,
  onOpenChange,
  now,
  live,
  groupJid,
  taskStates,
  activeTools,
  thinkingText,
}: StepRowProps) {
  switch (step.kind) {
    case 'thinking': {
      const running = step.status === 'running';
      return (
        <ThinkingBlock
          text={thinkingText ? (step.text ?? '') : ''}
          title={thinkingText ? step.title : undefined}
          durationMs={running ? undefined : stepDurationMs(step)}
          running={running}
          live={running && live}
          groupJid={groupJid}
          expanded={open}
          onExpandedChange={onOpenChange}
          // Lined up with the icons of the tool rows (their 4px padding).
          className="mb-0.5 ml-1"
        />
      );
    }
    case 'tool': {
      if (step.toolName === 'AskUserQuestion') {
        const input = activeTools.find(
          (tool) => tool.toolUseId === step.toolUseId,
        )?.toolInput;
        return input ? <AskUserQuestionCard toolInput={input} /> : null;
      }
      const running = step.status === 'running';
      return (
        <ToolRow
          toolName={step.toolName ?? 'unknown'}
          skillName={step.skillName}
          summary={step.summary}
          status={step.status}
          elapsedSeconds={
            running ? Math.max(0, (now - step.at) / 1000) : undefined
          }
          durationMs={running ? undefined : stepDurationMs(step)}
          resultPreview={step.resultPreview}
        />
      );
    }
    case 'task': {
      const task = taskStates[step.taskId ?? ''];
      if (task && isWorkflowTask(task)) {
        return <WorkflowRunCard run={workflowRunOf(task)} />;
      }
      if (task) {
        return (
          <SubAgentCard
            task={task}
            groupJid={groupJid}
            defaultExpanded={open}
          />
        );
      }
      // A reconnect rebuilt the step but not the card's details.
      const running = step.status === 'running';
      return (
        <ToolRow
          toolName="Task"
          summary={step.title ?? step.summary}
          status={step.status}
          elapsedSeconds={
            running ? Math.max(0, (now - step.at) / 1000) : undefined
          }
          durationMs={running ? undefined : stepDurationMs(step)}
        />
      );
    }
    case 'text':
      return (
        <CommentaryRow
          text={step.text ?? ''}
          open={open}
          onOpenChange={onOpenChange}
          groupJid={groupJid}
        />
      );
  }
}

interface StepTimelineProps {
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
  /** The run is producing this card now (not a stopped or settled one). */
  live: boolean;
  /** Show the model's own commentary between steps. */
  commentary?: boolean;
  /** Show reasoning text; off, only that the model reasoned (and how long). */
  thinkingText?: boolean;
}

/**
 * The steps of a reply in the order they happened. The latest few are shown
 * open (the reasoning being written, the sub-agent at work); earlier ones are
 * a row each, and the oldest fold into one line. The answer is not a step of
 * this list: it is the text below it.
 */
export const StepTimeline = memo(function StepTimeline({
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
}: StepTimelineProps) {
  const shown = useMemo(
    () => (steps ?? []).filter((step) => commentary || step.kind !== 'text'),
    [steps, commentary],
  );
  const view = useMemo(() => buildTimelineView(shown), [shown]);
  // Rows the reader opened or closed themselves; the rest follow the default.
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [foldedOpen, setFoldedOpen] = useState(false);
  const counting = live && view.rows.some((step) => step.status === 'running');
  const now = useTick(counting);

  const row = (step: StreamingStep, open: boolean) => (
    <div role="listitem" key={step.id}>
      <StepRow
        step={step}
        open={open}
        onOpenChange={(next) =>
          setOverride((current) => ({ ...current, [step.id]: next }))
        }
        now={now}
        live={live}
        groupJid={groupJid}
        taskStates={taskStates}
        activeTools={activeTools}
        thinkingText={thinkingText}
      />
    </div>
  );

  const hasRows = view.rows.length > 0 || view.folded.length > 0;
  if (!hasRows && !waiting) return null;

  return (
    <>
      {hasRows && (
        <div
          role="list"
          aria-label="处理步骤"
          data-hc-step-timeline=""
          className="mb-2 space-y-0.5 border-l-2 border-surface-border pl-3 font-sans"
        >
          {(view.folded.length > 0 || stepsDropped > 0) && (
            <FoldedSummary
              folded={view.folded}
              dropped={stepsDropped}
              open={foldedOpen}
              onToggle={() => setFoldedOpen(!foldedOpen)}
            />
          )}
          {foldedOpen && view.folded.map((step) => row(step, false))}
          {view.rows.map((step) =>
            row(step, override[step.id] ?? view.expanded.has(step.id)),
          )}
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
