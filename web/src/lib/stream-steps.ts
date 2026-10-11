/**
 * The steps of one streamed reply in the order they happened: the reasoning
 * bursts, the tool calls, the sub-agents and the model's own commentary. The
 * streaming state keeps its older fields (one reasoning text, the active
 * tools, the task map) for the classic layout; the step timeline reads this
 * list. Everything here is a pure function over a `StepList`, so the reducer
 * stays a thin shell around it and the rules are testable on their own.
 */
import {
  MAX_STEP_THINKING_TEXT,
  capThinkingText,
  extractThinkingTitle,
} from './thinking-text';

export type StepKind = 'thinking' | 'tool' | 'task' | 'text';
export type StepStatus = 'running' | 'done' | 'error';

export interface StreamingStep {
  id: string;
  kind: StepKind;
  /** Wall-clock ms the step began. */
  at: number;
  endedAt?: number;
  status: StepStatus;
  /** thinking: this burst's text. text: the commentary, once it is closed. */
  text?: string;
  /** thinking: the summary title found in the text. task: what it was asked. */
  title?: string;
  /** thinking: the model's own timing (else `endedAt - at`). */
  durationMs?: number;
  toolUseId?: string;
  toolName?: string;
  skillName?: string;
  /** tool: what the call was given. task: the latest progress summary. */
  summary?: string;
  /** tool: the start of what it returned. */
  resultPreview?: string;
  /** task: key into the streaming state's `taskStates`. */
  taskId?: string;
  /** text: where it starts in the reply's whole text (see `partialBase`). */
  from?: number;
}

export interface StepList {
  steps: StreamingStep[];
  /** Steps dropped from the front once the cap was reached. */
  dropped: number;
}

/** A reply keeps this many steps; the oldest finished ones go first. */
export const MAX_STEPS = 100;
/** The commentary kept for a closed text step. */
const MAX_TEXT_STEP_CHARS = 2000;
const MAX_RESULT_PREVIEW_CHARS = 200;

/** Tools that run as a sub-agent: shown as a task, not as a tool row. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);

export function stepList(
  steps: StreamingStep[] | undefined,
  dropped: number | undefined,
): StepList {
  return { steps: steps ?? [], dropped: dropped ?? 0 };
}

function nextId(list: StepList, prefix: string): string {
  return `${prefix}-${list.dropped + list.steps.length}`;
}

function append(list: StepList, step: StreamingStep): StepList {
  const steps = [...list.steps, step];
  let dropped = list.dropped;
  while (steps.length > MAX_STEPS) {
    const index = steps.findIndex((item) => item.status !== 'running');
    if (index < 0) break;
    steps.splice(index, 1);
    dropped += 1;
  }
  return { steps, dropped };
}

function replaceAt(
  list: StepList,
  index: number,
  patch: Partial<StreamingStep>,
): StepList {
  const steps = list.steps.slice();
  steps[index] = { ...steps[index], ...patch };
  return { steps, dropped: list.dropped };
}

function last(list: StepList): StreamingStep | undefined {
  return list.steps[list.steps.length - 1];
}

function findIndexBy(
  list: StepList,
  match: (step: StreamingStep) => boolean,
): number {
  for (let index = list.steps.length - 1; index >= 0; index -= 1) {
    if (match(list.steps[index])) return index;
  }
  return -1;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

// ── thinking ────────────────────────────────────────────────────────────

/** The reasoning began: a thinking step is running at the end of the list. */
export function openThinkingStep(list: StepList, at: number): StepList {
  const current = last(list);
  if (current?.kind === 'thinking' && current.status === 'running') return list;
  return append(list, {
    id: nextId(list, 'thinking'),
    kind: 'thinking',
    at,
    status: 'running',
    text: '',
  });
}

/** Add reasoning text to the running thinking step (opening one if needed). */
export function appendThinkingText(
  list: StepList,
  delta: string,
  at: number,
): StepList {
  const opened = openThinkingStep(list, at);
  const index = opened.steps.length - 1;
  const step = opened.steps[index];
  const text = capThinkingText(
    (step.text ?? '') + delta,
    MAX_STEP_THINKING_TEXT,
  );
  return replaceAt(opened, index, {
    text,
    title: extractThinkingTitle(text) ?? step.title,
  });
}

/** The reasoning ended; `durationMs` is the model's own timing if it gave one. */
export function closeThinkingStep(
  list: StepList,
  at: number,
  durationMs?: number,
): StepList {
  const index = findIndexBy(
    list,
    (step) => step.kind === 'thinking' && step.status === 'running',
  );
  if (index < 0) return list;
  const step = list.steps[index];
  return replaceAt(list, index, {
    status: 'done',
    endedAt: at,
    durationMs:
      durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs
        : Math.max(0, at - step.at),
    title: extractThinkingTitle(step.text ?? '', { final: true }) ?? step.title,
  });
}

// ── commentary and answer ───────────────────────────────────────────────

/** Reply text began (or goes on): a text step is running at the end. */
export function openTextStep(
  list: StepList,
  at: number,
  from: number,
): StepList {
  const current = last(list);
  if (current?.kind === 'text' && current.status === 'running') return list;
  return append(list, {
    id: nextId(list, 'text'),
    kind: 'text',
    at,
    status: 'running',
    from,
  });
}

/**
 * A tool or sub-agent started after this text: it was commentary, not the
 * answer. Keep its text (the end of it, bounded) on the step.
 */
export function closeTextStep(
  list: StepList,
  at: number,
  wholeText: string,
  base: number,
): StepList {
  const index = findIndexBy(
    list,
    (step) => step.kind === 'text' && step.status === 'running',
  );
  if (index < 0) return list;
  const step = list.steps[index];
  const own = wholeText.slice(Math.max(0, (step.from ?? 0) - base)).trim();
  return replaceAt(list, index, {
    status: 'done',
    endedAt: at,
    text: tail(own, MAX_TEXT_STEP_CHARS),
  });
}

/** Whatever was running when a tool or sub-agent started is now over. */
export function closeOpenSteps(
  list: StepList,
  at: number,
  wholeText: string,
  base: number,
): StepList {
  return closeTextStep(closeThinkingStep(list, at), at, wholeText, base);
}

// ── tools ───────────────────────────────────────────────────────────────

export interface ToolStepInput {
  toolUseId: string;
  toolName: string;
  skillName?: string;
  summary?: string;
}

function toolIndex(list: StepList, toolUseId: string): number {
  return findIndexBy(
    list,
    (step) =>
      (step.kind === 'tool' || step.kind === 'task') &&
      step.toolUseId === toolUseId,
  );
}

/** A top-level tool call began (a sub-agent tool becomes a task step). */
export function startToolStep(
  list: StepList,
  tool: ToolStepInput,
  at: number,
): StepList {
  const index = toolIndex(list, tool.toolUseId);
  if (index >= 0) {
    return replaceAt(list, index, {
      toolName: tool.toolName || list.steps[index].toolName,
      skillName: tool.skillName ?? list.steps[index].skillName,
      summary: tool.summary ?? list.steps[index].summary,
    });
  }
  const isTask = TASK_TOOL_NAMES.has(tool.toolName);
  return append(list, {
    id: isTask
      ? `task-${tool.toolUseId}`
      : nextId(list, `tool-${tool.toolUseId}`),
    kind: isTask ? 'task' : 'tool',
    at,
    status: 'running',
    toolUseId: tool.toolUseId,
    toolName: tool.toolName,
    skillName: tool.skillName,
    summary: tool.summary,
    taskId: isTask ? tool.toolUseId : undefined,
  });
}

/** The call's input became known or its progress moved: update in place. */
export function patchToolStep(
  list: StepList,
  toolUseId: string,
  patch: { skillName?: string; summary?: string },
): StepList {
  const index = toolIndex(list, toolUseId);
  if (index < 0) return list;
  const step = list.steps[index];
  const next: Partial<StreamingStep> = {};
  if (patch.skillName && patch.skillName !== step.skillName) {
    next.skillName = patch.skillName;
  }
  if (patch.summary && patch.summary !== step.summary) {
    next.summary = patch.summary;
  }
  return Object.keys(next).length > 0 ? replaceAt(list, index, next) : list;
}

export interface ToolProgressInput {
  toolUseId: string;
  toolName?: string;
  skillName?: string;
  summary?: string;
}

/** Progress of a call: update its step, or start one if it was not seen. */
export function progressToolStep(
  list: StepList,
  tool: ToolProgressInput,
  at: number,
): StepList {
  if (toolIndex(list, tool.toolUseId) >= 0) {
    return patchToolStep(list, tool.toolUseId, {
      skillName: tool.skillName,
      summary: tool.summary,
    });
  }
  return startToolStep(
    list,
    {
      toolUseId: tool.toolUseId,
      toolName: tool.toolName || 'unknown',
      skillName: tool.skillName,
      summary: tool.summary,
    },
    at,
  );
}

/** Failed tool results are marked by the runner with this prefix. */
const FAILURE_PREFIX = '⚠️';

/** The call returned (`result` is its text, if any) or ended. */
export function endToolStep(
  list: StepList,
  toolUseId: string,
  at: number,
  result?: string,
): StepList {
  const index = toolIndex(list, toolUseId);
  if (index < 0) return list;
  const step = list.steps[index];
  const failed = !!result && result.startsWith(FAILURE_PREFIX);
  const text = result
    ? result
        .replace(/^⚠️\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
  // A sub-agent ends on its own lifecycle (a background one outlives the call
  // that started it), not when its tool returns.
  if (step.kind === 'task' && !failed) return list;
  return replaceAt(list, index, {
    status: failed ? 'error' : step.status === 'error' ? 'error' : 'done',
    endedAt: step.endedAt ?? at,
    resultPreview: text
      ? tail(text, MAX_RESULT_PREVIEW_CHARS).replace(/^…/, '')
      : step.resultPreview,
  });
}

/** A permission denial marks the call it denied. */
export function failToolStep(
  list: StepList,
  toolUseId: string,
  at: number,
  reason: string,
): StepList {
  const index = toolIndex(list, toolUseId);
  if (index < 0) return list;
  return replaceAt(list, index, {
    status: 'error',
    endedAt: list.steps[index].endedAt ?? at,
    resultPreview: tail(reason, MAX_RESULT_PREVIEW_CHARS),
  });
}

// ── sub-agents ──────────────────────────────────────────────────────────

/**
 * Whether `parentToolUseId` is a sub-agent: its tools belong to its card. A
 * tool nested under anything else (a skill) is the model's own call.
 */
export function isUnderTask(
  list: StepList,
  parentToolUseId: string | null | undefined,
): boolean {
  if (!parentToolUseId) return false;
  return list.steps.some(
    (step) =>
      step.kind === 'task' &&
      (step.taskId === parentToolUseId || step.toolUseId === parentToolUseId),
  );
}

export function hasTaskStep(list: StepList, taskId: string): boolean {
  return list.steps.some(
    (step) =>
      step.kind === 'task' &&
      (step.taskId === taskId || step.toolUseId === taskId),
  );
}

export interface TaskStepInput {
  taskId: string;
  toolUseId?: string;
  title?: string;
  summary?: string;
}

function taskIndex(list: StepList, taskId: string): number {
  return findIndexBy(
    list,
    (step) =>
      step.kind === 'task' &&
      (step.taskId === taskId || step.toolUseId === taskId),
  );
}

/** A sub-agent or workflow is running (created once, then updated). */
export function ensureTaskStep(
  list: StepList,
  input: TaskStepInput,
  at: number,
): StepList {
  const index = taskIndex(list, input.taskId);
  if (index >= 0) {
    const step = list.steps[index];
    const patch: Partial<StreamingStep> = {};
    if (input.summary && input.summary !== step.summary) {
      patch.summary = input.summary;
    }
    if (input.title && input.title !== step.title) patch.title = input.title;
    return Object.keys(patch).length > 0 ? replaceAt(list, index, patch) : list;
  }
  return append(list, {
    id: `task-${input.taskId}`,
    kind: 'task',
    at,
    status: 'running',
    taskId: input.taskId,
    toolUseId: input.toolUseId ?? input.taskId,
    toolName: 'Task',
    summary: input.summary,
    title: input.title,
  });
}

/** The sub-agent's own lifecycle moved. */
export function setTaskStepStatus(
  list: StepList,
  taskId: string,
  status: StepStatus,
  at: number,
  summary?: string,
): StepList {
  const index = taskIndex(list, taskId);
  if (index < 0) return list;
  const step = list.steps[index];
  const patch: Partial<StreamingStep> = {};
  if (step.status !== status) {
    patch.status = status;
    if (status !== 'running') patch.endedAt = step.endedAt ?? at;
  }
  if (summary && summary !== step.summary) patch.summary = summary;
  return Object.keys(patch).length > 0 ? replaceAt(list, index, patch) : list;
}

// ── the end of a reply ──────────────────────────────────────────────────

/**
 * The run ended (or was stopped): nothing is running any more. A tool that
 * never reported back after a stop is marked as failed so the card does not
 * look like it is still working.
 */
export function finishSteps(
  list: StepList,
  at: number,
  stopped: boolean,
): StepList {
  if (!list.steps.some((step) => step.status === 'running')) return list;
  return {
    dropped: list.dropped,
    steps: list.steps.map((step) =>
      step.status !== 'running'
        ? step
        : {
            ...step,
            endedAt: at,
            status:
              stopped && (step.kind === 'tool' || step.kind === 'task')
                ? 'error'
                : 'done',
            resultPreview:
              stopped && (step.kind === 'tool' || step.kind === 'task')
                ? (step.resultPreview ?? '已停止')
                : step.resultPreview,
          },
    ),
  };
}

// ── reading the list ────────────────────────────────────────────────────

/** Index of the step holding the reply's answer, if text came last. */
export function answerStepIndex(steps: readonly StreamingStep[]): number {
  let textIndex = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const kind = steps[index].kind;
    if (kind === 'text') {
      textIndex = index;
      break;
    }
    if (kind === 'tool' || kind === 'task') return -1;
  }
  return textIndex;
}

/**
 * Where the answer starts in the reply's whole text: text after the last
 * tool or sub-agent, which is what the host delivers as the final message.
 * `undefined` when the list has no steps (an older mirror, a snapshot).
 */
export function answerStart(
  steps: readonly StreamingStep[] | undefined,
  base: number,
): number | undefined {
  if (!steps || steps.length === 0) return undefined;
  const index = answerStepIndex(steps);
  if (index < 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (steps[index].from ?? 0) - base);
}

export interface StepSummary {
  tools: number;
  tasks: number;
  thinking: number;
  commentary: number;
  failed: number;
}

export function summarizeSteps(steps: readonly StreamingStep[]): StepSummary {
  const summary: StepSummary = {
    tools: 0,
    tasks: 0,
    thinking: 0,
    commentary: 0,
    failed: 0,
  };
  for (const step of steps) {
    if (step.kind === 'tool') summary.tools += 1;
    else if (step.kind === 'task') summary.tasks += 1;
    else if (step.kind === 'thinking') summary.thinking += 1;
    else if (step.text?.trim()) summary.commentary += 1;
    if (step.status === 'error') summary.failed += 1;
  }
  return summary;
}

/** Rows kept visible in the timeline; older steps fold into one line. */
export const TIMELINE_ROWS = 6;
/** Of those, the latest are shown open. */
export const TIMELINE_EXPANDED = 3;

export interface TimelineView {
  /** Earlier steps folded into the summary line, oldest first. */
  folded: StreamingStep[];
  /** The last steps, oldest first. */
  rows: StreamingStep[];
  /** Ids of the rows that start open. */
  expanded: ReadonlySet<string>;
}

/** Steps the timeline lists: everything but the answer and empty commentary. */
export function railSteps(steps: readonly StreamingStep[]): StreamingStep[] {
  const answer = answerStepIndex(steps);
  return steps.filter(
    (step, index) =>
      index !== answer && !(step.kind === 'text' && !step.text?.trim()),
  );
}

export function buildTimelineView(
  steps: readonly StreamingStep[],
  rows: number = TIMELINE_ROWS,
  expanded: number = TIMELINE_EXPANDED,
): TimelineView {
  const rail = railSteps(steps);
  const folded = rail.length > rows ? rail.slice(0, rail.length - rows) : [];
  const visible = rail.slice(folded.length);
  return {
    folded,
    rows: visible,
    expanded: new Set(visible.slice(-expanded).map((step) => step.id)),
  };
}

// ── rebuilding after a reconnect ────────────────────────────────────────

export interface SnapshotSteps {
  thinkingText: string;
  thinkingDurationMs?: number;
  isThinking: boolean;
  partialText: string;
  activeTools: ReadonlyArray<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    toolInputSummary?: string;
    skillName?: string;
    parentToolUseId?: string | null;
    isNested?: boolean;
  }>;
  tasks: ReadonlyArray<{ id: string; status: string; title: string }>;
  /** Top-level tool rows of the trace, oldest first. */
  tracedTools: ReadonlyArray<{
    toolUseId: string;
    timestamp: number;
    summary?: string;
    skillName?: string;
    toolName?: string;
  }>;
  now: number;
}

/**
 * A reconnect snapshot carries the pieces but not their order. Rebuild a
 * plausible one: the reasoning first, then the tools and sub-agents by the
 * time they were traced, then the text. Only used when this tab has no steps
 * of its own for the turn.
 */
export function rebuildSteps(input: SnapshotSteps): StepList {
  let list: StepList = { steps: [], dropped: 0 };
  const firstAt = input.tracedTools[0]?.timestamp ?? input.now;
  if (input.thinkingText || input.thinkingDurationMs) {
    list = append(list, {
      id: 'thinking-restored',
      kind: 'thinking',
      at: Math.max(0, firstAt - 1),
      endedAt: input.isThinking ? undefined : firstAt,
      status: input.isThinking && !input.partialText ? 'running' : 'done',
      text: capThinkingText(input.thinkingText, MAX_STEP_THINKING_TEXT),
      title: extractThinkingTitle(input.thinkingText, { final: true }),
      durationMs: input.thinkingDurationMs,
    });
  }
  const active = new Set(input.activeTools.map((tool) => tool.toolUseId));
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  for (const tool of input.tracedTools) {
    if (tasks.has(tool.toolUseId)) continue;
    const running = active.has(tool.toolUseId);
    list = append(list, {
      id: `tool-${tool.toolUseId}-restored`,
      kind: 'tool',
      at: tool.timestamp,
      status: running ? 'running' : 'done',
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      skillName: tool.skillName,
      summary: tool.summary,
    });
  }
  for (const tool of input.activeTools) {
    if (tool.isNested || tool.parentToolUseId) continue;
    if (tasks.has(tool.toolUseId)) continue;
    if (list.steps.some((step) => step.toolUseId === tool.toolUseId)) continue;
    list = append(list, {
      id: `tool-${tool.toolUseId}-restored`,
      kind: 'tool',
      at: tool.startTime,
      status: 'running',
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      skillName: tool.skillName,
      summary: tool.toolInputSummary,
    });
  }
  for (const task of input.tasks) {
    list = append(list, {
      id: `task-${task.id}`,
      kind: 'task',
      at: firstAt,
      status:
        task.status === 'completed'
          ? 'done'
          : task.status === 'error'
            ? 'error'
            : 'running',
      taskId: task.id,
      toolUseId: task.id,
      toolName: 'Task',
      title: task.title,
    });
  }
  if (input.partialText) {
    list = append(list, {
      id: 'text-restored',
      kind: 'text',
      at: input.now,
      status: 'running',
      from: 0,
    });
  }
  return list;
}
