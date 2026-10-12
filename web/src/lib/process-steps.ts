/**
 * What the process card says about the steps of a reply, as pure functions
 * over `StreamingStep[]`: which steps it lists, which tool calls it merges into
 * one row, how long it all took and the one-line summary of a finished run.
 * The shared reducer (`stream-steps`) owns the steps themselves.
 */
import { describeToolCall } from '../components/chat/ToolActivityCard';
import {
  railSteps,
  summarizeSteps,
  type StepSummary,
  type StreamingStep,
} from './stream-steps';

// ── tools ───────────────────────────────────────────────────────────────

export type ToolCategory = 'terminal' | 'file' | 'search' | 'web' | 'generic';

const TERMINAL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
]);
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'LS',
]);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);

/** What kind of thing a tool works on, for the icon of its row. */
export function toolCategory(toolName: string | undefined): ToolCategory {
  if (!toolName) return 'generic';
  if (TERMINAL_TOOLS.has(toolName)) return 'terminal';
  if (FILE_TOOLS.has(toolName)) return 'file';
  if (SEARCH_TOOLS.has(toolName)) return 'search';
  if (WEB_TOOLS.has(toolName)) return 'web';
  return 'generic';
}

/**
 * Local read-only tools: a run of them in a row is one line in the timeline
 * ("browsed 5 files, searched twice"). Anything that can change a file or run
 * a command, and any tool this list does not know, keeps its own row.
 */
const BROWSE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'LS',
  'NotebookRead',
]);
const LOOKUP_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);

export function isReadOnlyStep(step: StreamingStep): boolean {
  const name = step.toolName;
  return (
    step.kind === 'tool' &&
    !!name &&
    (BROWSE_TOOLS.has(name) || LOOKUP_TOOLS.has(name))
  );
}

/** The step is a question put to the reader: the card shows it, not a row. */
export function isQuestionStep(step: StreamingStep): boolean {
  return step.kind === 'tool' && step.toolName === 'AskUserQuestion';
}

export type ProcessItem =
  | { type: 'step'; step: StreamingStep }
  | { type: 'group'; id: string; steps: StreamingStep[] };

/**
 * The steps as rows: two or more read-only calls in a row become one group.
 * A single one stays a row of its own, and anything else between two of them
 * (reasoning, a command, a note) ends the run.
 */
export function groupProcessSteps(
  steps: readonly StreamingStep[],
): ProcessItem[] {
  const items: ProcessItem[] = [];
  let run: StreamingStep[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ type: 'step', step: run[0] });
    else if (run.length > 1) {
      // Named by its first call, so a group keeps its identity as it grows.
      items.push({ type: 'group', id: `group-${run[0].id}`, steps: run });
    }
    run = [];
  };
  for (const step of steps) {
    if (isReadOnlyStep(step)) {
      run.push(step);
      continue;
    }
    flush();
    items.push({ type: 'step', step });
  }
  flush();
  return items;
}

export interface GroupSummary {
  /** Files and folders looked at. */
  files: number;
  /** Searches made (by content or by name). */
  searches: number;
  running: number;
  failed: number;
}

export function summarizeGroup(steps: readonly StreamingStep[]): GroupSummary {
  const summary: GroupSummary = {
    files: 0,
    searches: 0,
    running: 0,
    failed: 0,
  };
  for (const step of steps) {
    if (step.toolName && BROWSE_TOOLS.has(step.toolName)) summary.files += 1;
    else summary.searches += 1;
    if (step.status === 'running') summary.running += 1;
    if (step.status === 'error') summary.failed += 1;
  }
  return summary;
}

/** "已浏览 4 个文件 · 搜索 2 次": what a group of read-only calls did. */
export function describeGroup(summary: GroupSummary): string {
  const lead = summary.running > 0 ? '正在' : '已';
  const parts: string[] = [];
  if (summary.files > 0) parts.push(`${lead}浏览 ${summary.files} 个文件`);
  if (summary.searches > 0) {
    parts.push(
      summary.files > 0
        ? `搜索 ${summary.searches} 次`
        : `${lead}搜索 ${summary.searches} 次`,
    );
  }
  return parts.join(' · ');
}

// ── time ────────────────────────────────────────────────────────────────

/** How long a step took, if it says. */
export function stepDurationMs(step: StreamingStep): number | undefined {
  if (step.durationMs != null) return step.durationMs;
  return step.endedAt != null ? Math.max(0, step.endedAt - step.at) : undefined;
}

/**
 * The wall-clock span of the steps: from the first one's start to the last
 * one's end. `undefined` while one is still running or when they carry no
 * times; the caller then falls back on a total it knows from elsewhere.
 */
export function processSpanMs(
  steps: readonly StreamingStep[],
  fallbackMs?: number,
): number | undefined {
  const fallback =
    fallbackMs != null && Number.isFinite(fallbackMs) && fallbackMs > 0
      ? fallbackMs
      : undefined;
  if (steps.length === 0) return fallback;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (step.status === 'running') return fallback;
    start = Math.min(start, step.at);
    end = Math.max(end, step.endedAt ?? step.at + (step.durationMs ?? 0));
  }
  const span = end - start;
  return Number.isFinite(span) && span > 0 ? span : fallback;
}

/** "3.2 秒", "14 秒", "1 分 12 秒"; nothing for under a second. */
export function formatSpanZh(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 1000) return '';
  const seconds = ms / 1000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} 秒`;
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (rest === 60) return `${minutes + 1} 分`;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

// ── what the card lists ─────────────────────────────────────────────────

/** The steps the reader is meant to see: the commentary only when asked for. */
export function visibleSteps(
  steps: readonly StreamingStep[],
  commentary: boolean,
): StreamingStep[] {
  return commentary ? [...steps] : steps.filter((step) => step.kind !== 'text');
}

/** There is something to show of these steps (the timeline's own measure). */
export function hasListedSteps(steps: readonly StreamingStep[]): boolean {
  return railSteps(steps).length > 0;
}

/** The steps a finished run is summed up from. */
export function summarizedSteps(
  steps: readonly StreamingStep[],
): StreamingStep[] {
  return railSteps(steps).filter((step) => !isQuestionStep(step));
}

// ── the summary of a finished run ───────────────────────────────────────

/**
 * "已处理 14 秒 · 4 个工具 · 4 段思考"; with reasoning only "已思考 14 秒", with
 * tools only "已使用 4 个工具", and the failures counted at the end.
 */
export function describeSettled(counts: StepSummary, spanMs?: number): string {
  const tools = counts.tools + counts.tasks;
  const span = formatSpanZh(spanMs);
  let text: string;
  if (tools > 0 && counts.thinking > 0) {
    text = `已处理${span ? ` ${span}` : ''} · ${tools} 个工具 · ${counts.thinking} 段思考`;
  } else if (tools > 0) {
    text = `已使用 ${tools} 个工具`;
  } else if (counts.thinking > 0) {
    text = `已思考${span ? ` ${span}` : ''}`;
  } else if (counts.commentary > 0) {
    text = `${counts.commentary} 条过程说明`;
  } else {
    text = '已处理';
  }
  return counts.failed > 0 ? `${text} · ${counts.failed} 个失败` : text;
}

/** The one-line summary of the steps of a finished run. */
export function summarizeSettled(
  steps: readonly StreamingStep[],
  durationMs?: number,
): string {
  const listed = summarizedSteps(steps);
  return describeSettled(
    summarizeSteps(listed),
    processSpanMs(listed, durationMs),
  );
}

// ── what a call was given ───────────────────────────────────────────────

const SUMMARY_KEYS =
  'command|query|path|file_path|notebook_path|pattern|prompt|url|name';
const KEYED_SUMMARY = new RegExp(`^(?:${SUMMARY_KEYS}): ([\\s\\S]+)$`);
const JSON_SUMMARY = new RegExp(
  `^\\{\\s*"(?:${SUMMARY_KEYS})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`,
);

/**
 * What a call was given, without the label the runner put in front of it:
 * "command: npm test" is `npm test`, `{"file_path":"/a/b.ts"}` is `/a/b.ts`.
 */
export function cleanToolSummary(
  summary: string | undefined,
): string | undefined {
  const text = summary?.trim();
  if (!text) return undefined;
  const keyed = KEYED_SUMMARY.exec(text);
  if (keyed) return keyed[1];
  const json = JSON_SUMMARY.exec(text);
  if (json) {
    try {
      return JSON.parse(`"${json[1]}"`) as string;
    } catch {
      // A summary cut short in the middle of an escape.
      return json[1];
    }
  }
  return text;
}

/** A call in a few words: its verb and, if it was given one, its object. */
export function describeStepCall(step: StreamingStep): {
  verb: string;
  param?: string;
} {
  return describeToolCall(
    step.toolName ?? 'unknown',
    cleanToolSummary(step.summary),
    step.skillName,
  );
}
