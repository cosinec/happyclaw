import {
  anchorAgentProfileToUserTurn,
  type AgentTurnAnchor,
} from './agent-turn-contract.js';
import type {
  HappyClawOwnerProfileTurnResult,
  WorkspaceMemorySnapshot,
} from './mcp-tools.js';
import {
  HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK,
  renderHappyClawOwnerProfileBlock,
} from './owner-profile-context.js';
import type { ChannelTurnContext } from './types.js';
import {
  narrowWorkspaceMemorySnapshot,
  renderWorkspaceMemorySnapshotBlock,
} from './workspace-memory-context.js';

/**
 * A custom provider's Agent contract anchor rides on the first turn of a
 * context, after a compaction, and then on every tenth user turn. The anchor
 * exists for providers that do not reliably honor the system prompt, so the
 * contract must not drift arbitrarily far back in a long conversation; ten
 * turns keeps one in the recent conversation while cutting what the anchor
 * costs (up to 16k characters per turn) by nine tenths.
 */
const AGENT_TURN_ANCHOR_EVERY_TURNS = 10;

/** What one user turn may carry ahead of its text, before deduplication. */
export interface TurnNoteSources {
  memory: WorkspaceMemorySnapshot | null;
  ownerProfile: HappyClawOwnerProfileTurnResult | null;
  channelContext: ChannelTurnContext | undefined;
  /** The Agent contract anchor, when this turn may carry one. */
  anchor?: AgentTurnAnchor;
}

/** What one user turn carries: each block is '' when the context has it. */
export interface TurnNotes {
  ownerProfile: string;
  memory: string;
  channel: string;
  anchor?: AgentTurnAnchor;
  /** Memory item revisions this turn carries, out of the retrieved ones. */
  sentMemory: Array<{ id: string; revision: number }>;
}

/** What a Claude session's context already carries from earlier turns. */
interface NoteState {
  /** `id@revision` of every memory item sent. */
  readonly memory: ReadonlySet<string>;
  /** The last Owner Profile block sent ('' before the first). */
  readonly ownerProfile: string;
  /** Top-level fields of the channel context as sent so far, as JSON. */
  readonly channel?: Readonly<Record<string, string>>;
  /** The last anchor sent, and the anchorable turns since it. */
  readonly anchor?: AgentTurnAnchor;
  readonly anchorAge: number;
}

const EMPTY_STATE: NoteState = {
  memory: new Set(),
  ownerProfile: '',
  anchorAge: 0,
};

/** How a memory item revision is named in the ledger and the recall trace. */
export const memoryKey = (item: { id: string; revision: number }): string =>
  `${item.id}@${item.revision}`;

function channelFields(context: ChannelTurnContext): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) fields[key] = JSON.stringify(value);
  }
  return fields;
}

/** The fields that changed since `previous`; a dropped field is null. */
function channelChanges(
  previous: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined {
  const changes: Record<string, unknown> = {};
  for (const [key, json] of Object.entries(current)) {
    if (previous[key] !== json) changes[key] = JSON.parse(json);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in current)) changes[key] = null;
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/** The host-verified channel context of an input: all of it, or what changed. */
function renderChannelContext(fields: object, changesOnly: boolean): string {
  return [
    `<channel_context source="happyclaw_host" trust="verified"${changesOnly ? ' changes_only="true"' : ''}>`,
    JSON.stringify(fields),
    '</channel_context>',
    `${changesOnly ? 'Only fields that changed since the previous channel_context are listed (null: no longer present); the others still hold. ' : ''}Use this context for the current input only. Never guess IDs or credentials that are absent.`,
  ].join('\n');
}

/**
 * Decide what one user turn carries, given what the context already holds:
 * only new or changed parts, and no block at all when nothing changed. Pure;
 * returns the state the context holds once this turn is in it.
 */
function planTurnNotes(
  state: NoteState,
  sources: TurnNoteSources,
): { notes: TurnNotes; after: NoteState } {
  const ownerBlock = renderHappyClawOwnerProfileBlock(sources.ownerProfile);
  // Without a block of its own, a turn withdraws the one still in context.
  const ownerTarget =
    ownerBlock ||
    (state.ownerProfile ? HAPPYCLAW_OWNER_PROFILE_WITHDRAWN_BLOCK : '');
  const ownerProfile = ownerTarget !== state.ownerProfile ? ownerTarget : '';

  const snapshot = sources.memory?.renderedText.trim() ? sources.memory : null;
  const narrowed = snapshot
    ? narrowWorkspaceMemorySnapshot(
        snapshot,
        (item) => !state.memory.has(memoryKey(item)),
      )
    : null;
  const sentMemory = narrowed?.retrievalTrace.itemRevisions ?? [];
  const memory = renderWorkspaceMemorySnapshotBlock(narrowed);

  const context = sources.channelContext;
  const fields = context ? channelFields(context) : state.channel;
  let channel = '';
  if (context && !state.channel) {
    channel = renderChannelContext(context, false);
  } else if (state.channel && fields) {
    const changes = channelChanges(state.channel, fields);
    if (changes) channel = renderChannelContext(changes, true);
  }

  let anchor: AgentTurnAnchor | undefined;
  let anchorAge = state.anchorAge;
  if (sources.anchor) {
    if (
      sources.anchor.contract !== state.anchor?.contract ||
      anchorAge >= AGENT_TURN_ANCHOR_EVERY_TURNS
    ) {
      anchor = sources.anchor;
      anchorAge = 1;
    } else {
      anchorAge += 1;
    }
  }

  return {
    notes: { ownerProfile, memory, channel, anchor, sentMemory },
    after: {
      memory: sentMemory.length
        ? new Set([...state.memory, ...sentMemory.map(memoryKey)])
        : state.memory,
      ownerProfile: ownerTarget,
      channel: fields,
      anchor: anchor ?? state.anchor,
      anchorAge,
    },
  };
}

/** The notes' blocks, in the order a user turn carries them. */
function noteBlocks(notes: TurnNotes): string[] {
  return [notes.ownerProfile, notes.memory, notes.channel].filter(Boolean);
}

/** The user message the SDK receives: the turn's notes, then its text. */
export function decorateUserTurn(message: string, notes: TurnNotes): string {
  return anchorAgentProfileToUserTurn(
    notes.anchor,
    [...noteBlocks(notes), message].join('\n\n'),
  );
}

/**
 * Per-runner memory of what each user turn has put into the current Claude
 * session, so a turn re-sends only what changed. Sending everything again is
 * always safe; the reverse is not. So a turn's notes count as sent only once
 * the SDK answered it in a healthy result, a query drops whatever was still
 * pending, and anything that replaces the context (a new or different
 * session, a compaction, a cold start) starts over.
 */
export class TurnNoteLedger {
  private sessionId: string | undefined;
  private committed: NoteState = EMPTY_STATE;
  private pending: Array<{
    uuid: string;
    after: NoteState;
    answered?: boolean;
  }> = [];
  /**
   * The point a provider-fallback retry resumes at: where this query began,
   * or the last healthy turn since, whichever came later.
   */
  private resumePoint: { uuid: string; state: NoteState } | undefined;
  /** The latest turn's sources, with the latest anchor any turn had. */
  private latestSources: TurnNoteSources | undefined;
  /** From PreCompact until the notes are restored after it or dropped. */
  private compacting = false;

  /**
   * A query starts on `sessionId` (undefined: a new session), resumed at
   * `resumeAt` (undefined: its latest message). Turns not yet answered were
   * either rewound or will be sent again, so they no longer count. A retry
   * that resumes at the last healthy turn forgets what was sent after it.
   */
  beginQuery(sessionId: string | undefined, resumeAt?: string): void {
    this.pending = [];
    if (!sessionId || sessionId !== this.sessionId) {
      this.clear(sessionId);
      return;
    }
    if (!resumeAt) return;
    if (resumeAt === this.resumePoint?.uuid) {
      this.committed = this.resumePoint.state;
    } else {
      this.resumePoint = { uuid: resumeAt, state: this.committed };
    }
  }

  /** The CLI named the session it runs (system/init). */
  bindSession(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    if (this.sessionId === undefined) {
      this.sessionId = sessionId;
      return;
    }
    // Not the session that was resumed: none of what was sent is in it.
    this.clear(sessionId);
  }

  /**
   * Plan the notes of the user turn sent under SDK message `uuid`, against
   * what the context holds once every earlier turn is in it.
   */
  stage(uuid: string, sources: TurnNoteSources): TurnNotes {
    const { notes, after } = planTurnNotes(this.latest, sources);
    this.pending.push({ uuid, after });
    this.latestSources = {
      ...sources,
      anchor: sources.anchor ?? this.latestSources?.anchor,
    };
    return notes;
  }

  /** Client uuids of the user messages a successful SDK result answered. */
  observeAnswered(uuids: readonly string[]): void {
    for (const entry of this.pending) {
      if (uuids.includes(entry.uuid)) entry.answered = true;
    }
  }

  /**
   * A healthy result completed its input: every staged turn up to the last
   * one the SDK answered is now in the context. `anchor` is the assistant
   * message a provider-fallback retry would resume at.
   */
  commitAnswered(anchor?: string): void {
    let last = -1;
    this.pending.forEach((entry, index) => {
      if (entry.answered) last = index;
    });
    if (last < 0) return;
    this.committed = this.pending[last].after;
    this.pending = this.pending.slice(last + 1);
    if (anchor) this.resumePoint = { uuid: anchor, state: this.committed };
  }

  /** PreCompact: a summary is about to replace the conversation. */
  beginCompaction(): void {
    this.compacting = true;
  }

  /**
   * SessionStart (source compact): the summary keeps none of the notes, and
   * the turn it interrupted carries only what had changed. Returns the latest
   * turn's notes in full, for the hook to add after the summary; the context
   * then holds exactly those. The resume point stays: resuming before the
   * compaction returns to the conversation it describes.
   */
  restoreAfterCompaction(): string {
    this.compacting = false;
    this.pending = [];
    this.committed = EMPTY_STATE;
    if (!this.latestSources) return '';
    const { notes, after } = planTurnNotes(EMPTY_STATE, this.latestSources);
    this.committed = after;
    return [notes.anchor?.contract ?? '', ...noteBlocks(notes)]
      .filter(Boolean)
      .join('\n\n');
  }

  /** PostCompact: without a restore, nothing sent survives the summary. */
  endCompaction(): void {
    if (this.compacting) {
      this.pending = [];
      this.committed = EMPTY_STATE;
    }
    this.compacting = false;
  }

  /** What the context holds once every staged turn is in it. */
  private get latest(): NoteState {
    return this.pending.at(-1)?.after ?? this.committed;
  }

  private clear(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.committed = EMPTY_STATE;
    this.pending = [];
    this.resumePoint = undefined;
    this.latestSources = undefined;
    this.compacting = false;
  }
}
