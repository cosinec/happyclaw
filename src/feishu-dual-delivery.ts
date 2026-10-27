/**
 * Feishu's 「同时发送到群聊」 option on a thread reply delivers one send as two
 * `im.message.receive_v1` events with different message ids: the thread reply
 * (with `thread_id`) and a copy in the group's main feed (without). Both carry
 * the same sender, chat, `create_time`, message type and raw content, and
 * nothing on the event says the option was ticked.
 *
 * The coordinator pairs them on that logical send key and lets exactly one
 * through. The thread reply wins: it never waits, and a main-feed copy that
 * arrives first waits a short window for it. A copy only exists for a thread
 * reply, so the wait applies only in chats where threads were used recently;
 * other group messages are not delayed. Once one side has gone through, any
 * later event with the same key is the other copy and is suppressed. The key
 * includes the millisecond send time, so the same text sent again is never
 * taken for a copy.
 *
 * State lives in process memory: the two events arrive within moments of
 * each other on the same connection. The suppressed copy still gets a
 * terminal Inbox row from the caller, so a redelivery or a later backfill of
 * the main feed does not run it either.
 */
import { createHash } from 'node:crypto';

const PAIR_WINDOW_MS = 1_000;
/** How long a delivered send suppresses its copy (late redeliveries). */
const COPY_TTL_MS = 10 * 60 * 1000;
/** A chat counts as using threads this long after its last thread message. */
const THREAD_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SENDS = 2_000;
const MAX_THREAD_CHATS = 5_000;

export interface FeishuDualDeliveryCandidate {
  /** Account (or app) the event arrived on. */
  accountKey: string;
  chatId: string;
  messageId: string;
  threadId?: string;
  senderOpenId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
}

export type FeishuDualDeliveryDecision =
  | { suppress: false }
  | { suppress: true; twinMessageId: string };

interface LogicalSend {
  /** The event that went through. */
  winner?: string;
  /** A main-feed event waiting for its thread twin. */
  waiting?: { messageId: string; settle: (winner: string) => void };
  expiresAt: number;
}

const DISPATCH: FeishuDualDeliveryDecision = { suppress: false };

function decisionFor(
  winner: string,
  messageId: string,
): FeishuDualDeliveryDecision {
  return winner === messageId
    ? DISPATCH
    : { suppress: true, twinMessageId: winner };
}

export class FeishuDualDeliveryCoordinator {
  private readonly sends = new Map<string, LogicalSend>();
  private readonly threadChats = new Map<string, number>();
  private readonly pairWindowMs: number;

  constructor(options: { pairWindowMs?: number } = {}) {
    this.pairWindowMs = options.pairWindowMs ?? PAIR_WINDOW_MS;
  }

  /** A thread message was seen in this chat at `atMs`. */
  noteThreadActivity(accountKey: string, chatId: string, atMs: number): void {
    const key = `${accountKey}\u0000${chatId}`;
    if ((this.threadChats.get(key) ?? 0) >= atMs) return;
    this.threadChats.delete(key);
    this.threadChats.set(key, atMs);
    for (const oldest of this.threadChats.keys()) {
      if (this.threadChats.size <= MAX_THREAD_CHATS) break;
      this.threadChats.delete(oldest);
    }
  }

  private usesThreads(accountKey: string, chatId: string): boolean {
    const last = this.threadChats.get(`${accountKey}\u0000${chatId}`);
    return last !== undefined && Date.now() - last <= THREAD_ACTIVITY_TTL_MS;
  }

  /**
   * Decide one group-chat event. `wait` lets a main-feed event wait for its
   * thread twin (live events); backfill decides on what was already seen.
   */
  async coordinate(
    candidate: FeishuDualDeliveryCandidate,
    options: { wait: boolean },
  ): Promise<FeishuDualDeliveryDecision> {
    if (candidate.threadId) {
      this.noteThreadActivity(
        candidate.accountKey,
        candidate.chatId,
        candidate.createTimeMs,
      );
    }
    const key = logicalSendKey(candidate);
    if (!key) return DISPATCH;
    const now = Date.now();
    this.prune(now);
    let send = this.sends.get(key);
    if (!send) {
      send = { expiresAt: now + COPY_TTL_MS };
      this.sends.set(key, send);
    }
    const { messageId } = candidate;
    const waitingId = send.waiting?.messageId;
    if (candidate.threadId && waitingId && waitingId !== messageId) {
      // The thread reply arrived while its main-feed copy waited.
      this.win(send, messageId);
    }
    if (send.winner) return decisionFor(send.winner, messageId);
    // A second main-feed copy, or the waiting event delivered again.
    if (waitingId) return decisionFor(waitingId, messageId);
    if (
      candidate.threadId ||
      !options.wait ||
      !this.usesThreads(candidate.accountKey, candidate.chatId)
    ) {
      this.win(send, messageId);
      return DISPATCH;
    }
    const waiting = send;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.win(waiting, messageId),
        this.pairWindowMs,
      );
      timer.unref?.();
      waiting.waiting = {
        messageId,
        settle: (winner) => {
          clearTimeout(timer);
          resolve(decisionFor(winner, messageId));
        },
      };
    });
  }

  private win(send: LogicalSend, messageId: string): void {
    send.winner = messageId;
    send.expiresAt = Date.now() + COPY_TTL_MS;
    const waiting = send.waiting;
    send.waiting = undefined;
    waiting?.settle(messageId);
  }

  /** Oldest first; a waiting main-feed event is never dropped. */
  private prune(now: number): void {
    for (const [key, send] of this.sends) {
      if (send.expiresAt > now && this.sends.size <= MAX_SENDS) break;
      if (!send.waiting) this.sends.delete(key);
    }
  }
}

function logicalSendKey(candidate: FeishuDualDeliveryCandidate): string | null {
  if (
    !candidate.senderOpenId ||
    !Number.isSafeInteger(candidate.createTimeMs) ||
    candidate.createTimeMs <= 0
  ) {
    return null;
  }
  return createHash('sha256')
    .update(
      [
        candidate.accountKey,
        candidate.chatId,
        candidate.senderOpenId,
        String(candidate.createTimeMs),
        candidate.messageType,
        candidate.content,
      ].join('\u0000'),
    )
    .digest('hex');
}
