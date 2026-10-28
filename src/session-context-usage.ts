/**
 * How full a conversation's context is, for the ring next to the composer.
 *
 * Read on the host from the SDK transcript of the conversation's current
 * session: the last main-thread request's prompt (input + cache read + cache
 * creation) is what the context held when the model last answered, the same
 * count Claude Code's own context indicator works from. No runner change is
 * needed, so container workspaces running an older image report it too.
 */
import fs from 'node:fs';

import { getJidsByFolder, getSession, getSessionModel } from './db.js';
import { modelCapabilities, splitOneMillionSuffix } from './model-providers.js';
import { latestSdkContextWindow } from './run-context-snapshot.js';
import { sessionTranscriptPath } from './session-workflows.js';

export interface SessionContextUsage {
  usedTokens: number | null;
  contextWindow: number | null;
  /** usedTokens of contextWindow, in percent with one decimal. */
  percentage: number | null;
  /** The upstream model the last request ran on. */
  model: string | null;
  /** When that request's answer was written. */
  updatedAt: string | null;
}

export const NO_CONTEXT_USAGE: SessionContextUsage = {
  usedTokens: null,
  contextWindow: null,
  percentage: null,
  model: null,
  updatedAt: null,
};

/** Claude Code's window for a model it is given no larger one for. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const ONE_MILLION_WINDOW = 1_000_000;
/** Transcript bytes read from the end to find the last request. */
const RECENT_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

interface LastRequest {
  usedTokens: number;
  model: string;
  at: string | null;
}

function tokens(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Reads one transcript line: a main-thread answer with its usage, a
 * compaction (the context is now unknown until the next answer), or nothing
 * of interest.
 */
function readLine(line: string): LastRequest | 'compacted' | null {
  if (!line.trim()) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    return 'compacted';
  }
  if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
  const message = entry.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  const model = typeof message?.model === 'string' ? message.model : '';
  if (!usage || !model || model === '<synthetic>') return null;
  const usedTokens =
    tokens(usage.input_tokens) +
    tokens(usage.cache_read_input_tokens) +
    tokens(usage.cache_creation_input_tokens);
  if (usedTokens === 0) return null;
  return {
    usedTokens,
    model,
    at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
  };
}

/**
 * The last `bytes` of a file as whole lines (a line cut at the start is
 * dropped), and whether that was the whole file.
 */
function tailLines(
  file: string,
  bytes: number,
): { lines: string[]; whole: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The last main-thread request of a transcript, read from its end: the
 * recent tail first, a longer one only when long tool results pushed the
 * last answer further back.
 */
function lastRequest(transcript: string): LastRequest | null {
  for (const bytes of [RECENT_TAIL_BYTES, MAX_TAIL_BYTES]) {
    let tail: ReturnType<typeof tailLines>;
    try {
      tail = tailLines(transcript, bytes);
    } catch {
      return null;
    }
    for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
      const found = readLine(tail.lines[index]);
      if (found === 'compacted') return null;
      if (found) return found;
    }
    if (tail.whole) return null;
  }
  return null;
}

/**
 * The window Claude Code works with: what it reported for this
 * conversation's model when it is known, else 1M for a `[1m]` model, else
 * the model's window capped at Claude Code's default.
 */
function contextWindowFor(
  groupFolder: string,
  agentId: string | null,
  model: string,
  launchModel: string | null,
): number {
  const reported = latestSdkContextWindow(
    getJidsByFolder(groupFolder),
    agentId,
    [model, ...(launchModel ? [launchModel] : [])],
  );
  if (reported) return reported;
  if (launchModel && splitOneMillionSuffix(launchModel).oneMillion) {
    return ONE_MILLION_WINDOW;
  }
  const capability = modelCapabilities(launchModel || model)?.contextWindow;
  return Math.min(capability ?? DEFAULT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW);
}

/**
 * How full one conversation's context is now. Everything is null when the
 * conversation has no SDK session (nothing ran yet, or it was cleared) or
 * its context was just compacted.
 */
export function readSessionContextUsage(
  groupFolder: string,
  agentId: string | null,
): SessionContextUsage {
  const sessionId = getSession(groupFolder, agentId);
  if (!sessionId) return NO_CONTEXT_USAGE;
  const transcript = sessionTranscriptPath(groupFolder, agentId, sessionId);
  const last = transcript ? lastRequest(transcript) : null;
  if (!last) return NO_CONTEXT_USAGE;
  const contextWindow = contextWindowFor(
    groupFolder,
    agentId,
    last.model,
    getSessionModel(groupFolder, agentId),
  );
  return {
    usedTokens: last.usedTokens,
    contextWindow,
    percentage: Math.round((last.usedTokens / contextWindow) * 1000) / 10,
    model: last.model,
    updatedAt: last.at,
  };
}

type ClearedListener = (groupFolder: string, agentId: string | null) => void;
const clearedListeners = new Set<ClearedListener>();

/** Called whenever a conversation's context is cleared (the Web is told). */
export function onConversationContextCleared(
  listener: ClearedListener,
): () => void {
  clearedListeners.add(listener);
  return () => clearedListeners.delete(listener);
}

/** A /clear, /fresh or session reset emptied this conversation's context. */
export function notifyConversationContextCleared(
  groupFolder: string,
  agentId: string | null,
): void {
  for (const listener of clearedListeners) listener(groupFolder, agentId);
}
