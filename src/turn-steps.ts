/**
 * The ordered steps of a turn, recorded on the host from its stream events.
 *
 * The Web builds the same list live (web/src/stores/chat.ts: applyStreamEvent,
 * applyTaskToSteps and the thinking helpers around them, over the reducer in
 * shared/stream-steps.ts) and drops it when the reply settles. The host keeps
 * it, so a settled reply can show the timeline it streamed (turn_traces
 * .steps_json). The recorder is a port of that event-to-step mapping: it holds
 * the few fields of the Web's streaming state the mapping reads (the open
 * reasoning burst, the model's request phase, the reply text so far, the
 * running tools and tasks) and calls the same reducer functions in the same
 * order. tests/turn-steps-web-parity.test.ts feeds one event sequence to both
 * and compares; if the Web's mapping changes, change it here as well.
 *
 * Not ThinkingClock (stream-trace.ts): that one times the whole turn's
 * reasoning for "已思考 Xs" and decides a few things differently from the Web,
 * which move where a burst starts (the Web restarts the model's request phase
 * at the end of a tool only while that tool is still running; the clock does
 * at every tool_use_end and tool_result). A step has to start where the Web
 * puts it.
 *
 * Not recorded, by design: the narration a proactive Workspace gets before a
 * tool call (`commentary`) is model text that the host broadcasts and never
 * stores, so a proactive turn has no text steps (the Web shows them live).
 */

import type { StreamEvent } from './stream-event.types.js';
import {
  MAX_STEPS,
  appendThinkingText,
  closeOpenSteps,
  closeThinkingStep,
  endToolStep,
  ensureTaskStep,
  failToolStep,
  finishSteps,
  hasTaskStep,
  isUnderTask,
  openTextStep,
  openThinkingStep,
  progressToolStep,
  setTaskStepStatus,
  startToolStep,
  type StepKind,
  type StepList,
  type StepStatus,
  type StreamingStep,
} from './stream-steps.js';
import { isSubagentEvent, capTailByBytes } from './stream-trace.js';
import { isMessageDeliveryTool } from './workspace-interaction-runtime.js';

/**
 * Reply text kept to cut the commentary of a text step from. The Web bounds its
 * partial text the same way; a step only ever reads the text since it began.
 */
const MAX_REPLY_TEXT = 200_000;

/** Tools whose end comes from their own lifecycle, not their tool_result. */
const TOOLS_ENDED_BY_LIFECYCLE: ReadonlySet<string> = new Set([
  'Task',
  'Agent',
  'Skill',
]);

type TaskRuntimeStatus = 'running' | 'completed' | 'error' | 'backgrounded';

/** What the Web's StreamingTaskRuntimeState contributes to a task's step. */
interface TaskRuntime {
  title: string;
  status: TaskRuntimeStatus;
  latestSummary?: string;
}

interface ActiveTool {
  toolName: string;
  isNested?: boolean;
}

export interface TurnStepRecorderOptions {
  /**
   * A proactive Workspace speaks through one tool: calling it is the reply
   * itself, not work to watch, so it is no step (the Web leaves it out too).
   * Its start still ends the reasoning before it.
   */
  proactive?: boolean;
}

function taskIdFromEvent(event: StreamEvent): string | null {
  return (
    event.parentToolUseId ||
    event.taskId ||
    (event.eventType === 'task_start' ||
    event.eventType === 'task_progress' ||
    event.eventType === 'task_updated' ||
    event.eventType === 'task_notification'
      ? event.toolUseId || null
      : null)
  );
}

function stepStatusOfTask(status: TaskRuntimeStatus): StepStatus {
  if (status === 'completed') return 'done';
  return status === 'error' ? 'error' : 'running';
}

/** Keep the end of an over-long reply, off a surrogate pair. */
function capReplyText(text: string): string {
  if (text.length <= MAX_REPLY_TEXT) return text;
  let start = text.length - Math.floor(MAX_REPLY_TEXT * 0.9);
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

/** A text step that holds no commentary: the answer, or whitespace. */
function isBlankTextStep(step: StreamingStep): boolean {
  return step.kind === 'text' && !step.text?.trim();
}

/** Records the steps of one turn (or of one part of a held reply sequence). */
export class TurnStepRecorder {
  private list: StepList = { steps: [], dropped: 0 };
  // The part of the Web's StreamingState that the event-to-step mapping reads.
  private isThinking = false;
  private thinkingStartedAt?: number;
  private thinkingDurationMs?: number;
  private phaseStartedAt?: number;
  private partialText = '';
  private partialBase = 0;
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly tasks = new Map<string, TaskRuntime>();
  private readonly speechCalls = new Set<string>();
  private lastEventAt?: number;

  /**
   * `runStartedAt` is when the model was first asked: reasoning that arrives
   * before anything else began then, not when its first text did.
   */
  constructor(
    private readonly runStartedAt?: number,
    private readonly options: TurnStepRecorderOptions = {},
  ) {}

  /** Whether anything but the reply's own text has been recorded. */
  get isEmpty(): boolean {
    return (
      this.list.dropped === 0 &&
      this.list.steps.every((s) => isBlankTextStep(s))
    );
  }

  observe(event: StreamEvent, now: number): void {
    this.lastEventAt = now;
    if (this.options.proactive && this.observeSpeechTool(event, now)) {
      return;
    }
    switch (event.eventType) {
      case 'status':
        this.observeStatus(event, now);
        break;
      case 'text_delta':
        this.observeText(event, now);
        break;
      // `commentary` (a proactive workspace's narration before a tool call,
      // which the Web shows as a step) is not recorded: it is model text that
      // the host broadcasts and never stores, so a proactive turn has no text
      // steps.
      case 'thinking_delta':
        if (event.parentToolUseId) {
          this.updateTask(event);
          break;
        }
        // The Web applies deltas in frames and skips an empty one.
        if (!event.text) break;
        this.beginThinkingBurst(now);
        this.list = appendThinkingText(this.list, event.text, now);
        break;
      case 'thinking_start':
        // Sub-agents do not send these; their reasoning is their task's tail.
        if (isSubagentEvent(event)) break;
        this.beginThinkingBurst(now);
        break;
      case 'thinking_end':
        if (isSubagentEvent(event)) break;
        this.endThinkingBurst(now, event.thinkingDurationMs);
        break;
      case 'tool_use_start':
        this.observeToolStart(event, now);
        break;
      case 'tool_use_end':
        this.observeToolEnd(event, now);
        break;
      case 'tool_result':
        this.observeToolResult(event, now);
        break;
      case 'tool_progress':
        this.observeToolProgress(event, now);
        break;
      case 'task_start':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        this.updateTask(event);
        this.applyTaskToSteps(event, now);
        break;
      case 'permission_denied': {
        const denied = event.permissionDenied;
        if (!denied?.toolUseId) break;
        const why =
          denied.reason ||
          denied.message ||
          event.summary ||
          event.detail ||
          '权限被拒绝';
        this.list = failToolStep(this.list, denied.toolUseId, now, why);
        break;
      }
      default:
        break;
    }
  }

  /**
   * The steps as a settled reply shows them: nothing is running any more, and
   * the reply's own text (the answer, which is the message itself) is no step.
   * A copy; the recorder goes on as it was.
   */
  settled(at: number): StepList {
    const finished = finishSteps(this.list, at, false);
    const steps = finished.steps.filter((step) => !isBlankTextStep(step));
    // The reducer drops finished steps only, so a list of calls that never
    // reported back can still be over the cap; what is stored never is.
    const overflow = Math.max(0, steps.length - MAX_STEPS);
    return {
      steps: overflow > 0 ? steps.slice(overflow) : steps,
      dropped: finished.dropped + overflow,
    };
  }

  /**
   * Append the steps of a later part of the same held reply sequence. Both
   * parts are over by now, so both settle first: the earlier one where its last
   * event was, the later one now.
   */
  absorb(other: TurnStepRecorder, now: number): void {
    if (other.list.steps.length === 0 && other.list.dropped === 0) return;
    const before = this.settled(this.lastEventAt ?? now);
    const after = other.settled(now);
    const used = new Set(before.steps.map((step) => step.id));
    const steps = [...before.steps];
    for (const step of after.steps) {
      let id = step.id;
      for (let n = 1; used.has(id); n += 1) id = `${step.id}~${n}`;
      used.add(id);
      steps.push(id === step.id ? step : { ...step, id });
    }
    const overflow = Math.max(0, steps.length - MAX_STEPS);
    this.list = {
      steps: overflow > 0 ? steps.slice(overflow) : steps,
      dropped: before.dropped + after.dropped + overflow,
    };
    // Whatever was open belongs to the earlier part, which is now settled.
    this.isThinking = false;
    this.thinkingStartedAt = undefined;
    this.activeTools.clear();
  }

  // ── the Web's reasoning burst and request phase ──────────────────────

  /**
   * Reasoning began (`thinking_start`, or the first delta of a burst when the
   * runner sends none). The burst, and its step, start when the model's request
   * did (`phaseStartedAt`, or the run's start for the first one) rather than
   * when its first text arrived. Web: markThinkingStarted, beginThinkingBurst.
   */
  private beginThinkingBurst(at: number): void {
    if (!this.isThinking || this.thinkingStartedAt === undefined) {
      const requestStart =
        this.phaseStartedAt ??
        (this.thinkingDurationMs === undefined && !this.partialText
          ? this.runStartedAt
          : undefined);
      this.thinkingStartedAt =
        requestStart !== undefined && requestStart <= at ? requestStart : at;
    }
    this.phaseStartedAt = undefined;
    if (!this.isThinking) {
      this.list = openThinkingStep(this.list, this.thinkingStartedAt ?? at);
    }
    this.isThinking = true;
  }

  /** A burst of reasoning ended; `reportedMs` is the model's own timing. */
  private endThinkingBurst(at: number, reportedMs?: number): void {
    const reported =
      reportedMs != null && Number.isFinite(reportedMs) && reportedMs >= 0
        ? reportedMs
        : undefined;
    if (this.isThinking && this.thinkingStartedAt !== undefined) {
      this.thinkingDurationMs =
        (this.thinkingDurationMs ?? 0) +
        Math.max(reported ?? 0, Math.max(0, at - this.thinkingStartedAt));
      this.thinkingStartedAt = undefined;
    } else if (this.isThinking && reported !== undefined) {
      this.thinkingDurationMs = (this.thinkingDurationMs ?? 0) + reported;
    }
    this.isThinking = false;
    this.list = closeThinkingStep(this.list, at, reported);
  }

  // ── events ───────────────────────────────────────────────────────────

  private observeStatus(event: StreamEvent, now: number): void {
    if (event.statusText === 'interrupted') {
      this.stop(now);
      return;
    }
    // A new model request: reasoning that follows is a new burst, and it
    // started here.
    if (event.statusText === 'requesting' && !event.parentToolUseId) {
      this.endThinkingBurst(now);
      this.phaseStartedAt = now;
    }
  }

  /**
   * The run was stopped. What had not reported back is marked failed so the
   * timeline does not look like it is still working. Web: freezeStreamingState.
   */
  private stop(now: number): void {
    if (this.isThinking && this.thinkingStartedAt !== undefined) {
      this.thinkingDurationMs =
        (this.thinkingDurationMs ?? 0) +
        Math.max(0, now - this.thinkingStartedAt);
    }
    this.list = finishSteps(this.list, now, true);
    this.isThinking = false;
    this.thinkingStartedAt = undefined;
    this.activeTools.clear();
  }

  private observeText(event: StreamEvent, now: number): void {
    if (event.parentToolUseId) {
      this.updateTask(event);
      return;
    }
    if (!event.text) return;
    this.endThinkingBurst(now);
    const base = this.partialBase;
    const before = this.partialText.length;
    const combined = this.partialText + event.text;
    this.partialText = capReplyText(combined);
    this.partialBase =
      base + Math.max(0, combined.length - this.partialText.length);
    this.list = openTextStep(this.list, now, base + before);
    this.phaseStartedAt = undefined;
  }

  /** What was open when a tool or a sub-agent started is now over. */
  private closeOpen(now: number): StepList {
    return closeOpenSteps(this.list, now, this.partialText, this.partialBase);
  }

  private observeToolStart(event: StreamEvent, now: number): void {
    // A sub-agent's tool is not the main agent's: its own reasoning goes on.
    if (!isSubagentEvent(event)) this.endThinkingBurst(now);
    if (!event.parentToolUseId) this.phaseStartedAt = undefined;
    const toolUseId = event.toolUseId || '';
    if (toolUseId && !isUnderTask(this.list, event.parentToolUseId)) {
      // Text before a tool was commentary; the tool is the next step.
      this.list = startToolStep(
        this.closeOpen(now),
        {
          toolUseId,
          toolName: event.toolName || 'unknown',
          skillName: event.skillName,
          summary: event.toolInputSummary,
        },
        now,
      );
    }
    if (toolUseId) {
      this.activeTools.set(toolUseId, {
        toolName: event.toolName || 'unknown',
        isNested: event.isNested,
      });
    }
    if (event.parentToolUseId) this.updateTask(event);
  }

  private observeToolEnd(event: StreamEvent, now: number): void {
    if (event.toolUseId) {
      const ended = this.activeTools.get(event.toolUseId);
      this.activeTools.delete(event.toolUseId);
      if (!isUnderTask(this.list, event.parentToolUseId)) {
        this.list = endToolStep(this.list, event.toolUseId, now);
      }
      // The model takes over again: the next burst starts here.
      if (ended && !event.parentToolUseId && !ended.isNested) {
        this.phaseStartedAt = now;
      }
    }
    if (event.parentToolUseId) this.updateTask(event);
  }

  private observeToolResult(event: StreamEvent, now: number): void {
    if (!event.toolUseId || event.parentToolUseId) return;
    this.list = endToolStep(this.list, event.toolUseId, now, event.toolResult);
    const ended = this.activeTools.get(event.toolUseId);
    if (!ended || TOOLS_ENDED_BY_LIFECYCLE.has(ended.toolName)) return;
    this.activeTools.delete(event.toolUseId);
    if (!ended.isNested) this.phaseStartedAt = now;
  }

  private observeToolProgress(event: StreamEvent, now: number): void {
    if (event.toolUseId && !this.activeTools.has(event.toolUseId)) {
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName || 'unknown',
        isNested: event.isNested,
      });
    }
    if (event.toolUseId && !isUnderTask(this.list, event.parentToolUseId)) {
      this.list = progressToolStep(
        this.list,
        {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          skillName: event.skillName,
          summary: event.toolInputSummary,
        },
        now,
      );
    }
    if (event.parentToolUseId) this.updateTask(event);
  }

  /** The speech tool's events; true when the event was one of them. */
  private observeSpeechTool(event: StreamEvent, now: number): boolean {
    if (!event.eventType.startsWith('tool_')) return false;
    const known = !!event.toolUseId && this.speechCalls.has(event.toolUseId);
    if (!isMessageDeliveryTool(event.toolName) && !known) return false;
    if (event.eventType === 'tool_use_start' && event.toolUseId) {
      this.speechCalls.add(event.toolUseId);
      // The reasoning before it is over; it is not itself a step.
      this.endThinkingBurst(now);
      this.phaseStartedAt = undefined;
    }
    return true;
  }

  // ── sub-agents ───────────────────────────────────────────────────────

  /** Web: updateTaskRuntime, for the fields a task's step reads. */
  private updateTask(event: StreamEvent): void {
    const taskId = taskIdFromEvent(event);
    if (!taskId) return;
    const task: TaskRuntime = {
      ...(this.tasks.get(taskId) ?? {
        title:
          event.taskDescription ||
          event.toolInputSummary ||
          event.summary ||
          'Task',
        status: 'running' as const,
      }),
    };
    if (event.taskDescription && (!task.title || task.title === 'Task')) {
      task.title = event.taskDescription;
    }
    if (event.eventType === 'task_progress') {
      task.status = 'running';
      task.latestSummary =
        event.summary ||
        event.taskSummary ||
        event.taskDescription ||
        task.latestSummary;
    } else if (event.eventType === 'task_updated') {
      const patch = event.taskPatch;
      if (patch?.status === 'completed') task.status = 'completed';
      else if (
        patch?.status === 'failed' ||
        patch?.status === 'killed' ||
        patch?.status === 'stopped' ||
        patch?.status === 'aborted'
      )
        task.status = 'error';
      else if (patch?.is_backgrounded) task.status = 'backgrounded';
      else if (patch?.status === 'running' || patch?.status === 'pending')
        task.status = 'running';
      task.latestSummary =
        event.summary ||
        patch?.description ||
        patch?.error ||
        task.latestSummary;
    } else if (event.eventType === 'task_notification') {
      task.status = event.taskStatus === 'completed' ? 'completed' : 'error';
      task.latestSummary =
        event.taskSummary || event.summary || task.latestSummary;
    }
    this.tasks.set(taskId, task);
  }

  /**
   * Mirror a task event into the step list: the step holds the task's place in
   * the order, its title and its summary. Runs after `updateTask`, so the
   * status is the task's own.
   */
  private applyTaskToSteps(event: StreamEvent, now: number): void {
    // A task event with a parent belongs to a task nested in another.
    if (event.parentToolUseId) return;
    const taskId = taskIdFromEvent(event);
    if (!taskId) return;
    let list = this.list;
    if (!hasTaskStep(list, taskId)) list = this.closeOpen(now);
    const task = this.tasks.get(taskId);
    list = ensureTaskStep(
      list,
      {
        taskId,
        toolUseId: event.toolUseId,
        title: event.taskDescription || event.toolInputSummary || task?.title,
        summary: task?.latestSummary,
      },
      now,
    );
    if (task) {
      list = setTaskStepStatus(
        list,
        taskId,
        stepStatusOfTask(task.status),
        now,
        task.latestSummary,
      );
    }
    this.list = list;
  }
}

// ── What a reader may see, and what is kept ─────────────────────────────

export interface StepsView {
  /**
   * The reasoning text and titles (`full` in a proactive Workspace). Without
   * it a thinking step keeps its status and times only.
   */
  includeThinking: boolean;
  /**
   * A proactive Workspace: its speech tool is no step, and no step holds model
   * text but the reasoning (a turn stored while the Workspace was an Assistant
   * one may still hold the narration between tool calls).
   */
  proactive?: boolean;
}

/**
 * The steps cut down to what `view` shows. Used when a turn is stored (what
 * the Workspace shows then is the most a later reader can get) and again when
 * it is read (the Workspace's *current* contract wins).
 */
export function viewSteps(
  steps: readonly StreamingStep[],
  view: StepsView,
): StreamingStep[] {
  const out: StreamingStep[] = [];
  for (const step of steps) {
    if (view.proactive) {
      if (step.kind === 'text') continue;
      if (step.kind === 'tool' && isMessageDeliveryTool(step.toolName)) {
        continue;
      }
    }
    if (!view.includeThinking) {
      if (step.kind === 'text') continue;
      if (step.kind === 'thinking') {
        const { text: _text, title: _title, ...rest } = step;
        out.push(rest);
        continue;
      }
    }
    out.push(step);
  }
  return out;
}

/** A cut thinking text shorter than this is dropped whole. */
const MIN_KEPT_THINKING_BYTES = 256;

/**
 * Bound the reasoning text of all thinking steps to `maxBytes` of UTF-8: the
 * oldest text goes first and the step keeps its title and times. Returns
 * `steps` itself when it already fits.
 */
export function capStepsThinkingBytes(
  steps: StreamingStep[],
  maxBytes: number,
): StreamingStep[] {
  const sizes = steps.map((step) =>
    step.kind === 'thinking' && step.text
      ? Buffer.byteLength(step.text, 'utf8')
      : 0,
  );
  let excess = sizes.reduce((sum, size) => sum + size, 0) - maxBytes;
  if (excess <= 0) return steps;
  const out = steps.slice();
  for (let index = 0; index < out.length && excess > 0; index += 1) {
    const size = sizes[index];
    if (size === 0) continue;
    const { text, ...rest } = out[index];
    const kept = size - excess;
    if (kept < MIN_KEPT_THINKING_BYTES) {
      // Not worth a stump with a cut marker.
      out[index] = rest;
      excess -= size;
    } else {
      // The tail of this one fits what is left.
      out[index] = { ...rest, text: capTailByBytes(text!, kept) };
      excess = 0;
    }
  }
  return out;
}

// ── Reading what was stored ──────────────────────────────────────────────

const STEP_KINDS: ReadonlySet<string> = new Set<StepKind>([
  'thinking',
  'tool',
  'task',
  'text',
]);
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>([
  'running',
  'done',
  'error',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A stored step with only the fields of the contract, or null if unusable. */
function readStep(raw: unknown): StreamingStep | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.kind !== 'string' ||
    !STEP_KINDS.has(row.kind) ||
    typeof row.status !== 'string' ||
    !STEP_STATUSES.has(row.status) ||
    !isFiniteNumber(row.at)
  ) {
    return null;
  }
  const step: StreamingStep = {
    id: row.id,
    kind: row.kind as StepKind,
    at: row.at,
    status: row.status as StepStatus,
  };
  if (isFiniteNumber(row.endedAt)) step.endedAt = row.endedAt;
  if (isFiniteNumber(row.durationMs)) step.durationMs = row.durationMs;
  if (isFiniteNumber(row.from)) step.from = row.from;
  if (row.commentary === true) step.commentary = true;
  for (const key of [
    'text',
    'title',
    'toolUseId',
    'toolName',
    'skillName',
    'summary',
    'resultPreview',
    'taskId',
  ] as const) {
    if (typeof row[key] === 'string') step[key] = row[key] as string;
  }
  return step;
}

/** The steps of a stored row; damaged JSON or rows read as no steps. */
export function parseStoredSteps(json: string): StreamingStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const steps: StreamingStep[] = [];
  for (const raw of parsed) {
    const step = readStep(raw);
    if (step) steps.push(step);
  }
  return steps;
}
