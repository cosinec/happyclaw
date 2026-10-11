/**
 * Server-side projection of a StreamEvent into the "execution trace" rows and
 * thinking timings the Web renders under a reply.
 *
 * The Web builds the same rows live (web/src/stores/chat.ts: pushTrace,
 * traceKind, traceTitle); the server needs them for two things the browser
 * cannot do on its own: restoring a run after a reconnect (stream_snapshot)
 * and keeping a finished turn's trace (turn_traces). Titles must match the
 * Web's character for character: the collapsed "已使用 N 个工具" summary counts
 * rows whose title starts with "工具 " / "技能 ". If the Web's formatting
 * changes, change it here as well (tests/stream-trace.test.ts pins the
 * formats).
 */

import type { StreamEvent } from './stream-event.types.js';

export type TraceEventKind =
  | 'tool'
  | 'skill'
  | 'hook'
  | 'status'
  | 'task'
  | 'memory'
  | 'debug'
  | 'context'
  | 'permission';

/** The Web's StreamingTraceEvent. */
export interface TraceEventRecord {
  id: string;
  timestamp: number;
  kind: TraceEventKind;
  scope?: StreamEvent['agentScope'];
  title: string;
  summary?: string;
  detail?: string;
  taskId?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  displayLevel?: StreamEvent['displayLevel'];
}

/** Statuses that describe the run's lifecycle, not news for the reader. */
export function isInternalLifecycleStatus(statusText?: string | null): boolean {
  return (
    statusText === 'requesting' ||
    statusText === 'compacting' ||
    statusText === 'idle' ||
    statusText === 'interrupted'
  );
}

/** Events that never become a trace row. */
const NON_TRACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text_delta',
  'thinking_delta',
  'thinking_start',
  'thinking_end',
  'usage',
  'init',
  'context_audit',
]);

export function traceKindFor(event: StreamEvent): TraceEventKind {
  const type = event.eventType;
  if (type.startsWith('tool_')) return event.skillName ? 'skill' : 'tool';
  if (type.startsWith('hook_')) return 'hook';
  if (type.startsWith('task_')) return 'task';
  if (type === 'memory_recall' || type === 'compact_boundary') return 'memory';
  if (type === 'permission_denied') return 'permission';
  if (type === 'raw_sdk_event') return 'debug';
  return 'status';
}

export function traceTitleFor(event: StreamEvent): string {
  if (event.title) return event.title;
  switch (event.eventType) {
    case 'tool_use_start':
      return event.skillName
        ? `技能 ${event.skillName}`
        : `工具 ${event.toolName || 'unknown'}`;
    case 'tool_use_end':
      return `工具完成 ${event.toolName || event.toolUseId || ''}`.trim();
    case 'tool_result':
      return '工具结果';
    case 'tool_progress':
      return `工具进度 ${event.toolName || event.toolUseId || ''}`.trim();
    case 'task_start':
      return 'Task 启动';
    case 'task_progress':
      return 'Task 进度';
    case 'task_updated':
      return 'Task 更新';
    case 'task_notification':
      return `Task ${event.taskStatus || '完成'}`;
    case 'status':
      return event.statusText || '状态更新';
    case 'permission_denied':
      return `权限拒绝 ${event.toolName || ''}`.trim();
    case 'memory_recall':
      return '记忆召回';
    case 'compact_boundary':
      return '上下文压缩';
    case 'notification':
      return '通知';
    case 'prompt_suggestion':
      return '建议';
    default:
      return event.rawType || event.eventType;
  }
}

/**
 * The SDK's tool_progress heartbeat carries only an elapsed counter, so its
 * row would read "工具进度 Bash" again and again and push real rows out of the
 * bounded trace.
 */
function isHeartbeatToolProgress(event: StreamEvent): boolean {
  return (
    event.eventType === 'tool_progress' &&
    !event.toolInputSummary &&
    !event.toolInput &&
    !event.skillName
  );
}

/**
 * One trace row for an event, or null when the event is not part of the trace.
 * Same rows as the Web's pushTrace, minus the ones the Web itself never shows
 * (debug-level events) and tool_progress heartbeats.
 */
export function traceEventFor(
  event: StreamEvent,
  now: number = Date.now(),
): TraceEventRecord | null {
  if (NON_TRACE_EVENT_TYPES.has(event.eventType)) return null;
  if (
    event.eventType === 'status' &&
    isInternalLifecycleStatus(event.statusText)
  ) {
    return null;
  }
  if (event.displayLevel === 'debug') return null;
  if (isHeartbeatToolProgress(event)) return null;
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now,
    kind: traceKindFor(event),
    scope: event.agentScope,
    title: traceTitleFor(event),
    summary:
      event.summary ||
      event.taskSummary ||
      event.statusText ||
      event.toolInputSummary,
    detail: event.detail,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    parentToolUseId: event.parentToolUseId,
    displayLevel: event.displayLevel,
  };
}

/** Append a row, keeping the newest `max`. */
export function appendTraceEvent(
  events: TraceEventRecord[],
  event: StreamEvent,
  max: number,
  now?: number,
): TraceEventRecord[] {
  const row = traceEventFor(event, now);
  if (!row) return events;
  events.push(row);
  return events.length > max ? events.slice(-max) : events;
}

// ── Text bounds ──────────────────────────────────────────────────────────

const ELLIPSIS_BREAK = '…\n\n';

/** Do not start a cut text on the second half of a surrogate pair. */
function alignToCodePoint(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  const code = text.charCodeAt(start);
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
}

/**
 * The last `max` characters of `text`, cut at a paragraph boundary when one is
 * close enough to keep at least half of the budget. Returns `text` itself
 * when it already fits.
 */
export function capTailAtParagraph(text: string, max: number): string {
  if (text.length <= max) return text;
  const minStart = text.length - max;
  const boundary = text.indexOf('\n\n', minStart);
  const start =
    boundary >= 0 && text.length - (boundary + 2) >= max / 2
      ? boundary + 2
      : alignToCodePoint(text, minStart);
  return text.slice(start);
}

/**
 * The tail of `text` that fits in `maxBytes` of UTF-8, led by a "…" paragraph
 * marker so a reader can tell it was cut. Returns `text` itself when it
 * already fits.
 */
export function capTailByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ELLIPSIS_BREAK));
  // Smallest start whose tail fits the budget.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= budget) hi = mid;
    else lo = mid + 1;
  }
  let start = alignToCodePoint(text, lo);
  const boundary = text.indexOf('\n\n', start);
  // Prefer a paragraph start, unless that gives up more than half the tail.
  if (
    boundary >= 0 &&
    text.length - (boundary + 2) >= (text.length - start) / 2
  )
    start = boundary + 2;
  return `${ELLIPSIS_BREAK}${text.slice(start)}`;
}

// ── Thinking text ────────────────────────────────────────────────────────

/**
 * The main Agent's reasoning text of one run or turn. The model reasons once
 * per request, so a turn with tool calls has several blocks: they are
 * separated by a blank line, however the Runner announces them (old Runners
 * send no thinking_start). Sub-Agent reasoning is not part of it.
 */
export class ThinkingTextBuffer {
  text = '';
  /** Something other than reasoning happened since the last thinking text. */
  private blockClosed = false;

  /** `cap` bounds the text after an append; return `text` itself if it fits. */
  constructor(private readonly cap: (text: string) => string) {}

  observe(event: StreamEvent): void {
    if (event.parentToolUseId) return;
    switch (event.eventType) {
      case 'thinking_delta':
        if (!event.text) return;
        if (this.text && this.blockClosed && !this.text.endsWith('\n'))
          this.text += '\n\n';
        this.blockClosed = false;
        this.text = this.cap(this.text + event.text);
        break;
      case 'thinking_start':
      case 'thinking_end':
      case 'text_delta':
      case 'tool_use_start':
        this.blockClosed = true;
        break;
      case 'status':
        if (event.statusText === 'requesting') this.blockClosed = true;
        break;
      default:
        break;
    }
  }

  /** Append what another buffer collected after this one. */
  absorb(other: ThinkingTextBuffer): void {
    if (!other.text) return;
    if (this.text && !this.text.endsWith('\n')) this.text += '\n\n';
    this.text = this.cap(this.text + other.text);
    this.blockClosed = other.blockClosed;
  }
}

// ── Thinking timing ──────────────────────────────────────────────────────

/**
 * Wall-clock time the model spent reasoning, measured the way the Web shows
 * it ("已思考 Xs"): a burst starts when the model's request did, not when its
 * first summary text arrived, because reasoning is usually silent first and
 * then arrives in one piece. Mirrors markThinkingStarted/markThinkingEnded in
 * web/src/stores/chat.ts. Only the main Agent's events count.
 */
export class ThinkingClock {
  /** When the open burst began, or undefined while not thinking. */
  startedAt?: number;
  /** Finished bursts, summed. */
  durationMs = 0;
  /** When the model's current request began; the next burst starts there. */
  phaseStartedAt?: number;
  /** A tool returned and the model has produced nothing since. */
  awaitingModel = false;
  /** Any reasoning block was seen (even one without text). */
  sawThinking = false;
  private visibleOutput = false;

  constructor(private readonly runStartedAt?: number) {}

  get isThinking(): boolean {
    return this.startedAt !== undefined;
  }

  /** Thinking time so far, including a burst still open. */
  totalMs(now: number = Date.now()): number {
    return this.startedAt !== undefined
      ? this.durationMs + Math.max(0, now - this.startedAt)
      : this.durationMs;
  }

  private open(now: number): void {
    this.sawThinking = true;
    if (this.startedAt === undefined) {
      const requestStart =
        this.phaseStartedAt ??
        (this.durationMs === 0 && !this.visibleOutput
          ? this.runStartedAt
          : undefined);
      this.startedAt =
        requestStart !== undefined && requestStart <= now ? requestStart : now;
    }
    this.phaseStartedAt = undefined;
    this.awaitingModel = false;
  }

  private close(now: number, reportedMs = 0): void {
    if (this.startedAt === undefined) return;
    this.durationMs += Math.max(Math.max(0, now - this.startedAt), reportedMs);
    this.startedAt = undefined;
  }

  observe(event: StreamEvent, now: number = Date.now()): void {
    if (event.parentToolUseId) return;
    switch (event.eventType) {
      case 'status':
        if (event.statusText === 'requesting') this.phaseStartedAt = now;
        else if (
          event.statusText === 'idle' ||
          event.statusText === 'interrupted'
        )
          this.close(now);
        break;
      case 'thinking_start':
      case 'thinking_delta':
        if (event.eventType === 'thinking_delta' && !event.text) break;
        this.open(now);
        break;
      case 'thinking_end':
        this.close(now, event.thinkingDurationMs ?? 0);
        break;
      case 'text_delta':
        if (!event.text) break;
        this.close(now);
        this.visibleOutput = true;
        this.awaitingModel = false;
        this.phaseStartedAt = undefined;
        break;
      case 'tool_use_start':
        this.close(now);
        if (!event.isNested) {
          this.awaitingModel = false;
          this.phaseStartedAt = undefined;
        }
        break;
      case 'tool_use_end':
      case 'tool_result':
        if (!event.isNested) {
          this.awaitingModel = true;
          this.phaseStartedAt = now;
        }
        break;
      default:
        break;
    }
  }
}
