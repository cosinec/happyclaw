/**
 * Thinking summary and execution trace of a finished turn.
 *
 * A reply's reasoning and "执行详情" used to live in browser memory only, so a
 * refresh lost them. The host now collects them from the stream while the turn
 * runs and stores them in turn_traces when the turn settles; the Web fetches
 * them on demand (GET /api/groups/:jid/turn-traces/:turnId) and learns which
 * messages have one from `has_trace`.
 */

import {
  getLastAgentMessageIdForTurn,
  getWorkspaceInteractionMode,
  getWorkspaceProcessVisibility,
  listTurnIdsWithTrace,
  upsertTurnTrace,
  type TurnTraceRecord,
} from './db.js';
import { logger } from './logger.js';
import type { StreamEvent } from './stream-event.types.js';
import {
  appendTraceEvent,
  capTailByBytes,
  ThinkingClock,
  ThinkingTextBuffer,
  type TraceEventRecord,
} from './stream-trace.js';
import type {
  InteractionMode,
  NewMessage,
  ProcessVisibility,
} from './types.js';
import { projectSdkStreamEventForWeb } from './workspace-interaction-runtime.js';

/** Trace rows kept per turn (the Web shows the newest 20 per group anyway). */
export const MAX_TURN_TRACE_EVENTS = 200;
/** UTF-8 bytes of thinking kept per turn; the tail wins when it overflows. */
export const MAX_TURN_TRACE_THINKING_BYTES = 64 * 1024;
/** Turns whose trace is being collected at once (a warm Runner can queue many). */
const MAX_OPEN_TURNS = 32;

export interface TurnTraceContent {
  thinking: string;
  /** Null when the model never reasoned during the turn. */
  thinkingDurationMs: number | null;
  trace: TraceEventRecord[];
}

/**
 * Bound the thinking text in steps, not on every delta: measuring bytes is
 * linear in the text.
 */
function capTurnThinking(text: string): string {
  return text.length * 3 > MAX_TURN_TRACE_THINKING_BYTES * 2 &&
    Buffer.byteLength(text, 'utf8') > MAX_TURN_TRACE_THINKING_BYTES * 1.25
    ? capTailByBytes(text, MAX_TURN_TRACE_THINKING_BYTES)
    : text;
}

/** Collects the thinking text and trace rows of one turn from its stream. */
export class TurnTraceAccumulator {
  private readonly thinking = new ThinkingTextBuffer(capTurnThinking);
  private trace: TraceEventRecord[] = [];
  private readonly clock: ThinkingClock;

  constructor(startedAt: number = Date.now()) {
    this.clock = new ThinkingClock(startedAt);
  }

  get isEmpty(): boolean {
    return (
      !this.thinking.text && this.trace.length === 0 && !this.clock.sawThinking
    );
  }

  observe(event: StreamEvent, now: number = Date.now()): void {
    this.clock.observe(event, now);
    this.thinking.observe(event);
    this.trace = appendTraceEvent(
      this.trace,
      event,
      MAX_TURN_TRACE_EVENTS,
      now,
    );
  }

  /** Append what `other` collected after this one (a held reply sequence). */
  absorb(other: TurnTraceAccumulator, now: number = Date.now()): void {
    this.thinking.absorb(other.thinking);
    this.trace = [...this.trace, ...other.trace].slice(-MAX_TURN_TRACE_EVENTS);
    this.clock.durationMs += other.clock.totalMs(now);
    this.clock.sawThinking ||= other.clock.sawThinking;
  }

  /** What to store, or null when nothing worth keeping was collected. */
  toContent(options: {
    includeThinking: boolean;
    now?: number;
  }): TurnTraceContent | null {
    const thinking = options.includeThinking
      ? capTailByBytes(this.thinking.text, MAX_TURN_TRACE_THINKING_BYTES)
      : '';
    const thinkingDurationMs = this.clock.sawThinking
      ? Math.round(this.clock.totalMs(options.now))
      : null;
    if (!thinking && this.trace.length === 0 && thinkingDurationMs === null)
      return null;
    return { thinking, thinkingDurationMs, trace: [...this.trace] };
  }
}

export interface TurnTraceTrackerOptions {
  /** The interaction contract of the loop the turns belong to. */
  mode: InteractionMode;
  /**
   * The Workspace's current process visibility. Read when an event arrives and
   * again when a turn settles: it can change while a turn runs.
   */
  getVisibility: () => ProcessVisibility;
  /** Defaults to upsertTurnTrace. */
  store?: (input: Parameters<typeof upsertTurnTrace>[0]) => void;
}

/**
 * Per-run bookkeeping: gathers every turn's trace as stream events arrive and
 * writes it when the turn settles.
 *
 * Assistant turns are always recorded. A proactive turn is recorded only while
 * its Workspace shows some process (`activity` or `full`), and then only from
 * the events the Web may see at the most permissive level: tool results, the
 * model's answer text and the like never reach the trace, whatever the level
 * is later changed to. `activity` keeps no thinking text.
 */
export class TurnTraceTracker {
  private readonly turns = new Map<string, TurnTraceAccumulator>();
  private readonly store: NonNullable<TurnTraceTrackerOptions['store']>;

  constructor(private readonly options: TurnTraceTrackerOptions) {
    this.store = options.store ?? upsertTurnTrace;
  }

  private recording(): boolean {
    return (
      this.options.mode === 'assistant' ||
      this.options.getVisibility() !== 'hidden'
    );
  }

  observe(inputId: string, event: StreamEvent, now: number = Date.now()): void {
    if (!this.recording()) return;
    const visible =
      this.options.mode === 'assistant'
        ? event
        : projectSdkStreamEventForWeb('proactive', 'full', event);
    if (!visible) return;
    let turn = this.turns.get(inputId);
    if (!turn) {
      turn = new TurnTraceAccumulator(now);
      this.turns.set(inputId, turn);
      while (this.turns.size > MAX_OPEN_TURNS) {
        const oldest = this.turns.keys().next().value;
        if (oldest === undefined) break;
        this.turns.delete(oldest);
      }
    }
    turn.observe(visible, now);
  }

  /** Forget a turn that ended without anything to store. */
  discard(inputId: string): void {
    this.turns.delete(inputId);
  }

  /**
   * Store the trace collected for `inputId` under the message chat and turn it
   * belongs to. `turnId` is the id the turn's messages carry; it differs from
   * `inputId` only for a held reply sequence, which shares its first turn's
   * id. `keep` leaves the collected trace in place for a later write of the
   * same turn. Never throws: a missing trace must not lose a reply.
   */
  persist(input: {
    chatJid: string;
    inputId: string;
    turnId?: string;
    keep?: boolean;
    now?: number;
  }): boolean {
    const turnId = input.turnId || input.inputId;
    try {
      let turn = this.turns.get(input.inputId);
      if (turn && turnId !== input.inputId) {
        this.turns.delete(input.inputId);
        const sequence = this.turns.get(turnId);
        if (sequence) sequence.absorb(turn, input.now);
        else this.turns.set(turnId, turn);
        turn = this.turns.get(turnId);
      } else if (!turn) {
        turn = this.turns.get(turnId);
      }
      if (!turn) return false;
      const visibility =
        this.options.mode === 'assistant'
          ? 'full'
          : this.options.getVisibility();
      if (visibility === 'hidden') {
        this.turns.delete(turnId);
        return false;
      }
      const content = turn.toContent({
        includeThinking: visibility === 'full',
        now: input.now,
      });
      if (!input.keep) this.turns.delete(turnId);
      if (!content) return false;
      this.store({
        chatJid: input.chatJid,
        turnId,
        thinking: content.thinking,
        thinkingDurationMs: content.thinkingDurationMs,
        traceJson: JSON.stringify(content.trace),
      });
      return true;
    } catch (error) {
      logger.warn(
        { err: error, chatJid: input.chatJid, turnId },
        'Failed to store the turn trace',
      );
      return false;
    }
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

/** What a reader may see of the traces in one Workspace. */
export interface TurnTraceExposure {
  /** False hides every trace (a proactive Workspace set to `hidden`). */
  visible: boolean;
  /** False blanks the thinking text (`activity`). */
  includeThinking: boolean;
}

/**
 * Traces follow the Workspace's *current* contract: a proactive Workspace
 * shows what its process visibility allows now, whatever it allowed when the
 * turn ran. Fire-and-forget spawn Agents keep Assistant semantics.
 */
export function resolveTurnTraceExposure(
  folder: string,
  options: { agentKind?: string | null } = {},
): TurnTraceExposure {
  if (
    options.agentKind === 'spawn' ||
    getWorkspaceInteractionMode(folder) === 'assistant'
  ) {
    return { visible: true, includeThinking: true };
  }
  const visibility = getWorkspaceProcessVisibility(folder);
  return {
    visible: visibility !== 'hidden',
    includeThinking: visibility === 'full',
  };
}

/** The GET /turn-traces/:turnId body. */
export interface PresentedTurnTrace {
  turn_id: string;
  thinking: string;
  thinking_duration_ms: number | null;
  trace: TraceEventRecord[];
  created_at: string;
}

export function presentTurnTrace(
  record: TurnTraceRecord,
  exposure: TurnTraceExposure,
): PresentedTurnTrace {
  let trace: TraceEventRecord[] = [];
  try {
    const parsed: unknown = JSON.parse(record.trace_json);
    if (Array.isArray(parsed)) trace = parsed as TraceEventRecord[];
  } catch {
    /* a damaged trace still has its thinking and timing */
  }
  return {
    turn_id: record.turn_id,
    thinking: exposure.includeThinking ? record.thinking : '',
    thinking_duration_ms: record.thinking_duration_ms,
    trace,
    created_at: record.created_at,
  };
}

type ListedMessage = NewMessage & { is_from_me?: boolean | number };

/** Agent-authored, as opposed to a user message or a system notice. */
function isAgentMessage(message: ListedMessage): boolean {
  return (
    !!message.is_from_me &&
    !(typeof message.sender === 'string' && message.sender.startsWith('__'))
  );
}

/**
 * Flag the last agent message of every listed turn that has a stored trace
 * with `has_trace`. The flag belongs to the turn's true last message, so a
 * turn split across two pages is flagged on its newer page only.
 */
export function markMessagesWithTrace<T extends ListedMessage>(
  messages: T[],
  exposure: TurnTraceExposure,
): T[] {
  if (!exposure.visible || messages.length === 0) return messages;
  const turnsByChat = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!message.turn_id || !isAgentMessage(message)) continue;
    let turns = turnsByChat.get(message.chat_jid);
    if (!turns) {
      turns = new Set();
      turnsByChat.set(message.chat_jid, turns);
    }
    turns.add(message.turn_id);
  }
  const flagged = new Set<string>();
  for (const [chatJid, turns] of turnsByChat) {
    for (const turnId of listTurnIdsWithTrace(chatJid, [...turns])) {
      const lastId = getLastAgentMessageIdForTurn(chatJid, turnId);
      if (lastId) flagged.add(`${chatJid}\0${lastId}`);
    }
  }
  if (flagged.size === 0) return messages;
  return messages.map((message) =>
    flagged.has(`${message.chat_jid}\0${message.id}`)
      ? { ...message, has_trace: true }
      : message,
  );
}
